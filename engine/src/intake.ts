// Intake: one typed sentence, however vague, becomes a drafted plan. The intake model asks at most 3
// product questions, each with a recommended answer, then drafts an ordered list of small cards
// (one card when that is all it takes) that the owner approves with one yes.
// When PEERAXIS_INTAKE_SCRIPT names a JSON file, its questions and card are used instead of a model.
import { readFileSync } from "node:fs";
import { type Card, type Store, validateCard } from "./db.ts";
import { cardText } from "./jobs.ts";
import { DEFAULT_MODELS, loadModels, pick, type ModelsConfig } from "./models.ts";
import { runAgent, type AgentRunner } from "./agents.ts";

export type Question = { question: string; recommended: string; options: string[] };
export type Answered = { question: string; answer: string };

export type Plan = { title: string; before: string; after: string; cards: Card[] };

export type Intake = {
  ask(sentence: string, project: string): Promise<Question[]>;
  draft(sentence: string, project: string, answered: Answered[]): Promise<Plan>;
};

/** Stores a drafted plan: a single card as itself, several as a plan the owner approves once. */
export function storeDraft(store: Store, project: string, plan: Plan): string {
  return plan.cards.length === 1 ? store.draft(project, plan.cards[0]) : store.draftPlan(project, plan);
}

export const MAX_QUESTIONS = 3;

/** Keeps at most 3 questions, each offering its recommended answer first and only once. */
export function tidy(questions: Question[]): Question[] {
  return questions.slice(0, MAX_QUESTIONS).map((q) => ({
    question: q.question,
    recommended: q.recommended,
    options: [q.recommended, ...q.options.filter((o) => o !== q.recommended)],
  }));
}

function checked(plan: Plan): Plan {
  if (!plan.cards?.length) throw new Error("The drafted plan had no cards.");
  for (const card of plan.cards) {
    const problem = validateCard(card);
    if (problem) throw new Error(`The drafted card "${card.title}" was not usable: ${problem}`);
  }
  return plan;
}

export function scriptedIntake(file: string): Intake {
  const script = () => JSON.parse(readFileSync(file, "utf8")) as { questions: Question[]; card?: Card; plan?: Plan };
  return {
    ask: async () => tidy(script().questions),
    draft: async () => {
      const { card, plan } = script();
      return checked(plan ?? { title: card!.title, before: card!.before, after: card!.after, cards: [card!] });
    },
  };
}

const QUESTIONS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: {
    questions: {
      type: "array",
      maxItems: MAX_QUESTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["question", "recommended", "options"],
        properties: {
          question: { type: "string" },
          recommended: { type: "string" },
          options: { type: "array", minItems: 2, maxItems: 4, items: { type: "string" } },
        },
      },
    },
  },
};

const CARD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "title", "before", "after", "watch", "notIncluded", "look"],
  properties: {
    kind: { type: "string", enum: ["change", "report", "choice"] },
    title: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    watch: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
    notIncluded: { type: "array", items: { type: "string" } },
    look: { type: "string" },
  },
};

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "before", "after", "cards"],
  properties: {
    title: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    cards: { type: "array", minItems: 1, maxItems: 8, items: CARD_SCHEMA },
  },
};

export function questionsPrompt(sentence: string): string {
  return [
    "The owner of this project typed one sentence describing a new feature:",
    `"${sentence}"`,
    "",
    `Ask at most ${MAX_QUESTIONS} product questions whose answers change what the owner will see.`,
    "Ask none if the sentence is already clear. Never ask about code or implementation.",
    "Each question is one plain sentence with 2 to 4 short answers; recommend the answer you",
    "would pick, and include it among the answers.",
  ].join("\n");
}

export function draftPrompt(sentence: string, answered: Answered[]): string {
  return [
    "The owner of this project typed one sentence describing what they want:",
    `"${sentence}"`,
    ...(answered.length ? ["", "They answered these questions:", ...answered.map((a) => `- ${a.question} ${a.answer}`)] : []),
    "",
    "Turn it into a plan the owner approves once: an ordered list of 1 to 8 small cards that together",
    "deliver everything they asked for. Read the project first so the plan fits what exists. Vague or big",
    "requests are expected; breaking them down is your job, not the owner's. Use one card when that is all",
    "it takes. Each card is one of three kinds:",
    "- change: a change to the product, proved by watching it work;",
    "- report: work whose result is a written report, e.g. running the product end to end and reporting",
    "  what went well and what could be better (the report is the deliverable; no code changes);",
    "- choice: when the owner's taste decides the direction (how things should look), a card that makes",
    "  3 clearly different visual options for the owner to pick from. Put it before the cards that depend on it.",
    "",
    "For the plan: a title, and one sentence each for before and after, in the owner's plain words.",
    "For each card, in the owner's plain words:",
    "- title: what it does, at most 80 characters;",
    "- before / after: one sentence each, what the owner sees today and after it;",
    "- watch: 1 to 4 steps the owner will watch, in order. Each names exact words or labels they will see",
    "  on screen (for a report: the sections the report will have). Never a step about internals;",
    "- notIncluded: nearby things this card does not do;",
    "- look: for screen changes, a short look brief (who uses it, what matters most); otherwise \"\".",
    "",
    "For the shape of a card, here is an example:",
    cardText({ title: "Title is bold", before: "The page title is plain.", after: "The page title is bold.", watch: ["Open the page and see the title in bold"], notIncluded: ["Other headings"] }),
  ].join("\n");
}

export function modelIntake(models: () => ModelsConfig, agent: AgentRunner): Intake {
  const run = async (project: string, prompt: string, schema: Record<string, unknown>): Promise<unknown> => {
    const choice = pick(models(), "intake", {});
    if (choice.kind === "wait") throw new Error(`Peeraxis cannot ask questions right now: ${choice.reason}.`);
    const result = await agent({ model: choice.model, cwd: project, prompt, minutes: 10, write: false, schema });
    if (!result.ok || !result.json) throw new Error(`The intake model did not answer (${result.error ?? "no answer"}). Try again.`);
    return result.json;
  };
  return {
    ask: async (sentence, project) =>
      tidy(((await run(project, questionsPrompt(sentence), QUESTIONS_SCHEMA)) as { questions: Question[] }).questions),
    draft: async (sentence, project, answered) => {
      const plan = (await run(project, draftPrompt(sentence, answered), PLAN_SCHEMA)) as Plan;
      plan.cards = plan.cards.map((c) => ({ ...c, look: c.look?.trim() || undefined }));
      return checked(plan);
    },
  };
}

/** The scripted intake when PEERAXIS_INTAKE_SCRIPT is set, otherwise the intake model from models.json. */
export function defaultIntake(modelsFile?: string): Intake {
  const script = process.env.PEERAXIS_INTAKE_SCRIPT;
  if (script) return scriptedIntake(script);
  return modelIntake(() => (modelsFile ? loadModels(modelsFile) : DEFAULT_MODELS), runAgent);
}
