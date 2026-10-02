// What each job asks its model, and the answers it expects back.
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import { matchesGlob, relative, resolve } from "node:path";
import type { Card } from "./db.ts";

export function cardText(card: Card): string {
  return [
    `Title: ${card.title}`,
    `Before: ${card.before}`,
    `After: ${card.after}`,
    "What the owner will watch, in order:",
    ...card.watch.map((step, i) => `  ${i + 1}. ${step}`),
    `Not included: ${card.notIncluded.length ? card.notIncluded.join("; ") : "(nothing listed)"}`,
    ...(card.look ? [`Look brief: ${card.look}`] : []),
  ].join("\n");
}

export function testAuthorPrompt(card: Card, testFile: string, example: string | undefined, feedback: string[], notes?: string): string {
  return [
    "You write the acceptance test for one feature card in this project. Another agent will build the",
    "feature later without ever seeing your test, so the test must describe the behaviour from the",
    "outside, the way a person using the product would check it.",
    "",
    cardText(card),
    "",
    `Write exactly one test file at ${testFile}. Create no other files and change nothing else.`,
    "Rules:",
    "- One test step per watched step, in the same order, titled with that step's words.",
    "- Each step asserts what the owner should see. Assert visible behaviour, not implementation details.",
    "- The feature does not exist yet, so the test must fail on the current code.",
    "- Do not test anything listed under Not included.",
    "- Check the exact words the card or the project's known data give. Never match free text with a",
    "  regular expression or a guess at its shape.",
    "- Find things the way a person would: by role and visible name (a button called Reject, a heading,",
    "  a label's text). Never depend on page structure such as ancestors, CSS classes or element order.",
    "- Any implementation a reasonable person would accept from this card must pass the test.",
    ...(example ? [`- Follow the structure and helpers of the existing test ${example}.`] : []),
    ...(notes ? ["", "How acceptance tests run in this project:", notes] : []),
    "",
    "An independent reviewer will reject the test unless:",
    ...FAIR_TEST_RULES,
    ...(feedback.length ? ["", "Earlier versions of your test were rejected for these reasons; avoid all of them:", ...feedback.map((f) => `- ${f}`)] : []),
    "",
    "When done, reply with one sentence saying what the test checks.",
  ].join("\n");
}

/** What makes a hidden test fair. The test author writes to these and the card check judges by them. */
export const FAIR_TEST_RULES = [
  "- every watched step has a test step, in order, that checks what that step promises, about the thing it names",
  "  (e.g. a label is checked on the named feature's own row, not anywhere on the page);",
  "- it checks nothing the card does not promise, and nothing under Not included;",
  "- a correct implementation of the card could pass it, however it is reasonably built, and an empty one could not.",
];

export const CARD_CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches", "problems"],
  properties: {
    matches: { type: "boolean" },
    problems: { type: "array", items: { type: "string" } },
  },
};

export function cardCheckPrompt(card: Card, testSource: string): string {
  return [
    "Check whether this acceptance test matches the approved feature card. It matches when:",
    ...FAIR_TEST_RULES,
    "List each concrete problem in one plain sentence. No style comments.",
    "",
    cardText(card),
    "",
    "Test:",
    "```",
    testSource,
    "```",
  ].join("\n");
}

export function builderPrompt(card: Card, allowed: string[], facts: string[], notes?: string): string {
  return [
    "Build this feature in the current project.",
    "",
    cardText(card),
    "",
    `You may change only files matching: ${allowed.join(", ")}.`,
    "An acceptance test you cannot see will check each watched step from the outside, then the",
    "project's full check (types, lint, tests, build) must pass. Keep changes small and in the style",
    "of the surrounding code. Do not add dependencies unless the card needs them. Do not commit.",
    ...(notes ? ["", "How the acceptance test will run:", notes] : []),
    ...(facts.length ? ["", "What went wrong last time (fix these):", ...facts.map((f) => `- ${f}`)] : []),
    "",
    "When done, reply with at most three plain sentences about what you changed.",
  ].join("\n");
}

