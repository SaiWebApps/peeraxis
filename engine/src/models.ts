// Which model does which job, with backups for usage limits. Every call names its model;
// nothing runs on a default. Editable in models.json (the Models page replaces it in M3).
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type Family = "claude" | "codex";
export type Role = "intake" | "cardCheck" | "builder" | "testAuthor" | "reviewer" | "lookReviewer" | "splitter";
export type Model = { family: Family; id: string };

export type ModelsConfig = {
  /** Per job: the main model first, then backups in the order to try them. */
  roles: Record<Role, Model[]>;
  /** Run a check from the family it is checking, labelled in the digest (default: wait instead). */
  allowSameFamilyChecks: boolean;
};

const opus: Model = { family: "claude", id: "claude-opus-5-5" };
const fable: Model = { family: "claude", id: "claude-fable-5-1" };
const astra: Model = { family: "codex", id: "gpt-6-astra" };
const sol: Model = { family: "codex", id: "gpt-6-sol" };

// Defaults agreed with the owner on 2026-09-27 (DESIGN.md, Usage limits).
export const DEFAULT_MODELS: ModelsConfig = {
  roles: {
    intake: [fable, astra],
    cardCheck: [fable, opus],
    builder: [opus, fable, sol],
    testAuthor: [astra, fable],
    reviewer: [astra, fable],
    lookReviewer: [astra, fable],
    splitter: [fable, astra],
  },
  allowSameFamilyChecks: false,
};

const BANNED = [/^claude-opus-5(?!-5)/, /^opus$/]; // Opus 5, and the bare alias that may resolve to it

export function assertAllowed(model: Model): void {
  if (!model.id?.trim()) throw new Error("Every call must name its model.");
  if (BANNED.some((re) => re.test(model.id))) throw new Error(`Model ${model.id} is banned.`);
}

export function loadModels(file: string): ModelsConfig {
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULT_MODELS, null, 2));
    return DEFAULT_MODELS;
  }
  const config = JSON.parse(readFileSync(file, "utf8")) as ModelsConfig;
  for (const models of Object.values(config.roles)) models.forEach(assertAllowed);
  return config;
}

/** Usage limits currently hit: model id or family name → when it is expected back (ms since epoch). */
export type Limits = Record<string, number>;

const backAt = (limits: Limits, m: Model) => Math.max(limits[m.id] ?? 0, limits[m.family] ?? 0);

export type Pick =
  | { kind: "run"; model: Model; label?: string }
  | { kind: "wait"; until: number; reason: string };

/**
 * Chooses the model for a job right now. `avoid` is the family this job must not share
 * (the builder's, for a checker; the test author's, for the builder). A same-family model
 * is used only if allowSameFamilyChecks is on, and then the pick carries a label.
 */
export function pick(config: ModelsConfig, role: Role, limits: Limits, avoid?: Family, now = Date.now()): Pick {
  const models = config.roles[role];
  let sameFamily: Model | undefined;
  for (const model of models) {
    if (backAt(limits, model) > now) continue;
    if (avoid && model.family === avoid) {
      sameFamily ??= model;
      continue;
    }
    return { kind: "run", model };
  }
  if (sameFamily && config.allowSameFamilyChecks) {
    return { kind: "run", model: sameFamily, label: `${role} ran on ${sameFamily.id}, the same family it checks` };
  }
  const until = Math.min(...models.map((m) => backAt(limits, m)).filter((t) => t > now));
  return {
    kind: "wait",
    until: Number.isFinite(until) ? until : now + 15 * 60_000,
    reason: `no model for ${role} is available${avoid ? ` outside the ${avoid} family` : ""}`,
  };
}
