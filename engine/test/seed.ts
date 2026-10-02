// Seeds a throwaway PEERAXIS_HOME with a sample project and cards in every state, so the
// app's screens can be exercised without running any model. Used by scripts/acceptance.sh.
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store, type Card } from "../src/db.ts";

const home = process.env.PEERAXIS_HOME;
if (!home) throw new Error("seed.ts needs PEERAXIS_HOME");
mkdirSync(home, { recursive: true });

// A sample project with main and one feature waiting on peeraxis/waiting.
const project = join(home, "sample-project");
mkdirSync(join(project, ".peeraxis"), { recursive: true });
const git = (...args: string[]) => execFileSync("git", args, { cwd: project, encoding: "utf8" }).trim();
writeFileSync(join(project, ".peeraxis/project.json"), JSON.stringify({
  setup: "true", check: "true", acceptance: "true", testFile: "t/{name}.test.js", allowedPaths: ["**"],
}));
writeFileSync(join(project, "app.txt"), "hi\n");
git("init", "-q", "-b", "main");
git("config", "user.name", "Sample");
git("config", "user.email", "sample@example.com");
git("add", "-A");
git("commit", "-q", "-m", "start");
git("checkout", "-q", "-b", "peeraxis/waiting");
writeFileSync(join(project, "app.txt"), "hello\n");
git("commit", "-qam", "Greeting says hello");
const featureSha = git("rev-parse", "HEAD");
git("checkout", "-q", "main");

const store = new Store(join(home, "peeraxis.sqlite"));
const card = (title: string, after: string): Card => ({
  title, before: "Before this card.", after, watch: ["Open the app and see the change"], notIncluded: [],
});
const walk = (id: string, states: Parameters<Store["move"]>[1][]) => states.forEach((s) => store.move(id, s));

const fixtures = join(import.meta.dirname, "fixtures");
const waiting = store.approve(project, card("Greeting says hello", "The greeting says hello."));
walk(waiting, ["testing", "building", "checking"]);
const evidence = join(home, "cards", waiting, "evidence", "attempt-1");
mkdirSync(evidence, { recursive: true });
copyFileSync(join(fixtures, "sample.webm"), join(evidence, "video.webm"));
copyFileSync(join(fixtures, "sample.png"), join(evidence, "screenshot.png"));
store.move(waiting, "waiting", { sha: featureSha, builder: "claude-opus-5-5", evidence: join(home, "cards", waiting, "evidence") });

const building = store.approve(project, card("Farewell says goodbye", "The farewell says goodbye."));
walk(building, ["testing", "building"]);

store.approve(project, card("Dark mode for the settings page", "Settings follow the system dark mode."));

const parked = store.approve(project, card("Import contacts from a file", "Contacts can be imported from a CSV file."));
store.move(parked, "parked", { sentence: "Parked: the project's own check fails before any change, so nothing was built." });

const accepted = store.approve(project, card("Title is bold", "The page title is bold."));
walk(accepted, ["testing", "building", "checking"]);
store.move(accepted, "waiting", { sha: git("rev-parse", "main"), builder: "claude-opus-5-5" });
store.move(accepted, "accepted", { sha: git("rev-parse", "main"), main: "main" });

const draft = store.draft(project, {
  title: "Show the date each feature finished",
  before: "Finished features do not say when they finished.",
  after: "Each accepted feature shows the date it was accepted.",
  watch: ["See \"Title is bold\" say it was accepted today"],
  notIncluded: ["Times of day"],
});

console.log(JSON.stringify({ project, waiting, building, parked, accepted, draft }));
