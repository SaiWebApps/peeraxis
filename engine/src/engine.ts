// The loop. Code owns every transition: test → build → check → land, with caps, splits and
// parking. Models only fill in the work inside each phase.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { Store, CardRow, Card } from "./db.ts";
import { loadPlugin, type Plugin } from "./plugin.ts";
import { pick, type Family, type Limits, type ModelsConfig, type Role, type Model } from "./models.ts";
import type { AgentRunner, AgentResult } from "./agents.ts";
import { runStage, type StageResult } from "./proc.ts";
import { baseOf, changedPaths, commitAll, diff, git, landOnWaiting, litter, makeCopy, newLitter, outsideAllowed, removeCopy } from "./git.ts";
import * as jobs from "./jobs.ts";
import { syncWaiting } from "./sync.ts";
import { measure, worse, type Health } from "./health.ts";

export type Deps = { store: Store; dataDir: string; models: () => ModelsConfig; agent: AgentRunner };

/** Thrown when every allowed model for a job is out of usage; the engine sleeps until `until`. */
export class Wait extends Error {
  readonly until: number;
  constructor(until: number, reason: string) {
    super(reason);
    this.until = until;
  }
}

/** Thrown to park a card with the one sentence the owner will read. */
class Park extends Error {}

const TRIES = 2;

export class Engine {
  readonly limits: Limits = {};
  private readonly deps: Deps;
  constructor(deps: Deps) {
    this.deps = deps;
  }

  /** Works on the next card until it waits, parks, splits or lands. Returns false when idle. */
  async step(): Promise<boolean> {
    const row = this.deps.store.next();
    if (!row) return false;
    const plugin = loadPlugin(row.project);
    await syncWaiting(this.deps.store, row.project, plugin);
    const before = litter(row.project);
    try {
      if (row.state === "approved") this.deps.store.move(row.id, "testing");
      if (this.state(row.id) === "testing") await this.writeTest(row, plugin);
      await this.buildAndCheck(row, plugin);
    } catch (error) {
      if (error instanceof Wait) throw error;
      const sentence = error instanceof Park ? error.message : `The engine hit an unexpected error: ${(error as Error).message}`;
      this.deps.store.move(row.id, "parked", { sentence });
    } finally {
      const leftovers = newLitter(before, litter(row.project));
      if (leftovers.length) this.deps.store.event(row.id, "project.leftovers", { leftovers });
    }
    this.finishParents(row);
    return true;
  }

  private state(id: string) {
    return this.deps.store.getCard(id).state;
  }

