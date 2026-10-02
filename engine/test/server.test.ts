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
import { scriptedIntake, type Intake } from "../src/intake.ts";
import { DEFAULT_MODELS, loadModels, saveModels, withModel } from "../src/models.ts";

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
  assert.match(page, /<dt>Builds<\/dt><dd>[^]*?<span class="model">claude-opus-5-5<\/span>/);
  assert.match(page, /<dt>Writes the hidden test<\/dt><dd>[^]*?<span class="model">gpt-6-astra<\/span>/);
  for (const job of ["Asks you questions", "Checks the test matches the card", "Reviews the change", "Reviews how it looks", "Splits stuck work"]) {
    assert.ok(page.includes(`<dt>${job}</dt>`), job);
  }
});

test("a job's model can be changed on the Models page, but never to its checker's family", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pxhome-"));
  execFileSync(process.execPath, [join(import.meta.dirname, "seed.ts")], { env: { ...process.env, PEERAXIS_HOME: home }, encoding: "utf8" });
  const store = new Store(join(home, "peeraxis.sqlite"));
  const file = join(home, "models.json");
  // Even with same-family checks allowed for running, the Models page refuses such a change.
  saveModels(file, { ...loadModels(file), allowSameFamilyChecks: true });
  const port = await freePort();
  const server = serve(store, port, file);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${port}`;
  const post = (model: string) =>
    fetch(`${base}/models/builder`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ model }), redirect: "manual" });

  assert.equal((await post("claude-fable-5-1")).status, 303);
  assert.equal(loadModels(file).roles.builder[0].id, "claude-fable-5-1");
  assert.match(await (await fetch(`${base}/models`)).text(), /<dt>Builds<\/dt><dd>[^]*?<span class="model">claude-fable-5-1<\/span>/);

  const refused = await post("gpt-6-sol");
  assert.equal(refused.status, 409);
  const text = await refused.text();
  assert.ok(text.includes("The builder and its checker can&#39;t be from the same family."));
  assert.match(text, /<dt>Builds<\/dt><dd>[^]*?<span class="model">claude-fable-5-1<\/span>/);
  assert.equal(loadModels(file).roles.builder[0].id, "claude-fable-5-1");
  assert.throws(() => withModel(DEFAULT_MODELS, "reviewer", "claude-opus-5-5"), /same family/);
  assert.equal((await post("opus")).status, 409);
});

test("one typed sentence asks the scripted question and drafts the card under Needs your yes", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pxhome-"));
  execFileSync(process.execPath, [join(import.meta.dirname, "seed.ts")], { env: { ...process.env, PEERAXIS_HOME: home }, encoding: "utf8" });
  const store = new Store(join(home, "peeraxis.sqlite"));
  const port = await freePort();
  const server = serve(store, port, undefined, scriptedIntake(join(import.meta.dirname, "fixtures/intake.json")));
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${port}`;

  assert.match(await (await fetch(`${base}/`)).text(), /<form class="intake" method="post" action="\/intake">/);
  const sent = await fetch(`${base}/intake`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ sentence: "Let me pin a feature to the top" }), redirect: "manual" });
  assert.equal(sent.status, 303);
  const chat = await (await fetch(new URL(sent.headers.get("location")!, base))).text();
  assert.ok(chat.includes("Should a pinned feature stay pinned after you accept it?"));
  assert.match(chat, /class="recommended">No, unpin it when accepted<\/button>/);
  const action = /action="(\/intake\/[^"]+)"/.exec(chat)![1];

  const stale = await fetch(`${base}${action}`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ index: "1", answer: "No, unpin it when accepted" }), redirect: "manual" });
  assert.equal(stale.status, 409);
  const picked = await fetch(`${base}${action}`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ index: "0", answer: "No, unpin it when accepted" }), redirect: "manual" });
  assert.equal(picked.status, 303);
  const after = await (await fetch(`${base}/`)).text();
  assert.ok(after.indexOf("<h2>Pin a feature to the top</h2>") > after.indexOf("Needs your yes"));
  const again = await fetch(`${base}${action}`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams({ index: "0", answer: "No, unpin it when accepted" }), redirect: "manual" });
  assert.equal(again.status, 409);
  assert.equal((store.db.prepare("SELECT count(*) AS n FROM cards WHERE state = 'draft'").get() as { n: number }).n, 2);
});

test("an answer from a stale tab never answers a later question, and a failed draft can be retried", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pxhome-"));
  execFileSync(process.execPath, [join(import.meta.dirname, "seed.ts")], { env: { ...process.env, PEERAXIS_HOME: home }, encoding: "utf8" });
  const store = new Store(join(home, "peeraxis.sqlite"));
  let fail = true;
  const seen: string[][] = [];
  const intake: Intake = {
    ask: async () => [
      { question: "First?", recommended: "A", options: ["A", "B"] },
      { question: "Second?", recommended: "C", options: ["C", "D"] },
    ],
    draft: async (_s, _p, answered) => {
      seen.push(answered.map((a) => a.answer));
      if (fail) throw new Error("model was busy");
      return { title: "Drafted", before: "b", after: "a", watch: ["w"], notIncluded: [] };
    },
  };
  const port = await freePort();
  const server = serve(store, port, undefined, intake);
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${port}`;
  const post = (path: string, form: Record<string, string>) =>
    fetch(`${base}${path}`, { method: "POST", headers: { Origin: base }, body: new URLSearchParams(form), redirect: "manual" });

  const sent = await post("/intake", { sentence: "Something" });
  const action = `/intake/${new URL(sent.headers.get("location")!, base).searchParams.get("intake")}`;
  assert.equal((await post(action, { index: "0", answer: "B" })).status, 303);
  const stale = await post(action, { index: "0", answer: "A" });
  assert.equal(stale.status, 409);
  assert.ok((await stale.text()).includes("Second?"));

  const failed = await post(action, { index: "1", answer: "D" });
  assert.equal(failed.status, 502);
  const failedPage = await failed.text();
  assert.match(failedPage, /model was busy/);
  assert.ok(failedPage.includes('name="index" value="1"'));
  assert.equal((await post(action, { index: "1", answer: "E" })).status, 409);
  fail = false;
  assert.equal((await post(action, { index: "1", answer: "C" })).status, 303);
  assert.deepEqual(seen, [["B", "D"], ["B", "C"]]);
  assert.match(await (await fetch(`${base}/`)).text(), /<h2>Drafted<\/h2>/);
});
