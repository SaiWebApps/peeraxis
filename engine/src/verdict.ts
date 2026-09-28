// The owner's verdict on a waiting feature. Accept moves main forward to it; reject takes it
// off the waiting branch. Neither ever rewrites main or loses the owner's uncommitted work.
import type { Store } from "./db.ts";
import { WAITING, git, tryGit } from "./git.ts";
import { loadPlugin } from "./plugin.ts";
import { syncWaiting, waitingShaOf } from "./sync.ts";

function waitingSha(store: Store, id: string): string {
  const row = store.getCard(id);
  if (row.state !== "waiting") throw new Error(`"${row.card.title}" is ${row.state}, not waiting for a verdict.`);
  const sha = waitingShaOf(store, id);
  if (!sha) throw new Error("No landed commit is recorded for this card.");
  return sha;
}

/** Moves main forward to one waiting feature. Verdicts go oldest first, one feature at a time. */
export async function accept(store: Store, id: string): Promise<void> {
  const row = store.getCard(id);
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
  if (git(root, ["rev-parse", `refs/heads/${WAITING}`]) === git(root, ["rev-parse", `refs/heads/${main}`])) {
    git(root, ["branch", "--quiet", "-D", WAITING]); // nothing left waiting
  }
}

export async function reject(store: Store, id: string, reason: string): Promise<void> {
  const row = store.getCard(id);
  await syncWaiting(store, row.project, loadPlugin(row.project));
  const sha = waitingSha(store, id);
  const tip = git(row.project, ["rev-parse", `refs/heads/${WAITING}`]);
  if (tip !== sha) throw new Error("Only the newest waiting feature can be rejected for now; verdict the newer ones first.");
  git(row.project, ["update-ref", `refs/heads/${WAITING}`, `${sha}^`, sha]);
  store.move(id, "rejected", { sha, reason });
}
