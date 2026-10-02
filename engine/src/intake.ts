// Intake: one typed sentence becomes a drafted card. The intake model asks at most 3 product
// questions, each with a recommended answer, then drafts the card from the sentence and answers.
// When PEERAXIS_INTAKE_SCRIPT names a JSON file, its questions and card are used instead of a model.
import { readFileSync } from "node:fs";
import { type Card, validateCard } from "./db.ts";
import { cardText } from "./jobs.ts";
import { DEFAULT_MODELS, loadModels, pick, type ModelsConfig } from "./models.ts";
import { runAgent, type AgentRunner } from "./agents.ts";

export type Question = { question: string; recommended: string; options: string[] };
export type Answered = { question: string; answer: string };

export type Intake = {
  ask(sentence: string, project: string): Promise<Question[]>;
  draft(sentence: string, project: string, answered: Answered[]): Promise<Card>;
};

export const MAX_QUESTIONS = 3;

/** Keeps at most 3 questions, each offering its recommended answer first and only once. */
export function tidy(questions: Question[]): Question[] {
  return questions.slice(0, MAX_QUESTIONS).map((q) => ({
    question: q.question,
    recommended: q.recommended,
    options: [q.recommended, ...q.options.filter((o) => o !== q.recommended)],
  }));
}

function checked(card: Card): Card {
  const problem = validateCard(card);
  if (problem) throw new Error(`The drafted card was not usable: ${problem}`);
  return card;
}

export function scriptedIntake(file: string): Intake {
  const script = () => JSON.parse(readFileSync(file, "utf8")) as { questions: Question[]; card: Card };
  return {
    ask: async () => tidy(script().questions),
    draft: async () => checked(script().card),
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
  required: ["title", "before", "after", "watch", "notIncluded"],
  properties: {
    title: { type: "string" },
    before: { type: "string" },
    after: { type: "string" },
    watch: { type: "array", minItems: 1, maxItems: 8, items: { type: "string" } },
    notIncluded: { type: "array", items: { type: "string" } },
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
    "The owner of this project typed one sentence describing a new feature:",
    `"${sentence}"`,
    ...(answered.length ? ["", "They answered these questions:", ...answered.map((a) => `- ${a.question} ${a.answer}`)] : []),
    "",
    "Draft one small feature card for it, in the owner's plain words:",
    "- title: what the feature does, at most 80 characters;",
    "- before / after: one sentence each, what the owner sees today and after the change;",
    "- watch: 1 to 8 steps the owner will watch in a recording, in order, naming exact words they will see;",
    "- notIncluded: nearby things this card does not do.",
    "",
    "For the shape, here is an example card:",
    cardText({ title: "Title is bold", before: "The page title is plain.", after: "The page title is bold.", watch: ["Open the page and see the title in bold"], notIncluded: ["Other headings"] }),
  ].join("\n");
}

export function modelIntake(models: () => ModelsConfig, agent: AgentRunner): Intake {
  const run = async (project: string, prompt: string, schema: Record<string, unknown>): Promise<unknown> => {
    const choice = pick(models(), "intake", {});
    if (choice.kind === "wait") throw new Error(`Peeraxis cannot ask questions right now: ${choice.reason}.`);
    const result = await agent({ model: choice.model, cwd: project, prompt, minutes: 5, write: false, schema });
    if (!result.ok || !result.json) throw new Error(`The intake model did not answer (${result.error ?? "no answer"}). Try again.`);
    return result.json;
  };
  return {
    ask: async (sentence, project) =>
      tidy(((await run(project, questionsPrompt(sentence), QUESTIONS_SCHEMA)) as { questions: Question[] }).questions),
    draft: async (sentence, project, answered) => checked((await run(project, draftPrompt(sentence, answered), CARD_SCHEMA)) as Card),
  };
}

/** The scripted intake when PEERAXIS_INTAKE_SCRIPT is set, otherwise the intake model from models.json. */
export function defaultIntake(modelsFile?: string): Intake {
  const script = process.env.PEERAXIS_INTAKE_SCRIPT;
  if (script) return scriptedIntake(script);
  return modelIntake(() => (modelsFile ? loadModels(modelsFile) : DEFAULT_MODELS), runAgent);
}
