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
    "- Find things only the way a person would: by role and exact visible name (a button called Reject, a",
    "  heading, a label's text). Never by position, distance, size, element order, ancestors or CSS classes.",
    "  Where the card does not name a label, choose a plain one; the builder will be told your names.",
    "- Check visible words and that controls work. Never require particular markup: no list items, element",
    "  types, ARIA roles other than button, link, heading, textbox and checkbox, no classes or styles. How it",
    "  looks is judged separately from screenshots, so a test must pass however the screen is laid out.",
    "- Any implementation a reasonable person would accept from this card must pass the test.",
    "- If the test drives a screen, save a screenshot at the end of every watched step, named step-1.png,",
    "  step-2.png, ... in the test's output folder (Playwright: page.screenshot({ path: test.info().outputPath('step-1.png') })).",
    ...(example ? [`- Follow the structure and helpers of the existing test ${example}.`] : []),
    ...(notes ? ["", "How acceptance tests run in this project:", notes] : []),
    "",
    "An independent reviewer will reject the test unless:",
    ...FAIR_TEST_RULES,
    ...(feedback.length ? ["", "Earlier versions of your test were rejected for these reasons; avoid all of them:", ...feedback.map((f) => `- ${f}`)] : []),
    "",
    "When done, answer with a one-sentence summary of what the test checks, and every exact visible name",
    "the test relies on (button names, headings, labels, texts), so the builder can use exactly those words.",
  ].join("\n");
}

/** What makes a hidden test fair. The test author writes to these and the card check judges by them. */
export const FAIR_TEST_RULES = [
  "- every watched step has a test step, in order, that checks what that step promises, about the thing it names",
  "  (e.g. a label is checked on the named feature's own row, not anywhere on the page);",
  "- it checks nothing the card does not promise, and nothing under Not included;",
  "- a correct implementation of the card could pass it, however it is reasonably built, and an empty one could not.",
];

export const TEST_NAMES_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "names"],
  properties: {
    summary: { type: "string" },
    names: { type: "array", items: { type: "string" } },
  },
};

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

