// The local page: a one-line box for describing a new feature, then a short chat of intake
// questions while one is being drafted; drafted cards waiting for the owner's yes, each with an Approve button, then
// every feature with where it is; one waiting for a verdict also shows its
// recording, an Accept button, and a quieter Reject that asks for one sentence of why.
// Only this machine may use it: requests must name 127.0.0.1/localhost as Host (and Origin, if
// sent), so a website that rebinds its own name to 127.0.0.1 cannot read cards or accept them.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import type { CardRow, Store } from "./db.ts";
import { defaultIntake, type Intake, type Question } from "./intake.ts";
import { DEFAULT_MODELS, KNOWN_MODELS, loadModels, saveModels, withModel, type ModelsConfig, type Role } from "./models.ts";
import { accept, reject } from "./verdict.ts";

const WEB = join(import.meta.dirname, "../../web");

const escape = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** The newest recording of a waiting card's passing attempt, if one was kept. */
export function recording(store: Store, id: string): string | null {
  const landed = [...store.events(id)].reverse().find((e) => e.kind === "card.waiting");
  const dir = landed?.data.evidence;
  if (typeof dir !== "string" || !existsSync(dir)) return null;
  const attempts = readdirSync(dir)
    .map((name) => /^attempt-(\d+)$/.exec(name))
    .filter((m) => m !== null)
    .sort((a, b) => Number(b[1]) - Number(a[1]));
  for (const m of attempts) {
    const video = findVideo(join(dir, m[0]));
    if (video) return video;
  }
  return null;
}

function findVideo(dir: string): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".webm")) return path;
    if (entry.isDirectory()) {
      const found = findVideo(path);
      if (found) return found;
    }
  }
  return null;
}

function cards(store: Store): CardRow[] {
  return (store.db.prepare("SELECT id FROM cards ORDER BY created_at").all() as { id: string }[]).map((r) => store.getCard(r.id));
}

/** Accepted and rejected features, the most recently finished first. */
function finished(store: Store): CardRow[] {
  return (store.db.prepare("SELECT id FROM cards WHERE state IN ('accepted', 'rejected') ORDER BY updated_at DESC, created_at DESC").all() as { id: string }[])
    .map((r) => store.getCard(r.id));
}

/** Where a feature is, as the owner reads it; drafts are not features yet. */
const WHERE: Partial<Record<CardRow["state"], [label: string, tone: string]>> = {
  approved: ["Queued", "queued"],
  testing: ["Building", "building"],
  building: ["Building", "building"],
  checking: ["Building", "building"],
  split: ["Building", "building"],
  waiting: ["Waiting for you", "waiting"],
  accepted: ["Accepted", "accepted"],
  rejected: ["Rejected", "stopped"],
  parked: ["Stopped", "stopped"],
};

/** A drafted card as a short note: title, Before and After, the steps to watch, and Approve. */
function draftNote(c: CardRow): string {
  const steps = c.card.watch.map((s) => `<li>${escape(s)}</li>`).join("");
  return `<article class="feature draft" data-card="${c.id}" data-state="draft"><h2>${escape(c.card.title)}</h2>
  <p class="project">${escape(basename(c.project))}</p>
  <p class="line"><span>Before:</span> ${escape(c.card.before)}</p>
  <p class="line"><span>After:</span> ${escape(c.card.after)}</p>
  <ol class="steps">${steps}</ol>
  <form method="post" action="/cards/${c.id}/approve"><button type="submit" class="approve">Approve</button></form>
</article>`;
}

/** Approving a draft freezes it and puts it in the queue. */
export function approveDraft(store: Store, id: string): void {
  const row = store.getCard(id);
  if (row.state !== "draft") throw new Error(`"${row.card.title}" is ${row.state}, not a draft waiting for your yes.`);
  store.move(id, "approved");
}

/** Each job in the owner's words, in the order the work happens. */
const JOBS: [Role, string][] = [
  ["intake", "Asks you questions"],
  ["cardCheck", "Checks the test matches the card"],
  ["builder", "Builds"],
  ["testAuthor", "Writes the hidden test"],
  ["reviewer", "Reviews the change"],
  ["lookReviewer", "Reviews how it looks"],
  ["splitter", "Splits stuck work"],
];

