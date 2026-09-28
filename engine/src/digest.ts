// The daily digest: at most one Mac notification a day saying how many features are ready to
// watch, and none when nothing is waiting. The day is claimed in SQLite before the notification
// is shown, so the service and a CLI check running at the same moment cannot both send one.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import type { Store } from "./db.ts";

/** The local calendar day, e.g. "2026-09-27". */
export function localDay(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function digestText(count: number): string {
  return `${count} feature${count === 1 ? "" : "s"} ready to watch`;
}

/** Shows a Mac notification, or appends its text to $PEERAXIS_NOTIFY_FILE when that is set. */
export function notify(text: string): void {
  const file = process.env.PEERAXIS_NOTIFY_FILE;
  if (file) {
    appendFileSync(file, `${text}\n`);
    return;
  }
  execFileSync("osascript", [
    "-e", "on run argv", "-e", 'display notification (item 1 of argv) with title "Peeraxis"', "-e", "end run", text,
  ], { stdio: "ignore", timeout: 15_000 });
}

/** Sends today's digest if features are waiting and none was sent today. Returns the text sent, if any. */
export function dailyDigest(store: Store, now = new Date(), send = notify): string | null {
  const { count } = store.db.prepare("SELECT COUNT(*) AS count FROM cards WHERE state = 'waiting'").get() as { count: number };
  if (count === 0) return null;
  const day = localDay(now);
  const text = digestText(count);
  store.db.exec("CREATE TABLE IF NOT EXISTS digests (day TEXT PRIMARY KEY, at TEXT NOT NULL, text TEXT NOT NULL)");
  const claimed = store.db.prepare("INSERT OR IGNORE INTO digests VALUES (?, ?, ?)").run(day, now.toISOString(), text);
  if (Number(claimed.changes) === 0) return null;
  try {
    send(text);
  } catch (error) {
    // Not shown, so give the day back for a later check to retry.
    store.db.prepare("DELETE FROM digests WHERE day = ?").run(day);
    throw error;
  }
  store.event(null, "digest.sent", { day, count, text });
  return text;
}