export const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["pass", "fix"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["blocking", "text"],
        properties: { blocking: { type: "boolean" }, text: { type: "string" } },
      },
    },
  },
};

export function reviewPrompt(card: Card, diffText: string, proof: string): string {
  return [
    "Review this change against the approved feature card. The project's full check and the hidden",
    "acceptance test already passed; their results are below. You are read-only.",
    "Mark a finding blocking only if it is a real defect a user of the product would hit, a security",
    "problem, or the change does something the card did not ask for. Everything else is non-blocking.",
    "Say 'fix' only if at least one finding is blocking. Each finding is one plain sentence.",
    "",
    cardText(card),
    "",
    "Proof:",
    proof,
    "",
    "Change:",
    "```diff",
    diffText.length > 200_000 ? `${diffText.slice(0, 200_000)}\n[diff truncated]` : diffText,
    "```",
  ].join("\n");
}

export function lookPrompt(card: Card): string {
  return [
    "Look at these screenshots of a finished feature and judge how it looks, for the person who will use it.",
    "Judge against the look brief and these plain problems only: text that is cut off or overlaps, things that",
    "are hard to read, clutter or crowding, the main thing not standing out, or a mismatch with the brief.",
    "Mark a finding blocking only if a person would notice it straight away. Each finding is one plain sentence",
    "saying what is wrong where, e.g. \"The Reject box's hint text is cut off.\" No code advice.",
    "Say 'fix' only if at least one finding is blocking.",
    "",
    cardText(card),
  ].join("\n");
}

export const SPLIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["decision", "sentence", "cards"],
  properties: {
    decision: { type: "string", enum: ["split", "park"] },
    sentence: { type: "string" },
    cards: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "before", "after", "watch", "notIncluded"],
        properties: {
          title: { type: "string" },
          before: { type: "string" },
          after: { type: "string" },
          watch: { type: "array", items: { type: "string" } },
          notIncluded: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
};

export function splitPrompt(card: Card, failures: string[]): string {
  return [
    "A builder failed this feature card twice. Decide whether it can be split into 2 to 4 smaller cards",
    "that each deliver a visible part of it and together deliver exactly the card, or whether it should",
    "be parked because something outside the code is missing (a decision, a credential, a broken tool).",
    "Smaller cards may not add anything the card does not promise.",
    "In 'sentence', write one plain sentence the owner will read explaining the decision.",
    "",
    cardText(card),
    "",
    "Failures:",
    ...failures.map((f) => `- ${f}`),
  ].join("\n");
}

/** The builder may read and write inside its copy, write only allowed paths, and never touch the hidden store. */
export function builderPolicy(copy: string, allowed: string[], forbidden: string[]): CanUseTool {
  const inside = (p: string) => !relative(copy, p).startsWith("..");
  return async (tool, input) => {
    const deny = (message: string) => ({ behavior: "deny" as const, message });
    const text = JSON.stringify(input);
    if (forbidden.some((f) => text.includes(f))) return deny("That location is off limits.");
    if (tool === "Bash") {
      const command = String(input.command ?? "");
      if (/\bgit\s+(push|remote|fetch|clone|worktree|stash|checkout\s+-b|branch\s)/.test(command)) {
        return deny("Only edit files; the engine handles git.");
      }
      return { behavior: "allow", updatedInput: input };
    }
    const raw = String(input.file_path ?? input.notebook_path ?? input.path ?? "");
    const path = raw ? resolve(copy, raw) : copy;
    if (!inside(path)) return deny("Stay inside the project.");
    if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
      const rel = relative(copy, path);
      if (!allowed.some((glob) => matchesGlob(rel, glob))) return deny(`${rel} is outside the files this card may change.`);
    }
    return { behavior: "allow", updatedInput: input };
  };
}