/** The Models page: each job on the left, a small dropdown of the model doing it on the right. */
export function modelsPage(config: ModelsConfig, refused?: { role: Role; message: string }): string {
  const rows = JOBS.map(([role, job]) => {
    const model = config.roles[role]?.[0]?.id ?? "None";
    const options = KNOWN_MODELS.map((m) => `<option${m.id === model ? " selected" : ""}>${escape(m.id)}</option>`).join("");
    const why = refused?.role === role ? `\n  <p class="refused" role="alert">${escape(refused.message)}</p>` : "";
    return `<div class="job" data-role="${role}"><dt>${escape(job)}</dt><dd><form method="post" action="/models/${role}">
    <span class="model">${escape(model)}</span><select name="model" aria-label="${escape(job)}" onchange="this.form.submit()">${options}</select>
  </form>${why}</dd></div>`;
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Models · Peeraxis</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css"></head>
<body><main>
<p class="back"><a href="/">← Peeraxis</a></p>
<h1>Models</h1>
<dl class="models">
${rows}
</dl>
</main></body></html>`;
}

/** One feature being described: the sentence, the intake questions, and the answers so far. */
type Chat = { id: string; sentence: string; project: string; questions: Question[]; answers: string[]; drafting: boolean };

/** New features go to the project the owner worked on most recently. */
function currentProject(store: Store): string {
  const row = store.db.prepare("SELECT project FROM cards ORDER BY updated_at DESC LIMIT 1").get() as { project: string } | undefined;
  if (!row) throw new Error("Add a project to Peeraxis before describing a feature.");
  return row.project;
}

/** Every project Peeraxis knows, by path. */
function projects(store: Store): string[] {
  return (store.db.prepare("SELECT DISTINCT project FROM cards ORDER BY project").all() as { project: string }[]).map((r) => r.project);
}

/** The project the owner picked, or the most recent one when none was picked. */
function chosenProject(store: Store, picked: string | null): string {
  if (!picked) return currentProject(store);
  if (!projects(store).includes(picked)) throw new Error("Pick one of the projects Peeraxis knows.");
  return picked;
}

/** The box at the top, or the chat while a feature is being described. */
function intakeBox(store: Store, chat: Chat | null): string {
  if (!chat) {
    const all = projects(store);
    const current = all.length ? currentProject(store) : "";
    const options = all.map((p) => `<option value="${escape(p)}"${p === current ? " selected" : ""}>${escape(basename(p))}</option>`).join("");
    return `<form class="intake" method="post" action="/intake">
  <select name="project" aria-label="Project">${options}</select>
  <input type="text" name="sentence" required maxlength="300" placeholder="Describe a new feature in one sentence" aria-label="New feature">
  <button type="submit">Send</button>
</form>`;
  }
  const said = (who: string, text: string) => `<p class="say ${who}">${escape(text)}</p>`;
  const lines = [said("you", chat.sentence)];
  chat.answers.forEach((answer, i) => lines.push(said("peeraxis", chat.questions[i].question), said("you", answer)));
  const q = chat.questions[chat.answers.length];
  lines.push(said("peeraxis", q.question));
  const [recommended, ...others] = q.options;
  const choice = (option: string, cls: string) => `<button type="submit" name="answer" value="${escape(option)}" class="${cls}">${escape(option)}</button>`;
  return `<section class="chat" aria-label="New feature">
${lines.join("\n")}
<form class="answers" method="post" action="/intake/${chat.id}">
  <input type="hidden" name="index" value="${chat.answers.length}">
  ${choice(recommended, "recommended")}<span class="tag">Recommended</span>
  ${others.map((o) => choice(o, "other")).join("\n  ")}
</form>
</section>`;
}

function page(store: Store, error: string | null, chat: Chat | null = null): string {
  const all = cards(store);
  const drafts = all.filter((c) => c.state === "draft").map(draftNote).join("\n");
  // What needs the owner comes first: a verdict, then work still under way; finished features go under Done.
  const open = all.filter((c) => WHERE[c.state] && c.state !== "accepted" && c.state !== "rejected");
  const ordered = [...open.filter((c) => c.state === "waiting"), ...open.filter((c) => c.state !== "waiting")];
  const feature = (c: CardRow) => {
    const [label, tone] = WHERE[c.state]!;
    const head = `<div class="row"><h2>${escape(c.card.title)}</h2> <span class="badge ${tone}">${label}</span></div>`;
    if (c.state === "rejected" || c.state === "parked") {
      const data = [...store.events(c.id)].reverse().find((e) => e.kind === `card.${c.state}`)?.data;
      const reason = c.state === "rejected" ? data?.reason : data?.sentence;
      const why = typeof reason === "string" ? `\n  <p class="reason">${escape(reason)}</p>\n` : "";
      return `<article class="feature" data-card="${c.id}" data-state="${c.state}">${head}${why}</article>`;
    }
    if (c.state !== "waiting") return `<article class="feature" data-card="${c.id}" data-state="${c.state}">${head}</article>`;
    const video = recording(store, c.id)
      ? `<video controls preload="metadata" src="/cards/${c.id}/video.webm" aria-label="Recording of ${escape(c.card.title)}"></video>`
      : `<p class="missing">No recording was kept for this feature.</p>`;
    return `<article class="feature" data-card="${c.id}" data-state="waiting">${head}
  <p class="after">${escape(c.card.after)}</p>
  <div class="watch">${video}
    <div class="verdict">
      <form method="post" action="/cards/${c.id}/accept"><button type="submit">Accept</button></form>
      <form class="reject" method="post" action="/cards/${c.id}/reject">
        <input type="text" name="reason" required maxlength="300" placeholder="Why reject? One sentence." aria-label="Why reject ${escape(c.card.title)}">
        <button type="submit">Reject</button>
      </form>
    </div>
  </div>
</article>`;
  };
  const features = ordered.map(feature).join("\n");
  const done = finished(store).map(feature).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Peeraxis</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css"></head>
<body><main>
<div class="row top"><h1>Peeraxis</h1> <a href="/models">Models</a></div>
${intakeBox(store, chat)}
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
${drafts ? `<section class="drafts" aria-labelledby="needs-yes"><h2 class="heading" id="needs-yes">Needs your yes</h2>\n${drafts}\n</section>` : ""}
${features || (done ? "" : `<p class="empty">There are no features yet.</p>`)}
${done ? `<section class="done" aria-labelledby="done"><h2 class="heading" id="done">Done</h2>\n${done}\n</section>` : ""}
</main></body></html>`;
}

function sendVideo(req: IncomingMessage, res: ServerResponse, file: string): void {
  const size = statSync(file).size;
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${size}` });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "Content-Type": "video/webm", "Accept-Ranges": "bytes", "Content-Length": size });
  createReadStream(file).pipe(res);
}

async function body(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 10_000) throw new Error("Too much was sent.");
  }
  return text;
}

/** True when the request comes from this machine's own page, not a rebound or foreign site. */
export function trusted(req: IncomingMessage, port: number): boolean {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!hosts.has(req.headers.host ?? "")) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return req.method === "GET" || req.method === "HEAD" || req.headers["sec-fetch-site"] === undefined;
  return [...hosts].some((h) => origin === `http://${h}`);
}

export function serve(store: Store, port: number, modelsFile?: string, intake: Intake = defaultIntake(modelsFile)): Server {
  const chats = new Map<string, Chat>();
  const server = createServer(async (req, res) => {
    try {
      if (!trusted(req, port)) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
        return;
      }
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const html = (status: number, body: string) =>
        res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }).end(body);
      const video = /^\/cards\/([0-9a-f-]{36})\/video\.webm$/.exec(url.pathname);
      const verdict = /^\/cards\/([0-9a-f-]{36})\/(accept|reject|approve)$/.exec(url.pathname);
      const answer = /^\/intake\/([0-9a-f-]{36})$/.exec(url.pathname);
      const job = new RegExp(`^/models/(${JOBS.map(([r]) => r).join("|")})$`).exec(url.pathname);
      if (req.method === "GET" && url.pathname === "/") html(200, page(store, null, chats.get(url.searchParams.get("intake") ?? "") ?? null));
      else if (req.method === "POST" && url.pathname === "/intake") {
        const form = new URLSearchParams(await body(req));
        const sentence = (form.get("sentence") ?? "").trim();
        let chat: Chat;
        try {
          if (!sentence) throw new Error("Describe the feature in one sentence first.");
          const project = chosenProject(store, form.get("project"));
          chat = { id: randomUUID(), sentence, project, questions: await intake.ask(sentence, project), answers: [], drafting: false };
          if (!chat.questions.length) store.draft(project, await intake.draft(sentence, project, []));
        } catch (error) {
          html(409, page(store, (error as Error).message));
          return;
        }
        if (chat.questions.length) {
          chats.set(chat.id, chat);
          if (chats.size > 20) chats.delete(chats.keys().next().value!);
        }
        res.writeHead(303, { Location: chat.questions.length ? `/?intake=${chat.id}` : "/" }).end();
      } else if (req.method === "POST" && answer) {
        const chat = chats.get(answer[1]);
        const form = new URLSearchParams(await body(req));
        const choice = form.get("answer") ?? "";
        // An answer counts only for the question it was given to, so a stale tab cannot answer the next one.
        const problem = !chat ? "That feature was already drafted or has expired; describe it again."
          : chat.drafting ? "Peeraxis is already drafting this card."
          : form.get("index") !== String(chat.answers.length) ? "That question was already answered; here is where things stand."
          : !chat.questions[chat.answers.length].options.includes(choice) ? "Pick one of the offered answers."
          : null;
        if (problem) {
          html(409, page(store, problem, chat && !chat.drafting ? chat : null));
          return;
        }
        const answers = [...chat!.answers, choice];
        if (answers.length < chat!.questions.length) {
          chat!.answers = answers;
          res.writeHead(303, { Location: `/?intake=${chat!.id}` }).end();
          return;
        }
        // The last answer is kept only once the card is drafted, so a failure can be retried in place.
        chat!.drafting = true;
        try {
          const answered = answers.map((a, i) => ({ question: chat!.questions[i].question, answer: a }));
          store.draft(chat!.project, await intake.draft(chat!.sentence, chat!.project, answered));
          chats.delete(chat!.id);
        } catch (error) {
          chat!.drafting = false;
          html(502, page(store, `Peeraxis could not draft the card: ${(error as Error).message}`, chat!));
          return;
        }
        res.writeHead(303, { Location: "/" }).end();
      }
      else if (req.method === "GET" && url.pathname === "/models") html(200, modelsPage(modelsFile ? loadModels(modelsFile) : DEFAULT_MODELS));
      else if (req.method === "POST" && job) {
        const role = job[1] as Role;
        const config = modelsFile ? loadModels(modelsFile) : DEFAULT_MODELS;
        try {
          if (!modelsFile) throw new Error("There is no models file to save to.");
          // Saved to models.json, which the engine reads again before each step.
          saveModels(modelsFile, withModel(config, role, new URLSearchParams(await body(req)).get("model") ?? ""));
        } catch (error) {
          html(409, modelsPage(config, { role, message: (error as Error).message }));
          return;
        }
        res.writeHead(303, { Location: "/models" }).end();
      }
      else if (req.method === "GET" && url.pathname === "/style.css") {
        res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" }).end(readFileSync(join(WEB, "style.css")));
      } else if (req.method === "GET" && video) {
        const file = recording(store, video[1]);
        if (file) sendVideo(req, res, file);
        else res.writeHead(404).end();
      } else if (req.method === "POST" && verdict) {
        try {
          if (verdict[2] === "approve") approveDraft(store, verdict[1]);
          else if (verdict[2] === "accept") await accept(store, verdict[1]);
          else await reject(store, verdict[1], new URLSearchParams(await body(req)).get("reason") ?? "");
        } catch (error) {
          html(409, page(store, (error as Error).message));
          return;
        }
        res.writeHead(303, { Location: "/" }).end();
      } else res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    } catch (error) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" }).end(String(error));
    }
  });
  server.listen(port, "127.0.0.1");
  return server;
}
