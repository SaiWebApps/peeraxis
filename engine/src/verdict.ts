// The owner's verdict on a waiting feature. Accept moves main forward to it; reject takes it
// off the waiting branch, replaying any newer waiting features without it. Neither ever rewrites
// main or loses the owner's uncommitted work.
import type { Store } from "./db.ts";
import { WAITING, git, tryGit } from "./git.ts";
import { loadPlugin } from "./plugin.ts";
import { replayWaiting, syncWaiting, waitingShaOf } from "./sync.ts";

function waitingSha(store: Store, id: string): string {
  const row = store.getCard(id);
  if (row.state !== "waiting") throw new Error(`"${row.card.title}" is ${row.state}, not waiting for a verdict.`);
  const sha = waitingShaOf(store, id);
  if (!sha) throw new Error("No landed commit is recorded for this card.");
  return sha;
}

/** When every card of a plan has a verdict, the plan itself is done. */
function finishPlan(store: Store, id: string): void {
  const parent = store.getCard(id).parent;
  if (!parent || store.getCard(parent).state !== "split") return;
  if (store.children(parent).every((c) => c.state === "accepted" || c.state === "rejected")) store.move(parent, "accepted", {});
}

/**
 * Moves main forward to one waiting feature. Verdicts go oldest first, one feature at a time.
 * A report or a choice has nothing to land: accepting records it (and, for a choice, the option picked).
 */
export async function accept(store: Store, id: string, choice?: number): Promise<void> {
  const row = store.getCard(id);
  if (row.card.kind === "report" || row.card.kind === "choice") {
    if (row.state !== "waiting") throw new Error(`"${row.card.title}" is ${row.state}, not waiting for a verdict.`);
    if (row.card.kind === "choice" && !(choice && choice >= 1 && choice <= 3)) throw new Error("Pick one of the three options.");
    store.move(id, "accepted", row.card.kind === "choice" ? { choice } : {});
    finishPlan(store, id);
    return;
  }
  const root = row.project;
  const plugin = loadPlugin(root);
  await syncWaiting(store, root, plugin);
  const sha = waitingSha(store, id);
  const main = plugin.mainBranch;
  const mainSha = git(root, ["rev-parse", `refs/heads/${main}`]);
  if (tryGit(root, ["rev-parse", `${sha}^`]) !== mainSha) {
    throw new Error(`Give a verdict on the older waiting features first, or ${main} has moved and the waiting features could not be brought up to date.`);
  }
  if (tryGit(root, ["symbolic-ref", "--short", "HEAD"]) === main) {
    if (git(root, ["status", "--porcelain", "--untracked-files=no"])) {
      throw new Error(`${main} is checked out with uncommitted changes, so it was not moved.`);
    }
    git(root, ["merge", "--quiet", "--ff-only", sha]);
  } else {
    git(root, ["update-ref", `refs/heads/${main}`, sha, mainSha]);
  }
  store.move(id, "accepted", { sha, main });
  finishPlan(store, id);
  if (git(root, ["rev-parse", `refs/heads/${WAITING}`]) === git(root, ["rev-parse", `refs/heads/${main}`])) {
    git(root, ["branch", "--quiet", "-D", WAITING]); // nothing left waiting
  }
}

/** Takes one waiting feature off the waiting branch; newer ones are replayed without it. */
export async function reject(store: Store, id: string, reason: string): Promise<void> {
  const why = reason.trim();
  if (!why) throw new Error("Say in one sentence why the feature is rejected.");
  const row = store.getCard(id);
  if (row.card.kind === "report" || row.card.kind === "choice") {
    store.move(id, "rejected", { reason: why });
    finishPlan(store, id);
    return;
  }
  const root = row.project;
  const plugin = loadPlugin(root);
  await syncWaiting(store, root, plugin);
  const sha = waitingSha(store, id);
  const tip = git(root, ["rev-parse", `refs/heads/${WAITING}`]);
  const parent = git(root, ["rev-parse", `${sha}^`]);
  if (tip === sha) git(root, ["update-ref", `refs/heads/${WAITING}`, parent, sha]);
  else {
    const problem = await replayWaiting(store, root, plugin, parent, sha, tip);
    if (problem) throw new Error(`The newer waiting features could not be kept without this one: ${problem}`);
  }
  store.move(id, "rejected", { sha, reason: why });
  finishPlan(store, id);
  if (git(root, ["rev-parse", `refs/heads/${WAITING}`]) === git(root, ["rev-parse", `refs/heads/${plugin.mainBranch}`])) {
    git(root, ["branch", "--quiet", "-D", WAITING]); // nothing left waiting
  }
}