export function builderPrompt(card: Card, allowed: string[], facts: string[], notes?: string, names: string[] = []): string {
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
    ...(names.length ? ["", "The acceptance test finds things on screen by these exact visible names; use them exactly:", ...names.map((n) => `- "${n}"`)] : []),
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

export function lookPrompt(card: Card, stepShots: boolean): string {
  return [
    "Look at these screenshots of a finished feature and judge how it looks, for the person who will use it.",
    stepShots
      ? "Screenshot step-N.png shows the screen at the end of watched step N, in order."
      : "The screenshots show the screen at the end of the test, after every watched step has happened.",
    "Judge only what this card adds or changes on the screen; the rest of the page is out of scope.",
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

export function reportPrompt(card: Card, out: string, liveNotes: string | undefined, facts: string[]): string {
  return [
    "Do this piece of work in the current project and write a report on it. The report is the deliverable;",
    "change nothing in the project that is meant to last (any helper files you write are thrown away).",
    "",
    cardText(card),
    "",
    `Write the report as Markdown to ${out}/report.md, with one section per watched step, in order, plus a`,
    "short summary at the top. Write in the owner's plain words, with concrete examples and quotes from what",
    `actually happened. Save any screenshots or transcripts that support it in ${out} and link them from the report.`,
    "Do the work for real: actually run things and report what happened, never what probably would happen.",
    ...(liveNotes ? ["", "How to run the real product here:", liveNotes] : []),
    ...(facts.length ? ["", "Fix these problems from the last attempt:", ...facts.map((f) => `- ${f}`)] : []),
    "",
    "When done, reply with the report's summary in at most three sentences.",
  ].join("\n");
}

export function reportReviewPrompt(card: Card, report: string): string {
  return [
    "Review this report against the card that asked for it. Mark a finding blocking only if the report",
    "misses something the card asked for, claims things it did not show evidence for, or is hard for the",
    "owner to read. Each finding is one plain sentence. Say 'fix' only if at least one finding is blocking.",
    "",
    cardText(card),
    "",
    "Report:",
    report.length > 150_000 ? `${report.slice(0, 150_000)}\n[truncated]` : report,
  ].join("\n");
}

export function choicePrompt(card: Card, out: string, notes: string | undefined): string {
  return [
    "Make 3 clearly different visual options for the owner to choose from. Study the current product first",
    "(its screens, real content and purpose), then design each option as a polished, self-contained HTML page",
    "(inline CSS, no external files except web fonts) showing the product's main screen with its real content.",
    "Use your design skills (for example impeccable or taste) to make each option distinct and high quality,",
    "not three variations of one idea. Change nothing in the project.",
    "",
    cardText(card),
    "",
    `Write ${out}/option-1.html, ${out}/option-2.html and ${out}/option-3.html, and for each a one-line`,
    `description in ${out}/option-1.txt (and -2, -3) naming the direction in plain words, e.g. "Calm and editorial".`,
    ...(notes ? ["", "About this project:", notes] : []),
    "",
    "When done, reply with the three one-line descriptions.",
  ].join("\n");
}

export const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["visual", "reason"],
  properties: { visual: { type: "boolean" }, reason: { type: "string" } },
};

export function classifyPrompt(card: Card): string {
  return [
    "Is this card about how screens LOOK (a restyle: layout, typeface, colours, spacing, phone fit) rather than",
    "what they DO (new behaviour, new data, new controls)? Answer visual: true only if every watched step could",
    "be judged from screenshots alone and today's screens already do what the steps describe, just not looking",
    "the way the card wants. Give a one-sentence reason.",
    "",
    cardText(card),
  ].join("\n");
}

/** A tour for a restyle card: visits each screen at laptop and phone size and saves screenshots. */
export function tourPrompt(card: Card, testFile: string, example: string | undefined, feedback: string[], notes?: string): string {
  return [
    "This card changes how screens look, not what they do. Write a tour test for it. Another agent will restyle",
    "the screens without seeing your test; the tour runs before and after, and a reviewer judges the screenshots.",
    "",
    cardText(card),
    "",
    `Write exactly one test file at ${testFile}. Create no other files and change nothing else.`,
    "Rules:",
    "- One test step per watched step, in order, titled with that step's words.",
    "- In each step, open the screen(s) it names at a laptop size (1280x860) and then a phone size (390x844),",
    "  check that the words and controls the step names are present and work, and save screenshots named",
    "  step-<n>-laptop.png and step-<n>-phone.png in the test's output folder",
    "  (Playwright: page.screenshot({ path: test.info().outputPath('step-1-laptop.png'), fullPage: true })).",
    "- Never check appearance (fonts, colours, layout, sizes): the screenshots are judged separately.",
    "- The tour must pass on today's code as well as after the restyle.",
    "- Find things only by role and exact visible name, or exact visible text.",
    ...(example ? [`- Follow the structure and helpers of the existing test ${example}.`] : []),
    ...(notes ? ["", "How tests run in this project:", notes] : []),
    ...(feedback.length ? ["", "Earlier versions were rejected for these reasons; avoid all of them:", ...feedback.map((f) => `- ${f}`)] : []),
    "",
    "When done, answer with a one-sentence summary and every exact visible name the tour relies on.",
  ].join("\n");
}

export function tourCheckPrompt(card: Card, testSource: string): string {
  return [
    "Check whether this tour test fits the restyle card. It fits when: every watched step has a tour step, in",
    "order, that opens the screens the step names at a laptop and a phone size and saves step-N-laptop.png and",
    "step-N-phone.png; it checks only that named words and controls are present and work (never appearance);",
    "and it would pass on today's screens as well as after any reasonable restyle.",
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
