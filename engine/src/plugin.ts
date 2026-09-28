// The only project-specific part: .peeraxis/project.json in the project.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Plugin = {
  setup: string; // prepares a fresh copy, e.g. "npm ci"
  check: string; // the project's full gate; must pass before and after a build
  acceptance: string; // runs one hidden test with recording: gets PEERAXIS_DEMO_SPEC and PEERAXIS_DEMO_OUTPUT
  health?: string; // optional: prints JSON like {"warnings": 3}
  testFile: string; // where a hidden test goes in a copy; {name} is replaced, e.g. "e2e/peeraxis/{name}.spec.ts"
  testExample?: string; // an existing test the test author should imitate
  allowedPaths: string[]; // globs the builder may change
  copyIn: string[]; // untracked dev files copied into every copy, e.g. ".env.peeraxis"
  mainBranch: string;
  minutes: { setup: number; check: number; acceptance: number; build: number };
};

const KNOWN = new Set(["setup", "check", "acceptance", "health", "testFile", "testExample", "allowedPaths", "copyIn", "mainBranch", "minutes"]);

export function loadPlugin(root: string): Plugin {
  const file = join(root, ".peeraxis", "project.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`This project has no readable .peeraxis/project.json (${(error as Error).message}).`);
  }
  const unknown = Object.keys(raw).filter((k) => !KNOWN.has(k));
  if (unknown.length) throw new Error(`project.json has unknown fields: ${unknown.join(", ")}`);
  for (const key of ["setup", "check", "acceptance", "testFile"]) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) throw new Error(`project.json needs "${key}"`);
  }
  if (!(raw.testFile as string).includes("{name}")) throw new Error('project.json "testFile" needs {name}');
  if (!Array.isArray(raw.allowedPaths) || raw.allowedPaths.length === 0) throw new Error('project.json needs "allowedPaths"');
  const minutes = (raw.minutes ?? {}) as Partial<Plugin["minutes"]>;
  return {
    setup: raw.setup as string,
    check: raw.check as string,
    acceptance: raw.acceptance as string,
    health: raw.health as string | undefined,
    testFile: raw.testFile as string,
    testExample: raw.testExample as string | undefined,
    allowedPaths: raw.allowedPaths as string[],
    copyIn: (raw.copyIn as string[] | undefined) ?? [],
    mainBranch: (raw.mainBranch as string | undefined) ?? "main",
    minutes: { setup: 15, check: 20, acceptance: 20, build: 60, ...minutes },
  };
}
