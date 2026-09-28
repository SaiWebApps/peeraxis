// A tiny git project with a plug-in, and scripted fake agents. A safety net only: M1 counts
// as done after a real run with real models on Persuaider.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Store } from "../src/db.ts";
import { Engine } from "../src/engine.ts";
import { DEFAULT_MODELS, type ModelsConfig } from "../src/models.ts";
import type { AgentResult, AgentRun } from "../src/agents.ts";

export const CARD = {
  title: "Greeting says hello",
  before: "The greeting says hi.",
  after: "The greeting says hello.",
  watch: ["Call the greeting and see hello"],
  notIncluded: ["Translations"],
};

export function project(): string {
  const root = mkdtempSync(join(tmpdir(), "px-fixture-"));
  const files: Record<string, string> = {
    "app.js": 'export const greet = () => "hi";\n',
    "tests/unit.test.js": 'import { test } from "node:test";\ntest("ok", () => {});\n',
    "check.sh": "node --test tests/ >/dev/null\n",
    "acceptance.sh": 'node --test "$PEERAXIS_DEMO_SPEC" && echo "{\\"ok\\":true}" > "$PEERAXIS_DEMO_OUTPUT/report.json"\n',
    ".peeraxis/project.json": JSON.stringify({
      setup: "true",
      check: "sh check.sh",
      acceptance: "sh acceptance.sh",
      testFile: "accept/{name}.test.js",
      allowedPaths: ["app.js", "tests/**"],
      minutes: { setup: 1, check: 1, acceptance: 1, build: 1 },
    }),
  };
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Owner");
  git("config", "user.email", "owner@example.com");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  return root;
}

export type Script = Partial<Record<"testAuthor" | "cardCheck" | "builder" | "reviewer" | "splitter", (run: AgentRun, call: number) => AgentResult | Promise<AgentResult>>>;

export const GOOD_TEST = 'import { test } from "node:test";\nimport assert from "node:assert";\nimport { greet } from "../app.js";\ntest("Call the greeting and see hello", () => assert.equal(greet(), "hello"));\n';

export const DEFAULT_SCRIPT: Required<Script> = {
  testAuthor: (run) => {
    const file = /Write exactly one test file at (\S+)\./.exec(run.prompt)![1];
    mkdirSync(dirname(join(run.cwd, file)), { recursive: true });
    writeFileSync(join(run.cwd, file), GOOD_TEST);
    return { ok: true, text: "checks hello" };
  },
  cardCheck: () => ({ ok: true, text: "", json: { matches: true, problems: [] } }),
  builder: (run) => {
    writeFileSync(join(run.cwd, "app.js"), 'export const greet = () => "hello";\n');
    return { ok: true, text: "done" };
  },
  reviewer: () => ({ ok: true, text: "", json: { verdict: "pass", findings: [] } }),
  splitter: () => ({ ok: true, text: "", json: { decision: "park", sentence: "Parked by the splitter.", cards: [] } }),
};

export function roleOf(prompt: string): keyof Script {
  if (prompt.startsWith("You write the acceptance test")) return "testAuthor";
  if (prompt.startsWith("Check whether this acceptance test")) return "cardCheck";
  if (prompt.startsWith("Build this feature")) return "builder";
  if (prompt.startsWith("Review this change")) return "reviewer";
  return "splitter";
}

export function setup(script: Script = {}, models: ModelsConfig = DEFAULT_MODELS) {
  const root = project();
  const dataDir = mkdtempSync(join(tmpdir(), "px-data-"));
  const store = new Store(join(dataDir, "db.sqlite"));
  const calls: { role: string; model: string; run: AgentRun }[] = [];
  const counts: Record<string, number> = {};
  const engine = new Engine({
    store,
    dataDir,
    models: () => models,
    agent: async (run) => {
      const role = roleOf(run.prompt);
      counts[role] = (counts[role] ?? 0) + 1;
      calls.push({ role, model: run.model.id, run });
      return (script[role] ?? DEFAULT_SCRIPT[role])(run, counts[role]);
    },
  });
  return { root, dataDir, store, engine, calls, exists: (p: string) => existsSync(join(root, p)) };
}
