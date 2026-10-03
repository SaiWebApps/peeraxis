// Cards whose result is not a code change: a report (work done for real, written up and reviewed by
// another model family) or a choice (visual options the owner picks from). Nothing lands in git.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { CardRow } from "./db.ts";
import type { Plugin } from "./plugin.ts";
import type { Engine } from "./engine.ts";
import { baseOf, makeCopy, removeCopy } from "./git.ts";
import { runStage } from "./proc.ts";
import { pluginFolders } from "./agents.ts";
import * as jobs from "./jobs.ts";

const TRIES = 2;

/** Work may happen anywhere in the copy and the card's output folder, never elsewhere in Peeraxis's data. */
function workPolicy(copy: string, out: string, dataDir: string): CanUseTool {
  return async (tool, input) => {
    const text = JSON.stringify(input);
    const touchesData = text.includes(dataDir) && !text.split(dataDir).slice(1).every((rest) => (dataDir + rest).startsWith(out));
    if (touchesData) return { behavior: "deny", message: "That location is off limits." };
    if (tool === "Bash" && /\bgit\s+(push|remote|fetch|clone)/.test(String(input.command ?? ""))) {
      return { behavior: "deny", message: "No git network commands." };
    }
    const raw = String(input.file_path ?? input.path ?? "");
    if (raw && ["Edit", "Write", "MultiEdit"].includes(tool)) {
      const path = resolve(copy, raw);
      if (relative(copy, path).startsWith("..") && relative(out, path).startsWith("..")) {
        return { behavior: "deny", message: "Write only inside the project copy or the output folder." };
      }
    }
    return { behavior: "allow", updatedInput: input };
  };
}

export async function runArtifact(engine: Engine, row: CardRow, plugin: Plugin): Promise<void> {
  const { store } = engine.deps;
  if (store.getCard(row.id).state === "approved") store.move(row.id, "building", { kind: row.card.kind });
  const out = engine.cardDir(row.id, "evidence", row.card.kind!);
  const facts: string[] = [];
  let reviewUsed = false;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    const { sha } = baseOf(row.project, plugin.mainBranch);
    const live = row.card.kind === "report" ? (plugin.live?.copyIn ?? []) : [];
    const copy = makeCopy(row.project, sha, [...plugin.copyIn, ...live]);
    try {
      const setup = await runStage({ command: plugin.setup, cwd: copy, timeoutMs: plugin.minutes.setup * 60_000 });
      if (!setup.ok) throw new Error(`setup failed: ${setup.tail.split("\n").at(-1)}`);
      const builder = engine.choose(row.id, "builder");
      const prompt = row.card.kind === "report"
        ? jobs.reportPrompt(row.card, out, plugin.live?.notes, facts)
        : jobs.choicePrompt(row.card, out, plugin.notes);
      const done = await engine.ask(row.id, "builder", builder, {
        cwd: copy, write: true, minutes: plugin.minutes.build, prompt,
        canUseTool: workPolicy(copy, out, engine.deps.dataDir), plugins: pluginFolders(plugin.skills),
      });
      if (done.limitUntil) { attempt--; continue; }
      if (!done.ok) { facts.push(`The work stopped without finishing (${done.error ?? "no reason given"}).`); continue; }
      const problem = row.card.kind === "report" ? await checkReport(engine, row, out, builder.family) : await shootOptions(out);
      if (problem === "retry-review") { attempt--; continue; }
      if (problem) {
        if (problem.startsWith("Reviewer:") && reviewUsed) { store.event(row.id, "review.notes", { notes: [problem] }); }
        else {
          if (problem.startsWith("Reviewer:")) { reviewUsed = true; attempt--; }
          facts.push(problem);
          store.event(row.id, "attempt.failed", { attempt, fact: problem });
          continue;
        }
      }
      store.move(row.id, "waiting", { kind: row.card.kind, evidence: out, builder: builder.id });
      return;
    } finally {
      removeCopy(copy);
    }
  }
  throw new ArtifactFailed(row.card.kind === "report" ? "Two tries to do this and write the report failed." : "Two tries to make the options failed.", facts.join("\n"));
}

export class ArtifactFailed extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(message);
    this.detail = detail;
  }
}

async function checkReport(engine: Engine, row: CardRow, out: string, builderFamily: "claude" | "codex"): Promise<string | null> {
  const file = join(out, "report.md");
  if (!existsSync(file) || readFileSync(file, "utf8").trim().length < 200) return "No report was written to report.md.";
  const reviewer = engine.choose(row.id, "reviewer", builderFamily);
  const shots = readdirSync(out).filter((f) => f.endsWith(".png")).slice(0, 6).map((f) => join(out, f));
  const result = await engine.ask(row.id, "reviewer", reviewer, {
    cwd: out, write: false, minutes: 15, schema: jobs.REVIEW_SCHEMA, images: shots,
    prompt: jobs.reportReviewPrompt(row.card, readFileSync(file, "utf8")),
  });
  if (result.limitUntil) return "retry-review";
  const verdict = result.json as { verdict: string; findings: { blocking: boolean; text: string }[] } | undefined;
  engine.deps.store.event(row.id, "review.done", { verdict: verdict?.verdict, findings: verdict?.findings });
  const blocking = verdict?.verdict === "fix" ? verdict.findings.filter((f) => f.blocking).map((f) => f.text) : [];
  return blocking.length ? `Reviewer: ${blocking.join(" ")}` : null;
}

/** Screenshots each option page so the owner can compare them at a glance. */
async function shootOptions(out: string): Promise<string | null> {
  const pages = [1, 2, 3].map((n) => join(out, `option-${n}.html`));
  const missing = pages.filter((p) => !existsSync(p));
  if (missing.length) return `Missing options: ${missing.map((p) => p.split("/").at(-1)).join(", ")}.`;
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    for (const [i, file] of pages.entries()) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
      await page.goto(`file://${file}`, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => page.goto(`file://${file}`));
      await page.screenshot({ path: join(out, `option-${i + 1}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  for (const n of [1, 2, 3]) {
    const txt = join(out, `option-${n}.txt`);
    if (!existsSync(txt)) writeFileSync(txt, `Option ${n}`);
  }
  return null;
}

/** The look the owner picked in an earlier choice card of the same plan, if any: its page and screenshot. */
export function chosenDirection(engine: Engine, row: CardRow): { html: string; png: string; name: string } | null {
  if (!row.parent) return null;
  for (const sibling of engine.deps.store.children(row.parent)) {
    if (sibling.card.kind !== "choice" || sibling.state !== "accepted") continue;
    const picked = [...engine.deps.store.events(sibling.id)].reverse().find((e) => e.kind === "card.accepted")?.data.choice;
    if (!picked) continue;
    const dir = join(engine.deps.dataDir, "cards", sibling.id, "evidence", "choice");
    const html = join(dir, `option-${picked}.html`);
    if (!existsSync(html)) continue;
    const name = existsSync(join(dir, `option-${picked}.txt`)) ? readFileSync(join(dir, `option-${picked}.txt`), "utf8").trim() : `Option ${picked}`;
    return { html, png: join(dir, `option-${picked}.png`), name };
  }
  return null;
}
