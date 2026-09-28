// Keeps the waiting branch on top of main. If the owner (or anyone) commits to main while
// features wait, the waiting features are replayed onto the new main, re-checked, and moved
// only if that all succeeds. Their cards learn their new commits.
import type { Store } from "./db.ts";
import { WAITING, git, makeCopy, removeCopy, tryGit } from "./git.ts";
import { runStage } from "./proc.ts";
import type { Plugin } from "./plugin.ts";

export async function syncWaiting(store: Store, root: string, plugin: Plugin): Promise<void> {
  const tip = tryGit(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${WAITING}`]);
  if (!tip) return;
  const main = git(root, ["rev-parse", `refs/heads/${plugin.mainBranch}`]);
  if (tryGit(root, ["merge-base", "--is-ancestor", main, tip]) !== null) return; // already on top
  const fork = git(root, ["merge-base", main, tip]);
  const problem = await replayWaiting(store, root, plugin, main, fork, tip);
  if (problem) store.event(null, "waiting.stuck", { reason: problem });
  else store.event(null, "waiting.rebased", { onto: main });
}

/**
 * Replays the waiting commits after `fork` onto `onto`, re-checks them, and moves the waiting
 * branch there only if that all succeeds. Returns why it did not, or null once moved.
 */
export async function replayWaiting(store: Store, root: string, plugin: Plugin, onto: string, fork: string, tip: string): Promise<string | null> {
  const old = git(root, ["rev-list", "--reverse", `${fork}..${tip}`]).split("\n").filter(Boolean);
  const copy = makeCopy(root, tip, plugin.copyIn);
  try {
    git(copy, ["fetch", "--quiet", root, onto]);
    if (tryGit(copy, ["rebase", "--quiet", "--onto", onto, fork]) === null) {
      tryGit(copy, ["rebase", "--abort"]);
      return "The waiting features no longer apply cleanly.";
    }
    const setup = await runStage({ command: plugin.setup, cwd: copy, timeoutMs: plugin.minutes.setup * 60_000 });
    const check = setup.ok ? await runStage({ command: plugin.check, cwd: copy, timeoutMs: plugin.minutes.check * 60_000 }) : setup;
    if (!check.ok) return "The waiting features fail the project check.";
    const fresh = git(copy, ["rev-list", "--reverse", `${onto}..HEAD`]).split("\n").filter(Boolean);
    if (fresh.length !== old.length) return "A waiting feature became empty."; // leave everything as it was
    const newTip = fresh.at(-1) ?? onto;
    if (fresh.length) git(root, ["fetch", "--quiet", "--no-tags", copy, `${newTip}:refs/peeraxis/landing/${newTip}`]);
    const moved = tryGit(root, ["update-ref", `refs/heads/${WAITING}`, newTip, tip]) !== null;
    if (fresh.length) tryGit(root, ["update-ref", "-d", `refs/peeraxis/landing/${newTip}`]);
    if (!moved) return "The waiting features changed meanwhile.";
    const map = Object.fromEntries(old.map((sha, i) => [sha, fresh[i]]));
    for (const id of waitingCards(store, root)) {
      const sha = waitingShaOf(store, id);
      if (sha && map[sha]) store.event(id, "waiting.sha", { sha: map[sha], was: sha });
    }
    return null;
  } finally {
    removeCopy(copy);
  }
}

function waitingCards(store: Store, root: string): string[] {
  return (store.db.prepare("SELECT id FROM cards WHERE state = 'waiting' AND project = ?").all(root) as { id: string }[]).map((r) => r.id);
}

/** The commit a waiting card currently lives at on the waiting branch. */
export function waitingShaOf(store: Store, id: string): string | null {
  const latest = [...store.events(id)].reverse().find((e) => e.kind === "waiting.sha" || e.kind === "card.waiting");
  return latest?.data.sha ? String(latest.data.sha) : null;
}
