import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CARD, DEFAULT_SCRIPT, setup } from "./fixture.ts";
import { WAITING } from "../src/git.ts";
import { Engine, Wait } from "../src/engine.ts";
import { DEFAULT_MODELS } from "../src/models.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const kinds = (s: ReturnType<typeof setup>, id: string) => s.store.events(id).map((e) => e.kind);

test("a card goes from approved to the waiting branch; main and the working tree are untouched", async () => {
  const s = setup();
  const id = s.store.approve(s.root, CARD);
  const mainBefore = git(s.root, "rev-parse", "main");
  await s.engine.step();
  assert.equal(s.store.getCard(id).state, "waiting");
  assert.equal(git(s.root, "rev-parse", "main"), mainBefore);
  assert.equal(readFileSync(join(s.root, "app.js"), "utf8"), 'export const greet = () => "hi";\n');
  assert.match(git(s.root, "show", `${WAITING}:app.js`), /hello/);
  assert.match(git(s.root, "ls-tree", "-r", "--name-only", WAITING), /accept\/greeting-says-hello-/);
  assert.equal(git(s.root, "status", "--porcelain"), "");
  for (const kind of ["card.testing", "test.ready", "baseline.passed", "card.building", "proof.passed", "card.checking", "review.done", "card.waiting"]) {
    assert.ok(kinds(s, id).includes(kind), `missing event ${kind}`);
  }
});

