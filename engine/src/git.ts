// Git operations: isolated build copies, changed-path checks, leftover detection, and
// compare-and-swap landing onto the waiting branch. Never touches the owner's working tree.
import { execFileSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, rmSync, existsSync, realpathSync } from "node:fs";
import { dirname, join, matchesGlob, relative, resolve } from "node:path";
import { stageTmp } from "./proc.ts";

export const WAITING = "peeraxis/waiting";

export function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    input,
    encoding: "utf8",
    maxBuffer: 256 << 20,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function tryGit(cwd: string, args: string[]): string | null {
  try { return git(cwd, args); } catch { return null; }
}

/** The commit new work builds on: the waiting branch if it exists, else the main branch. */
export function baseOf(root: string, mainBranch: string): { sha: string; waitingTip: string | null } {
  const waitingTip = tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${WAITING}`]);
  return { sha: waitingTip ?? git(root, ["rev-parse", "--verify", `refs/heads/${mainBranch}`]), waitingTip };
}

/** A throwaway clone of the project at `sha`, with no remote and the plug-in's dev files copied in. */
export function makeCopy(root: string, sha: string, copyIn: string[] = []): string {
  const dir = join(stageTmp(), "project");
  git(dirname(dir), ["clone", "--quiet", "--no-local", "--no-checkout", root, dir]);
  git(dir, ["checkout", "--quiet", "--detach", sha]);
  git(dir, ["remote", "remove", "origin"]);
  git(dir, ["config", "user.name", "Peeraxis"]);
  git(dir, ["config", "user.email", "peeraxis@localhost"]);
  for (const file of copyIn) copyInFile(root, dir, file);
  return dir;
}

function copyInFile(root: string, dir: string, file: string): void {
  const from = resolve(root, file);
  const to = resolve(dir, file);
  if (!from.startsWith(realpathSync(root) + "/") && !from.startsWith(root + "/")) throw new Error(`copyIn ${file} is outside the project`);
  if (!existsSync(from)) throw new Error(`copyIn ${file} does not exist`);
  if (lstatSync(from).isSymbolicLink()) throw new Error(`copyIn ${file} is a symlink; refusing`);
  if (existsSync(to) && lstatSync(to).isSymbolicLink()) throw new Error(`copyIn destination ${file} is a symlink; refusing`);
  mkdirSync(dirname(to), { recursive: true });
  cpSync(from, to, { dereference: false });
  const exclude = join(dir, ".git", "info", "exclude");
  git(dir, ["config", "core.excludesFile", exclude]);
  execFileSync("/bin/sh", ["-c", `printf '%s\\n' "$1" >> "$2"`, "sh", `/${file}`, exclude]);
}

export function removeCopy(dir: string): void {
  rmSync(dirname(dir), { recursive: true, force: true });
}

/** Every path changed since `base`, including new files, as repo-relative paths. */
export function changedPaths(dir: string, base: string): string[] {
  git(dir, ["add", "-A"]);
  const out = git(dir, ["diff", "--cached", "--name-only", "--no-renames", base]);
  return out ? out.split("\n") : [];
}

export function outsideAllowed(paths: string[], allowed: string[]): string[] {
  return paths.filter((p) => !allowed.some((glob) => matchesGlob(p, glob)));
}

export function commitAll(dir: string, message: string): string {
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "--quiet", "--no-verify", "-m", message]);
  return git(dir, ["rev-parse", "HEAD"]);
}

export function diff(dir: string, base: string, head = "HEAD"): string {
  return git(dir, ["diff", "--no-color", base, head]);
}

/**
 * Moves the waiting branch to `sha` only if it still points where the build started.
 * Returns false (and changes nothing) if someone moved it meanwhile.
 */
export function landOnWaiting(root: string, copy: string, sha: string, expectedTip: string | null): boolean {
  const ref = `refs/peeraxis/landing/${sha}`;
  git(root, ["fetch", "--quiet", "--no-tags", copy, `${sha}:${ref}`]);
  try {
    const expected = expectedTip ?? "0".repeat(40);
    return tryGit(root, ["update-ref", `refs/heads/${WAITING}`, sha, expected]) !== null;
  } finally {
    tryGit(root, ["update-ref", "-d", ref]);
  }
}

export type Litter = { branches: string[]; stashes: string[]; worktrees: string[]; untracked: string[] };

export function litter(root: string): Litter {
  const lines = (out: string | null) => (out ? out.split("\n").filter(Boolean) : []);
  return {
    branches: lines(tryGit(root, ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/tags"])),
    stashes: lines(tryGit(root, ["stash", "list", "--format=%H"])),
    worktrees: lines(tryGit(root, ["worktree", "list", "--porcelain"])).filter((l) => l.startsWith("worktree ")),
    untracked: lines(tryGit(root, ["ls-files", "--others", "--exclude-standard"])),
  };
}

/** What appeared in the owner's project between two snapshots, named plainly. */
export function newLitter(before: Litter, after: Litter): string[] {
  const added = (key: keyof Litter) => after[key].filter((x) => !before[key].includes(x));
  return [
    ...added("branches").filter((b) => b !== `refs/heads/${WAITING}`).map((b) => `new branch or tag ${b}`),
    ...added("stashes").map(() => "new stash"),
    ...added("worktrees").map((w) => `new ${w}`),
    ...added("untracked").map((f) => `new file ${f}`),
  ];
}

export function relativeTo(root: string, path: string): string {
  return relative(root, path);
}
