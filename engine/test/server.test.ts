import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/db.ts";
import { serve } from "../src/server.ts";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address() as { port: number };
  await new Promise((r) => s.close(r));
  return port;
}

test("the page shows a waiting feature's recording, accepts it, and refuses foreign hosts and origins", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pxhome-"));
  const seed = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "seed.ts")], { env: { ...process.env, PEERAXIS_HOME: home }, encoding: "utf8" }));
  const store = new Store(join(home, "peeraxis.sqlite"));
  const port = await freePort();
  const server = serve(store, port);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${port}`;

  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /Greeting says hello<\/h2> <span class="badge waiting">Waiting for you/);
  assert.match(page, /Farewell says goodbye<\/h2> <span class="badge building">Building/);
  assert.match(page, /Dark mode for the settings page<\/h2> <span class="badge queued">Queued/);
  assert.match(page, /Import contacts from a file<\/h2> <span class="badge stopped">Stopped/);
  assert.match(page, /Title is bold<\/h2> <span class="badge accepted">Accepted/);
  assert.ok(page.includes(`/cards/${seed.waiting}/video.webm`));
  const video = await fetch(`${base}/cards/${seed.waiting}/video.webm`, { headers: { Range: "bytes=0-9" } });
  assert.equal(video.status, 206);
  assert.equal((await video.arrayBuffer()).byteLength, 10);

  const rebound = await new Promise<number | undefined>((resolve, reject) =>
    request({ host: "127.0.0.1", port, path: "/", headers: { Host: `evil.example:${port}` } }, (res) => { res.resume(); resolve(res.statusCode); })
      .on("error", reject).end());
  assert.equal(rebound, 403);
  const foreign = await fetch(`${base}/cards/${seed.waiting}/accept`, { method: "POST", headers: { Origin: "http://evil.example" }, redirect: "manual" });
  assert.equal(foreign.status, 403);
  assert.equal(store.getCard(seed.waiting).state, "waiting");

  const empty = await fetch(`${base}/cards/${seed.waiting}/reject`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ reason: " " }), redirect: "manual" });
  assert.equal(empty.status, 409);
  assert.equal(store.getCard(seed.waiting).state, "waiting");
  assert.match(page, new RegExp(`action="/cards/${seed.waiting}/reject"`));
  const accepted = await fetch(`${base}/cards/${seed.waiting}/accept`, { method: "POST", headers: { Origin: base }, redirect: "manual" });
  assert.equal(accepted.status, 303);
  assert.equal(store.getCard(seed.waiting).state, "accepted");
  assert.match(await (await fetch(`${base}/`)).text(), /Greeting says hello<\/h2> <span class="badge accepted">Accepted/);
});

test("the page rejects a waiting feature with one sentence of why and shows it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pxhome-"));
  const seed = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "seed.ts")], { env: { ...process.env, PEERAXIS_HOME: home }, encoding: "utf8" }));
  const store = new Store(join(home, "peeraxis.sqlite"));
  const port = await freePort();
  const server = serve(store, port);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${port}`;

  const rejected = await fetch(`${base}/cards/${seed.waiting}/reject`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ reason: "The greeting should be <warmer>" }), redirect: "manual" });
  assert.equal(rejected.status, 303);
  assert.equal(store.getCard(seed.waiting).state, "rejected");
  assert.match(await (await fetch(`${base}/`)).text(), /Greeting says hello<\/h2> <span class="badge stopped">Rejected<\/span><\/div>\n  <p class="reason">The greeting should be &lt;warmer&gt;<\/p>/);
  assert.match(await (await fetch(`${base}/`)).text(), /Import contacts from a file<\/h2> <span class="badge stopped">Stopped<\/span><\/div>\n  <p class="reason">Parked: the project&#39;s own check fails before any change, so nothing was built\.<\/p>/);
});

test("the page shows a drafted card under Needs your yes and approving queues it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pxhome-"));
  const seed = JSON.parse(execFileSync(process.execPath, [join(import.meta.dirname, "seed.ts")], { env: { ...process.env, PEERAXIS_HOME: home }, encoding: "utf8" }));
  const store = new Store(join(home, "peeraxis.sqlite"));
  const port = await freePort();
  const server = serve(store, port);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${port}`;

  const page = await (await fetch(`${base}/`)).text();
  assert.match(page, /Needs your yes<\/h2>\n<article class="feature draft" data-card="[^"]+" data-state="draft"><h2>Show the date each feature finished<\/h2>/);
  assert.match(page, /Finished features do not say when they finished\./);
  assert.match(page, /<li>See &quot;Title is bold&quot; say it was accepted today<\/li>/);
  assert.ok(page.indexOf("Needs your yes") < page.indexOf("Greeting says hello"));

  const approved = await fetch(`${base}/cards/${seed.draft}/approve`, { method: "POST", headers: { Origin: base }, redirect: "manual" });
  assert.equal(approved.status, 303);
  assert.equal(store.getCard(seed.draft).state, "approved");
  const after = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(after, /Needs your yes/);
  assert.match(after, /Show the date each feature finished<\/h2> <span class="badge queued">Queued/);

  const again = await fetch(`${base}/cards/${seed.draft}/approve`, { method: "POST", headers: { Origin: base }, redirect: "manual" });
  assert.equal(again.status, 409);
});

test("the Models page, linked from the main page, lists each job with the model doing it", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pxhome-"));
  execFileSync(process.execPath, [join(import.meta.dirname, "seed.ts")], { env: { ...process.env, PEERAXIS_HOME: home }, encoding: "utf8" });
  const store = new Store(join(home, "peeraxis.sqlite"));
  const port = await freePort();
  const server = serve(store, port, join(home, "models.json"));
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${port}`;

  assert.match(await (await fetch(`${base}/`)).text(), /<a href="\/models">Models<\/a>/);
  const page = await (await fetch(`${base}/models`)).text();
  assert.match(page, /<dt>Builds<\/dt><dd>claude-opus-5-5<\/dd>/);
  assert.match(page, /<dt>Writes the hidden test<\/dt><dd>gpt-6-astra<\/dd>/);
  for (const job of ["Asks you questions", "Checks the test matches the card", "Reviews the change", "Reviews how it looks", "Splits stuck work"]) {
    assert.ok(page.includes(`<dt>${job}</dt>`), job);
  }
});
