// The two ways the engine runs a model: the Claude Agent SDK and the Codex SDK.
// Both return the same shape, including a usage-limit signal the engine turns into a wait.
import { query, type CanUseTool, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { Codex } from "@openai/codex-sdk";
import { copyFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertAllowed, type Model } from "./models.ts";
import { stageEnv, stageTmp } from "./proc.ts";
import { redact } from "./redact.ts";

export type AgentRun = {
  model: Model;
  cwd: string;
  prompt: string;
  minutes: number;
  write: boolean; // may the agent change files in cwd?
  schema?: Record<string, unknown>; // ask for a JSON answer in this shape
  canUseTool?: CanUseTool; // Claude only: decides every tool call
};

export type AgentResult = {
  ok: boolean;
  text: string;
  json?: unknown;
  limitUntil?: number; // set when the model hit a usage limit
  error?: string;
};

export type AgentRunner = (run: AgentRun) => Promise<AgentResult>;

const CLAUDE = process.env.PEERAXIS_CLAUDE ?? join(homedir(), ".local/bin/claude");
const CODEX = process.env.PEERAXIS_CODEX ?? join(homedir(), ".local/bin/codex");

export const runAgent: AgentRunner = (run) => {
  assertAllowed(run.model);
  return run.model.family === "claude" ? runClaude(run) : runCodex(run);
};

async function runClaude(run: AgentRun): Promise<AgentResult> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), run.minutes * 60_000);
  let limitUntil: number | undefined;
  let final: Extract<SDKMessage, { type: "result" }> | undefined;
  try {
    const messages = query({
      prompt: run.prompt,
      options: {
        model: run.model.id,
        cwd: run.cwd,
        pathToClaudeCodeExecutable: CLAUDE,
        env: stageEnv({ TMPDIR: stageTmp() }),
        settingSources: [], // never the owner's settings, hooks or memories
        persistSession: false,
        strictMcpConfig: true,
        mcpServers: {},
        tools: run.write
          ? ["Read", "Edit", "Write", "Glob", "Grep", "Bash", "TodoWrite"]
          : ["Read", "Glob", "Grep"],
        permissionMode: "default",
        canUseTool: run.canUseTool ?? readOnlyInside(run.cwd),
        maxTurns: 400,
        abortController: abort,
        ...(run.schema ? { outputFormat: { type: "json_schema" as const, schema: run.schema } } : {}),
      },
    });
    for await (const message of messages) {
      if (message.type === "rate_limit_event" && message.rate_limit_info?.status === "rejected") {
        const resets = message.rate_limit_info.resetsAt;
        limitUntil = resets ? resets * (resets < 1e12 ? 1000 : 1) : Date.now() + 60 * 60_000;
      }
      if (message.type === "result") final = message;
    }
  } catch (error) {
    return { ok: false, text: "", limitUntil, error: abort.signal.aborted ? `timed out after ${run.minutes} minutes` : redact(String(error)) };
  } finally {
    clearTimeout(timer);
  }
  if (!final) return { ok: false, text: "", limitUntil, error: "no result" };
  if (final.subtype !== "success" || final.is_error) {
    const text = "errors" in final ? final.errors.join("\n") : final.result;
    if (!limitUntil && /rate.?limit|usage limit|429/i.test(text)) limitUntil = Date.now() + 60 * 60_000;
    return { ok: false, text: redact(text), limitUntil, error: final.subtype };
  }
  return { ok: true, text: redact(final.result), json: final.structured_output };
}

async function runCodex(run: AgentRun): Promise<AgentResult> {
  const home = codexHome();
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), run.minutes * 60_000);
  try {
    const codex = new Codex({ codexPathOverride: CODEX, env: stageEnv({ CODEX_HOME: home.dir, TMPDIR: stageTmp() }) });
    const thread = codex.startThread({
      model: run.model.id,
      workingDirectory: run.cwd,
      skipGitRepoCheck: true,
      sandboxMode: run.write ? "workspace-write" : "read-only",
      approvalPolicy: "never",
      webSearchMode: "disabled",
      networkAccessEnabled: false,
    });
    const turn = await thread.run(run.prompt, { signal: abort.signal, ...(run.schema ? { outputSchema: run.schema } : {}) });
    const text = redact(turn.finalResponse);
    let json: unknown;
    if (run.schema) {
      try { json = JSON.parse(turn.finalResponse); } catch { return { ok: false, text, error: "answer was not the requested JSON" }; }
    }
    return { ok: true, text, json };
  } catch (error) {
    const message = redact(String(error));
    const limited = /usage limit|rate.?limit|429|quota/i.test(message);
    return {
      ok: false,
      text: "",
      error: abort.signal.aborted ? `timed out after ${run.minutes} minutes` : message,
      ...(limited ? { limitUntil: parseRetryAt(message) } : {}),
    };
  } finally {
    clearTimeout(timer);
    home.close();
  }
}

/** A private CODEX_HOME with only the login copied in, so the owner's hooks and MCP servers never run. */
function codexHome(): { dir: string; close: () => void } {
  const dir = join(stageTmp(), "codex-home");
  mkdirSync(dir, { recursive: true });
  const owner = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "auth.json");
  const mine = join(dir, "auth.json");
  if (existsSync(owner)) copyFileSync(owner, mine);
  writeFileSync(join(dir, "config.toml"), "");
  const copied = existsSync(mine) ? statSync(mine).mtimeMs : 0;
  return {
    dir,
    // A refreshed login is copied back, so the owner's own Codex keeps working.
    close: () => {
      if (existsSync(mine) && statSync(mine).mtimeMs > copied) copyFileSync(mine, owner);
    },
  };
}

function parseRetryAt(message: string): number {
  const minutes = /try again in (\d+)\s*min/i.exec(message);
  if (minutes) return Date.now() + Number(minutes[1]) * 60_000;
  const at = /try again at ([^.\n]+)/i.exec(message);
  const parsed = at ? Date.parse(at[1]) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now() + 60 * 60_000;
}

/** Default Claude permission policy: read anything inside cwd, nothing else. */
export function readOnlyInside(cwd: string): CanUseTool {
  return async (tool, input) => {
    const path = String(input.file_path ?? input.path ?? input.pattern ?? "");
    if (["Read", "Glob", "Grep"].includes(tool) && (!path.startsWith("/") || path.startsWith(cwd + "/") || path === cwd)) {
      return { behavior: "allow", updatedInput: input };
    }
    return { behavior: "deny", message: `${tool} is not allowed here.` };
  };
}
