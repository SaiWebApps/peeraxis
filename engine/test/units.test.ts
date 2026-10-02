import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runStage } from "../src/proc.ts";
import { redact } from "../src/redact.ts";
import { DEFAULT_MODELS, assertAllowed, pick, type ModelsConfig } from "../src/models.ts";
import { worse } from "../src/health.ts";

test("a hung stage is stopped at its time limit, including a child that left the group", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "px-"));
  const marker = join(cwd, "still-alive");
  const started = Date.now();
  const result = await runStage({
    cwd,
    timeoutMs: 1500,
    // The child escapes the process group with setsid-like `perl -e setpgrp`, then writes after 3s.
    command: `perl -e 'setpgrp(0,0); sleep 3; open(F, ">", "${marker}"); close F' & sleep 30`,
  });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 6000);
  await new Promise((r) => setTimeout(r, 3500));
  assert.equal(existsSync(marker), false, "escaped child survived");
});

test("stages get an allowlisted environment and a temp dir outside home", async () => {
  process.env.PEERAXIS_TEST_SECRET = "sk-ant-abcdefghijklmnopqrstuvwxyz";
  const cwd = mkdtempSync(join(tmpdir(), "px-"));
  const result = await runStage({ cwd, timeoutMs: 10_000, command: 'echo "secret=${PEERAXIS_TEST_SECRET:-none} tmp=$TMPDIR"' });
  delete process.env.PEERAXIS_TEST_SECRET;
  assert.match(result.tail, /secret=none/);
  const tmp = /tmp=(\S+)/.exec(result.tail)![1];
  assert.equal(tmp.startsWith(homedir() + "/"), false);
  assert.equal(existsSync(tmp), false, "stage temp dir not removed");
});

test("secrets are redacted", () => {
  // Fake secrets are assembled at run time so the repo's own secret scan never sees a literal.
  const fake = (...parts: string[]) => parts.join("");
  const text = redact(`key ${fake("sk-ant-", "api03-abcdefghijklmnop")} and CLERK_SECRET_KEY=${fake("sk_", "test_", "abcdefgh123")} and postgres://u:pw@host/db`);
  assert.doesNotMatch(text, /abcdefghijklmnop|sk_test_abcdefgh123|pw@/);
});

test("claude-opus-5 is refused everywhere, Opus 5.5 is allowed", () => {
  assert.throws(() => assertAllowed({ family: "claude", id: "claude-opus-5" }), /banned/);
  assert.throws(() => assertAllowed({ family: "claude", id: "claude-opus-5[1m]" }), /banned/);
  assert.throws(() => assertAllowed({ family: "claude", id: "opus" }), /banned/);
  assert.doesNotThrow(() => assertAllowed({ family: "claude", id: "claude-opus-5-5" }));
});

const soon = Date.now() + 3_600_000;

test("limit scenario: Opus out → Fable builds, Codex still checks", () => {
  const limits = { "claude-opus-5-5": soon };
  assert.deepEqual(pick(DEFAULT_MODELS, "builder", limits, "codex"), { kind: "run", model: { family: "claude", id: "claude-fable-5-1" } });
  assert.equal((pick(DEFAULT_MODELS, "reviewer", limits, "claude") as { model: { id: string } }).model.id, "gpt-6-astra");
});

test("limit scenario: all Claude out → Sol builds only if the test was not written by Codex; checks wait", () => {
  const limits = { claude: soon };
  assert.equal(pick(DEFAULT_MODELS, "builder", limits, "codex").kind, "wait");
  assert.equal((pick(DEFAULT_MODELS, "builder", limits) as { model: { id: string } }).model.id, "gpt-6-sol");
  assert.equal(pick(DEFAULT_MODELS, "reviewer", limits, "codex").kind, "wait");
});

test("limit scenario: Codex out → Claude builds; tests and reviews wait", () => {
  const limits = { codex: soon };
  assert.equal(pick(DEFAULT_MODELS, "builder", limits, "codex").kind, "run");
  assert.equal(pick(DEFAULT_MODELS, "reviewer", limits, "claude").kind, "wait");
  assert.equal(pick(DEFAULT_MODELS, "testAuthor", limits, "claude").kind, "wait");
});

test("limit scenario: both out → everything waits until the earliest reset", () => {
  const limits = { codex: soon, claude: soon + 1000 };
  const choice = pick(DEFAULT_MODELS, "builder", limits);
  assert.equal(choice.kind, "wait");
  assert.equal((choice as { until: number }).until, soon);
});

test("a same-family check runs only when allowed, and is labelled", () => {
  const allowed: ModelsConfig = { ...DEFAULT_MODELS, allowSameFamilyChecks: true };
  const limits = { codex: soon };
  const choice = pick(allowed, "reviewer", limits, "claude");
  assert.equal(choice.kind, "run");
  assert.match((choice as { label: string }).label, /same family/);
});

test("code health: more warnings, new dependencies, big files and a slower check are worse", () => {
  const before = { warnings: 2, dependencies: 10, checkSeconds: 60, fileLines: { "a.ts": 380 } };
  assert.deepEqual(worse(before, { ...before }, false), []);
  const after = { warnings: 3, dependencies: 11, checkSeconds: 200, fileLines: { "a.ts": 420 } };
  assert.equal(worse(before, after, false).length, 4);
  assert.equal(worse(before, after, true).length, 3);
});

test("a stale engine lock naming an unrelated process does not stop the engine starting", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const home = mkdtempSync(join(tmpdir(), "px-home-"));
  writeFileSync(join(home, "engine.pid"), String(process.ppid || 1)); // alive, but not an engine
  const main = join(import.meta.dirname, "../src/main.ts");
  // `status` would not touch the lock; start `run` briefly and look for the started event.
  let err = "";
  try {
    execFileSync(process.execPath, [main, "run"], { env: { ...process.env, PEERAXIS_HOME: home }, timeout: 5000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    err = String((error as { stderr?: Buffer }).stderr ?? "");
  }
  assert.doesNotMatch(err, /already running/);
  const { Store } = await import("../src/db.ts");
  const kinds = new Store(join(home, "peeraxis.sqlite")).db.prepare("SELECT kind FROM events").all() as { kind: string }[];
  assert.ok(kinds.some((k) => k.kind === "engine.started"));
});