test("the builder never sees the hidden test and is denied the engine's data folder", async () => {
  const s = setup({
    builder: async (run, call) => {
      assert.equal(existsSync(join(run.cwd, "accept")), false, "hidden test visible to builder");
      const denied = await run.canUseTool!("Read", { file_path: join(s.dataDir, "cards") }, { signal: new AbortController().signal } as never);
      assert.equal(denied?.behavior, "deny");
      const outside = await run.canUseTool!("Write", { file_path: join(run.cwd, "README.md"), content: "x" }, { signal: new AbortController().signal } as never);
      assert.equal(outside?.behavior, "deny");
      return DEFAULT_SCRIPT.builder(run, call);
    },
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  assert.equal(s.store.getCard(id).state, "waiting");
});

test("a change outside the allowed paths fails the try and names the file; two failures park the card", async () => {
  const s = setup({
    builder: (run) => {
      writeFileSync(join(run.cwd, "app.js"), 'export const greet = () => "hello";\n');
      writeFileSync(join(run.cwd, "README.md"), "sneaky\n");
      return { ok: true, text: "done" };
    },
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  const failed = s.store.events(id).filter((e) => e.kind === "attempt.failed");
  assert.equal(failed.length, 2);
  assert.match(String(failed[0].data.fact), /README\.md/);
  assert.equal(s.store.getCard(id).state, "parked");
  assert.equal(s.calls.filter((c) => c.role === "builder").length, 2);
  assert.ok(kinds(s, id).includes("card.parked"));
});

test("the second try starts fresh and is told what went wrong the first time", async () => {
  const s = setup({
    builder: (run, call) => {
      if (call === 1) return { ok: true, text: "did nothing" };
      assert.match(run.prompt, /The builder made no change/);
      return DEFAULT_SCRIPT.builder(run, call);
    },
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  assert.equal(s.store.getCard(id).state, "waiting");
});

test("a hidden test that already passes is rewritten, then the card parks without any build", async () => {
  const s = setup({
    testAuthor: (run) => {
      const file = /Write exactly one test file at (\S+)\./.exec(run.prompt)![1];
      execFileSync("mkdir", ["-p", join(run.cwd, "accept")]);
      writeFileSync(join(run.cwd, file), 'import { test } from "node:test";\ntest("always", () => {});\n');
      return { ok: true, text: "" };
    },
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  assert.equal(s.calls.filter((c) => c.role === "testAuthor").length, 3);
  assert.match(s.calls[1].run.prompt, /passes on the current code/);
  assert.equal(s.calls.filter((c) => c.role === "builder").length, 0);
  assert.equal(s.store.getCard(id).state, "parked");
});

test("a mismatch found by the card check rewrites the test, never the card", async () => {
  const s = setup({
    cardCheck: (_run, call) => ({ ok: true, text: "", json: call === 1 ? { matches: false, problems: ["Step 1 is not checked."] } : { matches: true, problems: [] } }),
  });
  const id = s.store.approve(s.root, CARD);
  const hash = s.store.getCard(id).hash;
  await s.engine.step();
  assert.match(s.calls.filter((c) => c.role === "testAuthor")[1].run.prompt, /Step 1 is not checked/);
  assert.equal(s.store.getCard(id).hash, hash);
  assert.equal(s.store.getCard(id).state, "waiting");
});

test("a failing baseline check parks the card before any builder runs", async () => {
  const s = setup();
  writeFileSync(join(s.root, "tests/unit.test.js"), 'import { test } from "node:test";\ntest("broken", () => { throw new Error("red"); });\n');
  git(s.root, "commit", "-qam", "break the build");
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  assert.equal(s.store.getCard(id).state, "parked");
  assert.equal(s.calls.filter((c) => c.role === "builder").length, 0);
  const parked = s.store.events(id).find((e) => e.kind === "card.parked")!;
  assert.match(String(parked.data.sentence), /own check fails before any change/);
});

test("a blocking review finding goes back to the builder once, then the fix lands", async () => {
  const s = setup({
    reviewer: (_run, call) => ({ ok: true, text: "", json: call === 1 ? { verdict: "fix", findings: [{ blocking: true, text: "Greeting lacks punctuation." }] } : { verdict: "pass", findings: [] } }),
    builder: (run, call) => {
      if (call === 2) assert.match(run.prompt, /Reviewer: Greeting lacks punctuation/);
      return DEFAULT_SCRIPT.builder(run, call);
    },
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  assert.equal(s.store.getCard(id).state, "waiting");
  assert.equal(s.calls.filter((c) => c.role === "builder").length, 2);
});

test("every agent call names its model; the builder is Opus 5.5 and checkers are Codex", async () => {
  const s = setup();
  s.store.approve(s.root, CARD);
  await s.engine.step();
  const byRole = Object.fromEntries(s.calls.map((c) => [c.role, c.model]));
  assert.deepEqual(byRole, { testAuthor: "gpt-6-astra", cardCheck: "claude-fable-5-1", builder: "claude-opus-5-5", reviewer: "gpt-6-astra" });
});

test("a usage limit on Opus switches the build to the backup and records it", async () => {
  const s = setup({
    builder: (run, call) => (call === 1 ? { ok: false, text: "", limitUntil: Date.now() + 3_600_000 } : DEFAULT_SCRIPT.builder(run, call)),
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  assert.equal(s.store.getCard(id).state, "waiting");
  assert.deepEqual(s.calls.filter((c) => c.role === "builder").map((c) => c.model), ["claude-opus-5-5", "claude-fable-5-1"]);
  assert.ok(kinds(s, id).includes("limit.hit"));
  assert.ok(kinds(s, id).includes("model.switched"));
});

test("a card changed after approval is refused", () => {
  const s = setup();
  const id = s.store.approve(s.root, CARD);
  s.store.db.prepare("UPDATE cards SET card = ? WHERE id = ?").run(JSON.stringify({ ...CARD, after: "Something bigger." }), id);
  assert.throws(() => s.store.getCard(id), /changed after approval/);
});

test("one card at a time: the second approved card waits until the first is done", async () => {
  const s = setup();
  const first = s.store.approve(s.root, CARD);
  const second = s.store.approve(s.root, { ...CARD, title: "Second card" });
  await s.engine.step();
  assert.equal(s.store.getCard(first).state, "waiting");
  assert.equal(s.store.getCard(second).state, "approved");
});

test("a restarted engine resumes a card mid-build without rewriting its hidden test", async () => {
  const s = setup({ builder: () => { throw new Wait(Date.now() + 1000, "simulated stop"); } });
  const id = s.store.approve(s.root, CARD);
  await assert.rejects(s.engine.step());
  assert.equal(s.store.getCard(id).state, "building");
  const fresh = new Engine({
    store: s.store, dataDir: s.dataDir, models: () => DEFAULT_MODELS,
    agent: async (run) => (run.prompt.startsWith("Build") ? DEFAULT_SCRIPT.builder(run, 1) : run.prompt.startsWith("Review") ? DEFAULT_SCRIPT.reviewer(run, 1) : assert.fail("test rewritten")),
  });
  await fresh.step();
  assert.equal(s.store.getCard(id).state, "waiting");
});

test("after two failed tries the splitter can split the card into smaller approved cards", async () => {
  const s = setup({
    builder: (run, call) => (call <= 2 ? { ok: true, text: "nothing" } : DEFAULT_SCRIPT.builder(run, call)),
    splitter: () => ({ ok: true, text: "", json: { decision: "split", sentence: "Split in two.", cards: [
      { ...CARD, title: "Part one" }, { ...CARD, title: "Part two" },
    ] } }),
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  assert.equal(s.store.getCard(id).state, "split");
  const children = s.store.children(id);
  assert.deepEqual(children.map((c) => c.state), ["approved", "approved"]);
  await s.engine.step();
  await s.engine.step();
  // Part two's (identical, scripted) test already passes once part one landed, so it parks,
  // and a parent with a parked part parks too.
  assert.deepEqual(s.store.children(id).map((c) => c.state), ["waiting", "parked"]);
  assert.equal(s.store.getCard(id).state, "parked");
});

test("leftovers in the owner's project are named; only report, video and screenshots are kept as evidence", async () => {
  const s = setup({
    builder: (run, call) => {
      execFileSync("git", ["branch", "stray"], { cwd: s.root });
      return DEFAULT_SCRIPT.builder(run, call);
    },
  });
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  const leftovers = s.store.events(id).find((e) => e.kind === "project.leftovers");
  assert.deepEqual(leftovers?.data.leftovers, ["new branch or tag refs/heads/stray"]);
  const files = execFileSync("find", [join(s.dataDir, "cards", id, "evidence"), "-type", "f"], { encoding: "utf8" }).trim().split("\n");
  assert.ok(files.every((f) => /report\.json$|\.webm$|\.png$|check-\d+\.log$/.test(f)), files.join("\n"));
});

test("accept moves main forward to the feature and removes the empty waiting branch; reject takes it off", async () => {
  const { accept, reject } = await import("../src/verdict.ts");
  const s = setup();
  const id = s.store.approve(s.root, CARD);
  await s.engine.step();
  const sha = git(s.root, "rev-parse", WAITING);
  await accept(s.store, id);
  assert.equal(git(s.root, "rev-parse", "main"), sha);
  assert.match(readFileSync(join(s.root, "app.js"), "utf8"), /hello/);
  assert.equal(git(s.root, "branch", "--list", WAITING), "");
  assert.equal(s.store.getCard(id).state, "accepted");

  const t = setup();
  const other = t.store.approve(t.root, CARD);
  await t.engine.step();
  await reject(t.store, other, "Too quiet.");
  assert.equal(git(t.root, "rev-parse", WAITING), git(t.root, "rev-parse", "main"));
  assert.equal(t.store.getCard(other).state, "rejected");
});

test("the parts of a split card run before cards approved after it", async () => {
  const s = setup();
  const first = s.store.approve(s.root, CARD);
  await new Promise((r) => setTimeout(r, 5));
  const later = s.store.approve(s.root, { ...CARD, title: "Later card" });
  s.store.move(first, "testing");
  s.store.move(first, "building");
  s.store.move(first, "split");
  const part = s.store.approve(s.root, { ...CARD, title: "Part one" }, first);
  assert.equal(s.store.next()?.id, part);
  assert.ok(later);
});

test("when main moves while features wait, they are replayed on top and can still be accepted in order", async () => {
  const { accept } = await import("../src/verdict.ts");
  const s = setup();
  const first = s.store.approve(s.root, CARD);
  await s.engine.step();
  // The owner commits to main while the feature waits.
  writeFileSync(join(s.root, "tests/extra.test.js"), 'import { test } from "node:test";\ntest("extra", () => {});\n');
  git(s.root, "add", "-A");
  git(s.root, "commit", "-qm", "owner work");
  await assert.rejects(accept(s.store, "not-a-card"));
  await accept(s.store, first);
  assert.equal(s.store.getCard(first).state, "accepted");
  assert.match(git(s.root, "log", "--format=%s", "-2", "main"), /Greeting says hello\nowner work/);
});
