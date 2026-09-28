// The owner's verdict on a waiting feature. Accept moves main forward to it; reject takes it
// off the waiting branch. Neither ever rewrites main or loses the owner's uncommitted work.
import type { Store } from "./db.ts";
import { WAITING, git, tryGit } from "./git.ts";
import { loadPlugin } from "./plugin.ts";

function waitingSha(store: Store, id: string): string {
  const row = store.getCard(id);
  if (row.state !== "waiting") throw new Error(`"${row.card.title}" is ${row.state}, not waiting for a verdict.`);
  const landed = [...store.events(id)].reverse().find((e) => e.kind === "card.waiting");
  if (!landed?.data.sha) throw new Error("No landed commit is recorded for this card.");
  return String(landed.data.sha);
}

export function accept(store: Store, id: string): void {
  const row = store.getCard(id);
  const sha = waitingSha(store, id);
  const root = row.project;
  const main = loadPlugin(root).mainBranch;
  const mainSha = git(root, ["rev-parse", `refs/heads/${main}`]);
  if (tryGit(root, ["merge-base", "--is-ancestor", mainSha, sha]) === null) {
    throw new Error(`${main} has moved in a way that cannot simply move forward to this feature.`);
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

export function reject(store: Store, id: string, reason: string): void {
  const row = store.getCard(id);
  const sha = waitingSha(store, id);
  const tip = git(row.project, ["rev-parse", `refs/heads/${WAITING}`]);
  if (tip !== sha) throw new Error("Only the newest waiting feature can be rejected for now; verdict the newer ones first.");
  git(row.project, ["update-ref", `refs/heads/${WAITING}`, `${sha}^`, sha]);
  store.move(id, "rejected", { sha, reason });
}
