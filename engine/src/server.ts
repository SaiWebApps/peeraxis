// The local page: drafted cards waiting for the owner's yes, each with an Approve button, then
// every feature with where it is; one waiting for a verdict also shows its
// recording, an Accept button, and a quieter Reject that asks for one sentence of why.
// Only this machine may use it: requests must name 127.0.0.1/localhost as Host (and Origin, if
// sent), so a website that rebinds its own name to 127.0.0.1 cannot read cards or accept them.
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { CardRow, Store } from "./db.ts";
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

function page(store: Store, error: string | null): string {
  const all = cards(store);
  const drafts = all.filter((c) => c.state === "draft").map(draftNote).join("\n");
  const features = all.filter((c) => WHERE[c.state]).map((c) => {
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
  }).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Peeraxis</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/style.css"></head>
<body><main>
<h1>Peeraxis</h1>
${error ? `<p class="error" role="alert">${escape(error)}</p>` : ""}
${drafts ? `<section class="drafts" aria-labelledby="needs-yes"><h2 class="heading" id="needs-yes">Needs your yes</h2>\n${drafts}\n</section>` : ""}
${features || `<p class="empty">There are no features yet.</p>`}
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

export function serve(store: Store, port: number): Server {
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
      if (req.method === "GET" && url.pathname === "/") html(200, page(store, null));
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
