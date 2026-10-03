// The engine's durable state: cards and an append-only event log, in one SQLite file.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { redact } from "./redact.ts";

export type Card = {
  title: string;
  before: string;
  after: string;
  watch: string[]; // the steps the owner will watch in the recording
  notIncluded: string[];
  look?: string; // short look brief, for screen changes
  allowedPaths?: string[]; // narrows the plug-in's allowed paths
  /**
   * change (default): a code change proved by a hidden test. report: a written result (e.g. running the
   * product and reporting on it), checked by a reviewer. choice: visual options the owner picks from.
   * plan: a parent holding an ordered list of cards drafted from one request.
   */
  kind?: "change" | "report" | "choice" | "plan";
};

export type CardState =
  | "draft" | "approved" | "testing" | "building" | "checking"
  | "waiting" | "accepted" | "rejected" | "parked" | "split";

export type CardRow = {
  id: string;
  project: string;
  parent: string | null;
  card: Card;
  hash: string;
  state: CardState;
};

const NEXT: Record<CardState, CardState[]> = {
  draft: ["approved", "split"],
  approved: ["testing", "building", "parked"],
  testing: ["testing", "building", "parked"],
  building: ["building", "checking", "parked", "split", "waiting"], // waiting: reports and choices land nothing
  checking: ["building", "waiting", "parked"],
  waiting: ["accepted", "rejected"],
  accepted: [],
  rejected: [],
  parked: ["approved", "rejected"], // rejected: dropped by the owner, e.g. replaced by a later card
  split: ["waiting", "parked", "accepted"],
};

