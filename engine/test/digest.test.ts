import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Store } from "../src/db.ts";
import { dailyDigest } from "../src/digest.ts";

const MAIN = join(import.meta.dirname, "../src/main.ts");
const SEED = join(import.meta.dirname, "seed.ts");

function seeded(): { home: string; notes: string; env: NodeJS.ProcessEnv } {
  const home = mkdtempSync(join(tmpdir(), "px-digest-"));
  const notes = join(home, "notifications.txt");
  const env = { ...process.env, PEERAXIS_HOME: home, PEERAXIS_NOTIFY_FILE: notes };
  execFileSync(process.execPath, [SEED], { env, stdio: "ignore" });
  return { home, notes, env };
}

const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);

test("the daily check sends one notification a day, even when run twice at once", async () => {
  const { notes, env } = seeded();
  const run = promisify(execFile);
  await Promise.all([1, 2, 3].map(() => run(process.execPath, [MAIN, "digest"], { env })));
  assert.deepEqual(lines(notes), ["1 feature ready to watch"]);
  execFileSync(process.execPath, [MAIN, "digest"], { env });
  assert.deepEqual(lines(notes), ["1 feature ready to watch"]);
});

test("the next day sends again, and nothing is sent when no feature is waiting", () => {
  const { home } = seeded();
  const store = new Store(join(home, "peeraxis.sqlite"));
  const sent: string[] = [];
  const send = (text: string) => { sent.push(text); };
  assert.equal(dailyDigest(store, new Date(2026, 8, 27, 9), send), "1 feature ready to watch");
  assert.equal(dailyDigest(store, new Date(2026, 8, 27, 23), send), null);
  assert.equal(dailyDigest(store, new Date(2026, 8, 28, 0, 5), send), "1 feature ready to watch");
  store.db.exec("UPDATE cards SET state = 'rejected' WHERE state = 'waiting'");
  assert.equal(dailyDigest(store, new Date(2026, 8, 29, 9), send), null);
  assert.equal(sent.length, 2);
});

test("a notification that fails to show is retried by a later check the same day", () => {
  const { home } = seeded();
  const store = new Store(join(home, "peeraxis.sqlite"));
  const day = new Date(2026, 8, 27, 9);
  assert.throws(() => dailyDigest(store, day, () => { throw new Error("osascript failed"); }));
  assert.equal(dailyDigest(store, day, () => {}), "1 feature ready to watch");
});
