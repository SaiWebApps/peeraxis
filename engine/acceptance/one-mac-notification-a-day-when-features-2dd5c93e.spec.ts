import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

// Exercise the installed service's public entry point. Accelerating a whole
// calendar day leaves the notification hour up to the product. Replaying that
// same date with the same home exercises another daily check, including after
// a service restart, without inventing a notification-specific CLI command.
const serviceDay = `
  import { mock } from 'node:test';
  import { setTimeout as realSleep } from 'node:timers/promises';
  mock.timers.enable({
    apis: ['Date', 'setTimeout', 'setInterval'],
    now: new Date('2030-01-15T00:00:00Z'),
  });
  process.argv = [process.execPath, 'engine/src/main.ts', 'run'];
  import('./engine/src/main.ts').catch(error => {
    console.error(error);
    process.exit(1);
  });
  // Let module loading and the service's initial asynchronous work settle.
  await realSleep(1000);
  for (let minute = 0; minute < 1440; minute++) {
    mock.timers.tick(minute === 1439 ? 59999 : 60000);
    await realSleep(5);
  }
  await realSleep(100);
  process.send('day observed');
`;

async function observeServiceDay(home: string, notifications: string): Promise<void> {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", serviceDay], {
    cwd: new URL("../../", import.meta.url),
    env: { ...process.env, PEERAXIS_HOME: home, PEERAXIS_NOTIFY_FILE: notifications, TZ: "UTC" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk; });
  child.stderr!.on("data", chunk => { output += chunk; });
  const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Service did not finish the observation: ${output}`)), 30_000);
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      child.once("error", finish);
      child.once("exit", (code, signal) => finish(new Error(`Service exited (${code ?? signal}): ${output}`)));
      child.once("message", message => {
        if (message === "day observed") finish();
        else finish(new Error(`Unexpected observation message: ${String(message)}`));
      });
    });
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}

test("One Mac notification a day when features are ready to watch", { timeout: 70_000 }, async t => {
  const home = process.env.PEERAXIS_HOME;
  assert.ok(home, "Run through scripts/acceptance.sh to provide the seeded home");

  // Keep the seeded waiting feature and its evidence. Park unrelated pending
  // work so this notification test never starts a model or builds new features.
  const db = new DatabaseSync(join(home, "peeraxis.sqlite"));
  try {
    db.exec("UPDATE cards SET state = 'parked' WHERE state IN ('approved', 'testing', 'building', 'checking')");
  } finally {
    db.close();
  }
  const notifications = join(home, "daily-notifications.txt");
  const visibleNotifications = () => existsSync(notifications)
    ? readFileSync(notifications, "utf8").split(/\r?\n/).filter(line => line.length > 0)
    : [];

  await t.test('With one feature waiting, the daily check shows the notification "1 feature ready to watch"', async () => {
    await observeServiceDay(home, notifications);
    assert.deepEqual(visibleNotifications(), ["1 feature ready to watch"]);
  });

  await t.test("Running the daily check again the same day shows nothing new", async () => {
    // Preserve both the delivery record and the service's home between checks.
    await observeServiceDay(home, notifications);
    assert.deepEqual(visibleNotifications(), ["1 feature ready to watch"]);
  });
});