export function cardHash(card: Card): string {
  return createHash("sha256").update(canonical(card)).digest("hex");
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function validateCard(card: Card): string | null {
  if (!card.title?.trim() || card.title.length > 80) return "The card needs a title of at most 80 characters.";
  if (!card.before?.trim() || !card.after?.trim()) return "The card needs a Before and an After.";
  if (!Array.isArray(card.watch) || card.watch.length < 1 || card.watch.length > 8)
    return "The card needs 1 to 8 steps to watch.";
  if (!Array.isArray(card.notIncluded)) return "The card needs a (possibly empty) not-included list.";
  return null;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS cards (
        id TEXT PRIMARY KEY, project TEXT NOT NULL, parent TEXT,
        card TEXT NOT NULL, hash TEXT NOT NULL, state TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
        card TEXT, kind TEXT NOT NULL, data TEXT NOT NULL);
    `);
  }

  /** Adds an approved card. The hash freezes it: getCard refuses a row whose card no longer matches. */
  approve(project: string, card: Card, parent: string | null = null): string {
    const problem = validateCard(card);
    if (problem) throw new Error(problem);
    const id = randomUUID();
    const now = new Date().toISOString();
    // The queue runs in created_at order. Parts of a split card take their parent's place in
    // the queue ("<parent time>~<n>" sorts right after it), so later cards never jump ahead.
    const order = parent ? this.queuePlace(parent) : now;
    this.db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, 'approved', ?, ?)")
      .run(id, project, parent, JSON.stringify(card), cardHash(card), order, now);
    this.event(id, "card.approved", { title: card.title, parent });
    return id;
  }

  private queuePlace(parent: string): string {
    const { created_at } = this.db.prepare("SELECT created_at FROM cards WHERE id = ?").get(parent) as { created_at: string };
    const { n } = this.db.prepare("SELECT count(*) AS n FROM cards WHERE parent = ?").get(parent) as { n: number };
    return `${created_at}~${n}`;
  }

  /** A card drafted at intake, not yet approved by the owner. It is frozen only when approved. */
  draft(project: string, card: Card): string {
    const problem = validateCard(card);
    if (problem) throw new Error(problem);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.db.prepare("INSERT INTO cards VALUES (?, ?, NULL, ?, ?, 'draft', ?, ?)")
      .run(id, project, JSON.stringify(card), cardHash(card), now, now);
    this.event(id, "card.drafted", { title: card.title });
    return id;
  }

  /**
   * Drafts a plan: a parent card summing up the request and its ordered child cards, all waiting for
   * one yes. The children keep the parent's place in the queue, in order.
   */
  draftPlan(project: string, plan: { title: string; before: string; after: string; cards: Card[] }): string {
    const summary: Card = {
      kind: "plan", title: plan.title, before: plan.before, after: plan.after,
      watch: plan.cards.map((c) => c.title).slice(0, 8), notIncluded: [],
    };
    const id = this.draft(project, summary);
    plan.cards.slice(0, 8).forEach((card, i) => {
      const problem = validateCard(card);
      if (problem) throw new Error(`Card ${i + 1} of the plan is not usable: ${problem}`);
      const child = randomUUID();
      const now = new Date().toISOString();
      this.db.prepare("INSERT INTO cards VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)")
        .run(child, project, id, JSON.stringify(card), cardHash(card), this.queuePlace(id), now);
      this.event(child, "card.drafted", { title: card.title, plan: id });
    });
    return id;
  }

  /** One yes approves a whole plan: the parent stands for the list, the children join the queue in order. */
  approvePlan(id: string): void {
    const children = this.children(id).filter((c) => c.state === "draft");
    this.move(id, "split", { children: children.map((c) => c.id) });
    for (const child of children) this.move(child.id, "approved");
  }

  getCard(id: string): CardRow {
    const row = this.db.prepare("SELECT * FROM cards WHERE id = ?").get(id) as Record<string, string> | undefined;
    if (!row) throw new Error(`No card ${id}`);
    const card = JSON.parse(row.card) as Card;
    if (cardHash(card) !== row.hash) throw new Error(`Card ${id} changed after approval; refusing it.`);
    return { id, project: row.project, parent: row.parent ?? null, card, hash: row.hash, state: row.state as CardState };
  }

  move(id: string, to: CardState, data: Record<string, unknown> = {}): void {
    const { state } = this.getCard(id);
    if (!NEXT[state].includes(to)) throw new Error(`Card ${id} cannot move from ${state} to ${to}`);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE cards SET state = ?, updated_at = ? WHERE id = ?").run(to, new Date().toISOString(), id);
      this.event(id, `card.${to}`, { from: state, ...data });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  event(card: string | null, kind: string, data: Record<string, unknown> = {}): void {
    this.db.prepare("INSERT INTO events (at, card, kind, data) VALUES (?, ?, ?, ?)")
      .run(new Date().toISOString(), card, kind, redact(JSON.stringify(data)));
  }

  events(card: string): { kind: string; data: Record<string, unknown> }[] {
    return (this.db.prepare("SELECT kind, data FROM events WHERE card = ? ORDER BY seq").all(card) as Record<string, string>[])
      .map((e) => ({ kind: e.kind, data: JSON.parse(e.data) }));
  }

  /**
   * The card the engine should work on now: an unfinished one first, then the oldest approved. A card
   * that comes after a choice in its plan waits until the owner has picked, so it never guesses the look.
   */
  next(): CardRow | null {
    const rows = this.db.prepare(`
      SELECT id FROM cards WHERE state IN ('testing','building','checking','approved')
      ORDER BY CASE state WHEN 'approved' THEN 1 ELSE 0 END, created_at`).all() as { id: string }[];
    for (const { id } of rows) {
      const row = this.getCard(id);
      if (row.state === "approved" && row.parent && this.waitsForPick(row)) continue;
      return row;
    }
    return null;
  }

  private waitsForPick(row: CardRow): boolean {
    const { created_at } = this.db.prepare("SELECT created_at FROM cards WHERE id = ?").get(row.id) as { created_at: string };
    const earlier = this.db.prepare("SELECT card, state FROM cards WHERE parent = ? AND created_at < ?").all(row.parent, created_at) as { card: string; state: string }[];
    return earlier.some((c) => JSON.parse(c.card).kind === "choice" && c.state !== "accepted");
  }


  children(parent: string): CardRow[] {
    return (this.db.prepare("SELECT id FROM cards WHERE parent = ? ORDER BY created_at").all(parent) as { id: string }[])
      .map((r) => this.getCard(r.id));
  }
}
