// Runs one stage command with a clean boundary: an allowlisted environment, its own temp
// dir outside home and the project, its own process group, and a hard time limit that also
// ends descendants that left the group (they are tracked by parentage while the stage runs).
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, createWriteStream, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { redact } from "./redact.ts";

export type StageResult = { ok: boolean; code: number | null; timedOut: boolean; seconds: number; tail: string };

export type Stage = {
  command: string; // run by /bin/sh -c
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  logFile?: string;
};

const PASS_THROUGH = ["HOME", "USER", "LOGNAME", "SHELL", "LANG", "LC_ALL", "LC_CTYPE"];
let loginPath: string | undefined;

/** The owner's login-shell PATH, so stages find node, pg_ctl, etc. like the owner's terminal does. */
export function ownerPath(): string {
  if (loginPath === undefined) {
    try {
      const out = execFileSync(process.env.SHELL || "/bin/zsh", ["-lc", 'printf "\\n%s" "$PATH"'], { encoding: "utf8", timeout: 15000 });
      loginPath = out.split("\n").pop() || process.env.PATH || "/usr/bin:/bin";
    } catch {
      loginPath = process.env.PATH || "/usr/bin:/bin";
    }
  }
  return loginPath;
}

export function stageEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = { PATH: ownerPath(), TERM: "dumb", CI: "1" };
  for (const name of PASS_THROUGH) if (process.env[name]) env[name] = process.env[name]!;
  return { ...env, ...extra };
}

/** A fresh temp dir that is outside the owner's home and outside any project. */
export function stageTmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "peeraxis-")));
  if (dir.startsWith(homedir() + "/")) throw new Error(`Temp dir ${dir} is inside home; refusing.`);
  return dir;
}

export function runStage(stage: Stage): Promise<StageResult> {
  const tmp = stageTmp();
  const started = Date.now();
  const lines: string[] = [];
  const log = stage.logFile ? createWriteStream(stage.logFile, { flags: "a" }) : null;
  const child = spawn("/bin/sh", ["-c", stage.command], {
    cwd: stage.cwd,
    env: stageEnv({ ...stage.env, TMPDIR: tmp }),
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const keep = (chunk: Buffer) => {
    log?.write(chunk);
    lines.push(...chunk.toString().split("\n"));
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  child.stdout.on("data", keep);
  child.stderr.on("data", keep);

  const seen = new Set<number>();
  const watch = setInterval(() => descendants(child.pid, seen), 250);
  return new Promise((resolve) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killStage(child.pid, seen);
    }, stage.timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      clearInterval(watch);
      killStage(child.pid, seen); // anything left behind, e.g. a server the stage started
      log?.end();
      rmSync(tmp, { recursive: true, force: true });
      resolve({
        ok: code === 0 && !timedOut,
        code,
        timedOut,
        seconds: (Date.now() - started) / 1000,
        tail: redact(lines.slice(-60).join("\n")).trim(),
      });
    });
  });
}

function parentMap(): Map<number, number> {
  const map = new Map<number, number>();
  try {
    for (const line of execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8" }).trim().split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      map.set(pid, ppid);
    }
  } catch { /* ps unavailable: fall back to the process group kill */ }
  return map;
}

/** Adds every current descendant of `root` to `seen`. */
function descendants(root: number | undefined, seen: Set<number>): void {
  if (!root) return;
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parentMap()) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  const queue = [root, ...seen];
  while (queue.length) {
    for (const kid of children.get(queue.pop()!) ?? []) {
      if (!seen.has(kid)) { seen.add(kid); queue.push(kid); }
    }
  }
}

/** Ends the stage's process group and every descendant seen while it ran. */
export function killStage(pid: number | undefined, seen: Set<number>): void {
  descendants(pid, seen);
  if (pid) {
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
  }
  // Only processes still parented by the stage (or orphaned from it) are ended, so a reused
  // process id that now belongs to something else is never signalled.
  const parents = parentMap();
  for (const found of seen) {
    const parent = parents.get(found);
    if (found === process.pid || parent === undefined) continue;
    if (parent === 1 || parent === pid || seen.has(parent)) {
      try { process.kill(found, "SIGKILL"); } catch { /* gone */ }
    }
  }
}
