// Code-health numbers. A feature may not make them worse; the owner never reads code,
// so these numbers read it for them.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runStage } from "./proc.ts";
import type { Plugin } from "./plugin.ts";

export type Health = { warnings: number | null; dependencies: number; checkSeconds: number; fileLines: Record<string, number> };

const BIG_FILE = 400;

export async function measure(copy: string, plugin: Plugin, files: string[], checkSeconds: number): Promise<Health> {
  let warnings: number | null = null;
  if (plugin.health) {
    const result = await runStage({ command: plugin.health, cwd: copy, timeoutMs: plugin.minutes.check * 60_000 });
    try {
      const parsed = JSON.parse(result.tail.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? "");
      if (typeof parsed.warnings === "number") warnings = parsed.warnings;
    } catch { /* no number reported */ }
  }
  const fileLines: Record<string, number> = {};
  for (const file of files) {
    const path = join(copy, file);
    fileLines[file] = existsSync(path) ? readFileSync(path, "utf8").split("\n").length : 0;
  }
  return { warnings, dependencies: dependencyCount(copy), checkSeconds, fileLines };
}

function dependencyCount(copy: string): number {
  const file = join(copy, "package.json");
  if (!existsSync(file)) return 0;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  return Object.keys(pkg.dependencies ?? {}).length + Object.keys(pkg.devDependencies ?? {}).length;
}

/** Plain sentences for every way `after` is worse than `before`; empty means healthy. */
export function worse(before: Health, after: Health, allowNewDependencies: boolean): string[] {
  const problems: string[] = [];
  if (before.warnings !== null && after.warnings !== null && after.warnings > before.warnings) {
    problems.push(`Lint warnings went from ${before.warnings} to ${after.warnings}.`);
  }
  if (!allowNewDependencies && after.dependencies > before.dependencies) {
    problems.push(`Dependencies went from ${before.dependencies} to ${after.dependencies}; the card does not need new ones.`);
  }
  if (after.checkSeconds > before.checkSeconds * 1.5 + 30) {
    problems.push(`The project check slowed from ${Math.round(before.checkSeconds)}s to ${Math.round(after.checkSeconds)}s.`);
  }
  for (const [file, lines] of Object.entries(after.fileLines)) {
    const was = before.fileLines[file] ?? 0;
    if (lines > BIG_FILE && lines > was) problems.push(`${file} grew to ${lines} lines; keep files under ${BIG_FILE}.`);
  }
  return problems;
}