  private cardDir(id: string, ...parts: string[]): string {
    const dir = join(this.deps.dataDir, "cards", id, ...parts);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private choose(card: string, role: Role, avoid?: Family): Model & { label?: string } {
    const choice = pick(this.deps.models(), role, this.limits, avoid);
    if (choice.kind === "wait") {
      this.deps.store.event(card, "limit.wait", { role, until: new Date(choice.until).toISOString(), reason: choice.reason });
      throw new Wait(choice.until, choice.reason);
    }
    if (choice.label) this.deps.store.event(card, "model.label", { role, label: choice.label });
    return { ...choice.model, label: choice.label };
  }

  private async ask(card: string, role: Role, model: Model, run: Omit<Parameters<AgentRunner>[0], "model">): Promise<AgentResult> {
    this.deps.store.event(card, "agent.started", { role, model: model.id });
    const result = await this.deps.agent({ ...run, model });
    if (result.limitUntil) {
      this.limits[model.id] = result.limitUntil;
      this.deps.store.event(card, "limit.hit", { role, model: model.id, until: new Date(result.limitUntil).toISOString() });
      const next = pick(this.deps.models(), role, this.limits);
      if (next.kind === "run") this.deps.store.event(card, "model.switched", { role, from: model.id, to: next.model.id });
    }
    this.deps.store.event(card, "agent.finished", { role, model: model.id, ok: result.ok, error: result.error });
    return result;
  }

  // ---- Hidden test -------------------------------------------------------------------------

  private testPath(row: CardRow, plugin: Plugin): string {
    const slug = row.card.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
    return plugin.testFile.replace("{name}", `${slug}-${row.id.slice(0, 8)}`);
  }

  private async writeTest(row: CardRow, plugin: Plugin): Promise<void> {
    const testFile = this.testPath(row, plugin);
    let feedback: string | undefined;
    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const builderFamily = this.choose(row.id, "builder").family;
      const author = this.choose(row.id, "testAuthor", builderFamily);
      const { sha } = baseOf(row.project, plugin.mainBranch);
      const copy = makeCopy(row.project, sha, plugin.copyIn);
      try {
        const result = await this.ask(row.id, "testAuthor", author, {
          cwd: copy, write: true, minutes: 20,
          prompt: jobs.testAuthorPrompt(row.card, testFile, plugin.testExample, feedback, plugin.notes),
        });
        if (result.limitUntil) { attempt--; continue; }
        const changed = changedPaths(copy, sha);
        if (!result.ok || changed.length !== 1 || changed[0] !== testFile) {
          feedback = `Write only ${testFile}; you changed: ${changed.join(", ") || "nothing"}.`;
          continue;
        }
        const source = readFileSync(join(copy, testFile), "utf8");
        const red = await this.runAcceptance(row, plugin, row.project, sha, source, testFile, `red-${attempt}`);
        if (red.ok) { feedback = "The test passes on the current code, so it does not check the new feature."; continue; }
        const checker = this.choose(row.id, "cardCheck", author.family);
        const check = await this.ask(row.id, "cardCheck", checker, {
          cwd: copy, write: false, minutes: 10, schema: jobs.CARD_CHECK_SCHEMA,
          prompt: jobs.cardCheckPrompt(row.card, source),
        });
        if (check.limitUntil) { attempt--; continue; }
        const verdict = check.json as { matches: boolean; problems: string[] } | undefined;
        if (!check.ok || !verdict) { feedback = "The test could not be checked against the card."; continue; }
        if (!verdict.matches) { feedback = verdict.problems.join(" "); continue; }
        const store = this.cardDir(row.id, "test");
        writeFileSync(join(store, "test.src"), source);
        this.deps.store.event(row.id, "test.ready", { testFile, author: author.id, hash: sha256(source) });
        this.deps.store.move(row.id, "building");
        return;
      } finally {
        removeCopy(copy);
      }
    }
    throw new Park(`Peeraxis could not write a fair test for this card: ${feedback}`);
  }

  private hiddenTest(row: CardRow): { source: string; testFile: string; author: string } {
    const ready = [...this.deps.store.events(row.id)].reverse().find((e) => e.kind === "test.ready");
    if (!ready) throw new Error("no hidden test recorded");
    const source = readFileSync(join(this.cardDir(row.id, "test"), "test.src"), "utf8");
    if (sha256(source) !== ready.data.hash) throw new Park("The hidden test changed after it was written, so the card was stopped.");
    return { source, testFile: String(ready.data.testFile), author: String(ready.data.author) };
  }

  /** Runs the hidden test with recording on a fresh copy at `sha`. Keeps only report, video and screenshots. */
  private async runAcceptance(row: CardRow, plugin: Plugin, repo: string, sha: string, source: string, testFile: string, label: string): Promise<StageResult> {
    const copy = makeCopy(repo, sha, plugin.copyIn);
    const out = this.cardDir(row.id, "evidence", label);
    try {
      const setup = await runStage({ command: plugin.setup, cwd: copy, timeoutMs: plugin.minutes.setup * 60_000 });
      if (!setup.ok) return { ...setup, tail: `Setup failed:\n${setup.tail}` };
      mkdirSync(dirname(join(copy, testFile)), { recursive: true });
      writeFileSync(join(copy, testFile), source);
      const result = await runStage({
        command: plugin.acceptance, cwd: copy, timeoutMs: plugin.minutes.acceptance * 60_000,
        env: { PEERAXIS_DEMO_SPEC: testFile, PEERAXIS_DEMO_OUTPUT: out },
      });
      keepEvidence(out);
      return result;
    } finally {
      removeCopy(copy);
    }
  }

  // ---- Build and check ---------------------------------------------------------------------

