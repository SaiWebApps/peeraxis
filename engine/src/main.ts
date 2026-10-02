// Entry point. `run` is the background service (started by launchd); the other commands are
// for setting it up and for feeding it cards until the app screens exist (M2/M3).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Store, type Card } from "./db.ts";
import { Engine, Wait } from "./engine.ts";
import { loadModels } from "./models.ts";
import { runAgent } from "./agents.ts";
import { loadPlugin } from "./plugin.ts";
import { accept, reject } from "./verdict.ts";
import { serve } from "./server.ts";
import { dailyDigest } from "./digest.ts";

const DATA = process.env.PEERAXIS_HOME ?? join(homedir(), "Library", "Application Support", "Peeraxis Engine");
const LABEL = "com.saiwebapps.peeraxis";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function open(): Store {
  mkdirSync(DATA, { recursive: true });
  return new Store(join(DATA, "peeraxis.sqlite"));
}

/** True if `pid` is alive and is a Peeraxis engine (`main.ts run`), not some reused id. */
export function engineRunning(pid: number): boolean {
  if (!pid || pid === process.pid) return false;
  try {
    const command = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
    return /main\.ts run\b/.test(command);
  } catch {
    return false;
  }
}

async function run(): Promise<void> {
  const lock = join(DATA, "engine.pid");
  mkdirSync(DATA, { recursive: true });
  if (existsSync(lock)) {
    const pid = Number(readFileSync(lock, "utf8"));
    // After a restart the old id may belong to an unrelated process, so check what it runs.
    if (engineRunning(pid)) { console.error(`Engine already running (pid ${pid}).`); process.exit(1); }
  }
  writeFileSync(lock, String(process.pid));
  const store = open();
  const modelsFile = join(DATA, "models.json");
  const engine = new Engine({ store, dataDir: DATA, models: () => loadModels(modelsFile), agent: runAgent });
  store.event(null, "engine.started", { pid: process.pid });
  // The daily check runs on its own timer, so long builds and model-limit sleeps never skip a day.
  const check = () => { try { dailyDigest(store); } catch (error) { store.event(null, "digest.error", { message: String(error) }); } };
  check();
  setInterval(check, 60_000);
  for (;;) {
    try {
      if (!(await engine.step())) await sleep(30_000);
    } catch (error) {
      if (error instanceof Wait) await sleep(Math.max(60_000, error.until - Date.now()));
      else { store.event(null, "engine.error", { message: String(error) }); await sleep(60_000); }
    }
  }
}

function add(project: string, cardFile: string): void {
  const root = resolve(project);
  loadPlugin(root); // refuse projects without a valid plug-in
  const card = JSON.parse(readFileSync(cardFile, "utf8")) as Card;
  console.log(open().approve(root, card));
}

/** Accepts the card whose id starts with `prefix`. */
function find(prefix: string): string {
  const rows = open().db.prepare("SELECT id FROM cards WHERE id LIKE ?").all(`${prefix}%`) as { id: string }[];
  if (rows.length !== 1) throw new Error(`${rows.length} cards match ${prefix}`);
  return rows[0].id;
}

function status(): void {
  const rows = open().db.prepare("SELECT id, state, card, updated_at FROM cards ORDER BY created_at").all() as Record<string, string>[];
  for (const r of rows) console.log(`${r.state.padEnd(9)} ${JSON.parse(r.card).title}  (${r.id.slice(0, 8)}, ${r.updated_at})`);
}

/** Installs two login services: the engine (`run`) and the page the Dock app shows (`serve`, port 4477). */
function install(): void {
  mkdirSync(DATA, { recursive: true });
  service(LABEL, "run", "engine.log");
  service(`${LABEL}.page`, "serve", "page.log");
}

function service(label: string, command: string, log: string): void {
  const plist = join(homedir(), "Library", "LaunchAgents", `${label}.plist`);
  const main = resolve(import.meta.dirname, "main.ts");
  writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${process.execPath}</string><string>${main}</string><string>${command}</string></array>
  <key>WorkingDirectory</key><string>${resolve(import.meta.dirname, "../..")}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(DATA, log)}</string>
  <key>StandardErrorPath</key><string>${join(DATA, log)}</string>
</dict></plist>
`);
  const domain = `gui/${process.getuid!()}`;
  try { execFileSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }); } catch { /* not loaded */ }
  // bootout returns before the old service is gone; bootstrapping too early fails with an I/O error.
  for (let i = 0; i < 50; i++) {
    try { execFileSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }); } catch { break; }
    execFileSync("/bin/sleep", ["0.2"]);
  }
  execFileSync("launchctl", ["bootstrap", domain, plist]);
  console.log(`Installed and started ${label}.`);
}

const [command, ...args] = process.argv.slice(2);
if (command === "run") await run();
else if (command === "add" && args.length === 2) add(args[0], args[1]);
else if (command === "status") status();
else if (command === "accept" && args.length === 1) await accept(open(), find(args[0]));
else if (command === "reject" && args.length >= 2) await reject(open(), find(args[0]), args.slice(1).join(" "));
else if (command === "retry" && args.length >= 2) open().move(find(args[0]), "approved", { reason: args.slice(1).join(" ") });
else if (command === "serve") serve(open(), Number(process.env.PEERAXIS_PORT ?? 4477), join(DATA, "models.json"));
else if (command === "install") install();
else if (command === "digest") console.log(dailyDigest(open()) ?? "Nothing new to send today.");
else {
  console.error("usage: main.ts run | add <project> <card.json> | serve | digest | status | accept <id> | reject <id> <reason> | retry <id> <reason> | install");
  process.exit(2);
}