  private async buildAndCheck(row: CardRow, plugin: Plugin): Promise<void> {
    if (!["building", "checking"].includes(this.state(row.id))) return;
    if (this.state(row.id) === "checking") this.deps.store.move(row.id, "building", { reason: "resumed after a restart" });
    const test = this.hiddenTest(row);
    const allowed = row.card.allowedPaths ?? plugin.allowedPaths;
    const facts: string[] = [];
    let reviewUsed = false;
    const baseline = await this.baseline(row, plugin);

    for (let attempt = 1; attempt <= TRIES; attempt++) {
      const { sha: base, waitingTip } = baseOf(row.project, plugin.mainBranch);
      const builder = this.choose(row.id, "builder", this.familyOf(test.author));
      const copy = makeCopy(row.project, base, plugin.copyIn);
      try {
        const setup = await runStage({ command: plugin.setup, cwd: copy, timeoutMs: plugin.minutes.setup * 60_000 });
        if (!setup.ok) throw new Park(`Setting up the project failed: ${lastLine(setup.tail)}`);
        const built = await this.ask(row.id, "builder", builder, {
          cwd: copy, write: true, minutes: plugin.minutes.build,
          prompt: jobs.builderPrompt(row.card, allowed, facts, plugin.notes),
          canUseTool: jobs.builderPolicy(copy, allowed, [this.deps.dataDir]),
        });
        if (built.limitUntil) { attempt--; continue; }
        const verdict = await this.verify(row, plugin, copy, base, allowed, test, baseline, built, attempt,
          `${row.card.title}\n\nBuilt by Peeraxis (${builder.id}).`);
        if ("fact" in verdict) { facts.push(verdict.fact); this.deps.store.event(row.id, "attempt.failed", { attempt, fact: verdict.fact }); continue; }
        const { candidate } = verdict;
        this.deps.store.move(row.id, "checking", { attempt, candidate });
        const findings = await this.review(row, copy, base, test, builder.family);
        if (findings.length) {
          if (reviewUsed) throw new Park(`The reviewer still found a problem after one fix: ${findings[0]}`);
          reviewUsed = true;
          facts.push(...findings.map((f) => `Reviewer: ${f}`));
          this.deps.store.move(row.id, "building", { reason: "review findings", findings });
          attempt--; // a review fix is not a failed try
          continue;
        }
        if (!landOnWaiting(row.project, copy, candidate, waitingTip)) {
          this.deps.store.move(row.id, "building", { reason: "the waiting branch moved; rebuilding on top of it" });
          attempt--;
          continue;
        }
        this.deps.store.move(row.id, "waiting", { sha: candidate, builder: builder.id, evidence: this.cardDir(row.id, "evidence") });
        return;
      } finally {
        removeCopy(copy);
      }
    }
    await this.splitOrPark(row, facts);
  }

  private familyOf(modelId: string): Family {
    return Object.values(this.deps.models().roles).flat().find((m) => m.id === modelId)?.family ?? (modelId.startsWith("claude") ? "claude" : "codex");
  }

  /** The project's own check must pass before any agent works on it. Measured once per card. */
  private async baseline(row: CardRow, plugin: Plugin): Promise<Health> {
    const { sha } = baseOf(row.project, plugin.mainBranch);
    const copy = makeCopy(row.project, sha, plugin.copyIn);
    try {
      const setup = await runStage({ command: plugin.setup, cwd: copy, timeoutMs: plugin.minutes.setup * 60_000 });
      const check = setup.ok ? await runStage({ command: plugin.check, cwd: copy, timeoutMs: plugin.minutes.check * 60_000 }) : setup;
      if (!check.ok) throw new Park(`The project's own check fails before any change, so nothing was built: ${lastLine(check.tail)}`);
      const health = await measure(copy, plugin, [], check.seconds);
      this.deps.store.event(row.id, "baseline.passed", { seconds: check.seconds });
      return health;
    } finally {
      removeCopy(copy);
    }
  }

  /** Commits the attempt and runs every gate. Returns one plain fact on failure, or the candidate commit. */
  private async verify(row: CardRow, plugin: Plugin, copy: string, base: string, allowed: string[],
    test: { source: string; testFile: string }, baseline: Health, built: AgentResult, attempt: number, message: string): Promise<{ fact: string } | { candidate: string }> {
    if (!built.ok) return { fact: `The builder stopped without finishing (${built.error ?? "no reason given"}).` };
    const changed = changedPaths(copy, base);
    if (!changed.length) return { fact: "The builder made no change." };
    const outside = outsideAllowed(changed, allowed);
    if (outside.length) return { fact: `Changed files outside what this card may change: ${outside.join(", ")}.` };
    const log = join(this.cardDir(row.id, "evidence"), `check-${attempt}.log`);
    const check = await runStage({ command: plugin.check, cwd: copy, timeoutMs: plugin.minutes.check * 60_000, logFile: log });
    if (!check.ok) return { fact: `The project check failed:\n${tailLines(check.tail)}` };
    const health = await measure(copy, plugin, changed, check.seconds);
    const before = { ...baseline, fileLines: Object.fromEntries(changed.map((f) => [f, lineCount(row.project, base, f)])) };
    const problems = worse(before, health, /dependenc|librar|package/i.test(jobs.cardText(row.card)));
    if (problems.length) return { fact: `Code health got worse: ${problems.join(" ")}` };
    const candidate = commitAll(copy, message);
    const proof = await this.runAcceptance(row, plugin, copy, candidate, test.source, test.testFile, `attempt-${attempt}`);
    if (!proof.ok) {
      git(copy, ["reset", "--quiet", "--soft", base]);
      return { fact: `The hidden acceptance test failed:\n${tailLines(proof.tail)}` };
    }
    // The feature passed its hidden test; from now on that test guards it like any other test.
    mkdirSync(dirname(join(copy, test.testFile)), { recursive: true });
    writeFileSync(join(copy, test.testFile), test.source);
    git(copy, ["add", "--", test.testFile]);
    git(copy, ["commit", "--quiet", "--no-verify", "--amend", "--no-edit"]);
    this.deps.store.event(row.id, "proof.passed", { attempt, checkSeconds: check.seconds, acceptanceSeconds: proof.seconds });
    return { candidate: git(copy, ["rev-parse", "HEAD"]) };
  }

  private async review(row: CardRow, copy: string, base: string, test: { testFile: string }, builderFamily: Family): Promise<string[]> {
    for (;;) {
      const reviewer = this.choose(row.id, "reviewer", builderFamily);
      const proof = "The project's full check passed. The hidden acceptance test passed with a recording.";
      const result = await this.ask(row.id, "reviewer", reviewer, {
        cwd: copy, write: false, minutes: 20, schema: jobs.REVIEW_SCHEMA,
        prompt: jobs.reviewPrompt(row.card, diff(copy, base, "HEAD"), proof),
      });
      if (result.limitUntil) continue;
      const verdict = result.json as { verdict: string; findings: { blocking: boolean; text: string }[] } | undefined;
      if (!result.ok || !verdict) throw new Park("The review could not be completed.");
      this.deps.store.event(row.id, "review.done", { verdict: verdict.verdict, findings: verdict.findings, testFile: test.testFile });
      return verdict.verdict === "fix" ? verdict.findings.filter((f) => f.blocking).map((f) => f.text) : [];
    }
  }

  private async splitOrPark(row: CardRow, failures: string[]): Promise<void> {
    const splitter = this.choose(row.id, "splitter");
    const result = await this.ask(row.id, "splitter", splitter, {
      cwd: row.project, write: false, minutes: 10, schema: jobs.SPLIT_SCHEMA,
      prompt: jobs.splitPrompt(row.card, failures),
    });
    const answer = result.json as { decision: string; sentence: string; cards: Card[] } | undefined;
    if (!result.ok || !answer || answer.decision !== "split" || answer.cards.length < 2) {
      throw new Park(answer?.sentence || `Two tries failed: ${lastLine(failures.at(-1) ?? "")}`);
    }
    for (const card of answer.cards.slice(0, 4)) {
      this.deps.store.approve(row.project, { ...card, allowedPaths: row.card.allowedPaths }, row.id);
    }
    this.deps.store.move(row.id, "split", { sentence: answer.sentence, children: answer.cards.map((c) => c.title) });
  }

  /** A split card is waiting once all its children are; parked if any child parked. */
  private finishParents(row: CardRow): void {
    const parentId = this.deps.store.getCard(row.id).parent;
    if (!parentId || this.state(parentId) !== "split") return;
    const children = this.deps.store.children(parentId);
    if (children.some((c) => c.state === "parked")) this.deps.store.move(parentId, "parked", { sentence: "A smaller part of this card could not be finished." });
    else if (children.every((c) => c.state === "waiting")) this.deps.store.move(parentId, "waiting", { children: children.map((c) => c.id) });
  }
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function lastLine(text: string): string {
  return text.trim().split("\n").filter(Boolean).at(-1) ?? "no details";
}

function tailLines(text: string): string {
  return text.split("\n").slice(-25).join("\n");
}

function lineCount(root: string, sha: string, file: string): number {
  try { return git(root, ["show", `${sha}:${file}`]).split("\n").length; } catch { return 0; }
}

/** Keeps only report.json, recordings and screenshots from an acceptance run. */
function keepEvidence(dir: string): void {
  for (const entry of readdirSync(dir, { recursive: true }) as string[]) {
    const path = join(dir, entry);
    if (!existsSync(path) || statSync(path).isDirectory()) continue;
    if (!/(^|\/)report\.json$|\.webm$|\.png$/.test(entry)) rmSync(path);
  }
}

