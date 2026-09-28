# Peeraxis

Peeraxis runs coding agents for you. You describe a feature and approve one card. Peeraxis
tests it, builds it, checks it and records a demo. Once a day you watch the recordings and
accept or reject each one. You never run a command, read code, rule on a review finding, or
tell an agent to continue.

This file is the only process document. Everything else is code. Keep it under 150 lines.

## Words

- **Card**: one feature, as you approved it. It has a title, Before/After, what you'll watch,
  what's not included, and for screen changes a short look brief. Once approved it is frozen.
  Work found later goes on a separate list and never widens the card.
- **Step**: a piece of a card that the builder works on. You never see steps.
- **Run**: one attempt at one step, in an isolated copy of the project.
- **Event**: a record of one change of state, written by the engine. The event log is
  the single source of truth for what happened and when.
- **Waiting branch**: one branch per project (`peeraxis/waiting`) where finished features
  wait for your verdict. Main moves only when you accept.
- **Digest**: the once-a-day message listing the features ready to watch.
- **Parked**: a card or step that could not be finished, with one plain sentence saying why.
  Parking is an honest outcome. The agent never has to fake "done".
- **Plug-in**: `.peeraxis/project.json` in a project. It says how to set the project up,
  check it, demo it, and which files may change. It is the only project-specific part.

## Decisions that are expensive to reverse

**1. Rebuilt from scratch (2026-09-27).** The first Peeraxis (now `~/git/ai-profiles`) was
built around hand-written locked tests and a chat that coordinated by following a long
runbook. The rules that kept breaking were all rules for that chat. So here a program owns
every transition, and chat sessions are advisors only. The old code contributed ideas only:
clone isolation, a clean process boundary, compare-and-swap landing, a litter check, and the
plug-in and demo contract.

**2. TypeScript on the Claude Agent SDK and the Codex SDK.** The SDKs give structured events and
let the engine block a forbidden action as it's attempted (`canUseTool`), instead of checking a
diff afterwards. The engine is a background service (launchd). It stores cards, steps, runs and
events in SQLite and serves a local page. A small Dock app shows that page, so updating Peeraxis
never needs a reinstall.

**3. Hidden tests.** A model other than the builder writes the acceptance test from the card.
The test lives outside the build copy, must fail before the build, and must match the card.
The builder cannot read or edit it. Agents that can see tests edit them to pass.

**4. Cross-family checks.** Whatever builds is never checked by its own model family. Every
model is pinned in code; nothing runs on a default.

| Job | Model |
|---|---|
| Intake questions and card↔test check | Fable 5.1 |
| Build | Opus 5.5 |
| Write hidden test, review code, review looks | Codex gpt-6-astra |

Never Claude Opus 5. Other providers are added later, through the same models table, once
they pass the same trial features.

**5. One feature at a time.** Features run one at a time on one project until the success
number below is good. Then they run several at once, across projects.

## The loop

1. **Intake.** You type one sentence. Fable asks at most 3 product questions per round, for
   at most 2 rounds, each with a recommended answer. If a feature needs more, it is too big,
   and Peeraxis proposes a split.
2. **Approve.** You say yes to one card. The engine freezes it.
3. **Test.** Codex writes the hidden test. The engine checks that it fails today. Fable checks
   that it matches the card. If either check fails, the test is rewritten, never the card.
4. **Build.** Opus builds in an isolated clone and may only touch the plug-in's allowed files.
   Checks print nothing when they pass and only the error when they fail. Each step gets
   2 tries. After that, a fresh model reads the failure and splits the step or parks it.
5. **Check.** The hidden test is copied in and must pass. Codex reviews the change in a fresh
   session with the proof in front of it, and reviews the screenshots against the look brief
   for screen changes. Findings go back to the builder once. They never go to you.
   The code-health numbers must not get worse.
6. **Land.** The work goes onto the waiting branch, and the next approved card starts.
7. **Digest.** One Mac notification a day. Accept fast-forwards main. Reject turns your reason
   into a new card.

## Usage limits

Each job has a main and a backup model. You can change them on the Models page at any time
(in a JSON file until that page exists); a change takes effect from the next step.

| When | Default |
|---|---|
| Opus 5.5 is out, the rest of Claude is fine | Fable 5.1 builds, Codex still checks |
| All of Claude is out | Codex Sol builds; tests and reviews wait for Claude |
| Codex is out | Claude keeps building; tests and reviews queue until Codex is back |
| Both are out | Pause, then resume at reset |

The engine refuses any setting where the builder and its checker are the same family, unless
you explicitly allow it. Anything done that way is labelled in the digest. Every switch is
noted in the digest.

## Measures

- **Success number:** your minutes and messages per accepted feature, on a real project,
  read from the event log and shown on the status page.
- **Code health:** lint warnings, complexity, largest file, test time and dependency count.
  A feature that makes them worse goes back to the builder. A cleanup card is queued monthly.

## Guards against rebuilding the old machinery

- No runbook, no handoff document, no hooks that judge chat replies.
- A new check is added only by naming the real run it would have caught.
- A chat never starts a feature or moves one between states.
- Each milestone has a checklist written before building starts and gets at most 2 sessions.
  If it isn't demoed by then, work stops and the owner hears one short account of what broke.

## Milestones

- **M1, core engine (built directly):** queue and event log, isolated build, pinned models,
  hidden test, file blocking, 2 tries then split or park, review, code-health check, and
  landing on the waiting branch. Demo: a hand-written Persuaider card delivered as a
  recording with no owner message.
- **M2 (built by the engine):** look review, the local page with queue, status, digest and
  accept/reject, and the daily notification.
- **M3 (built by the engine):** intake and card approval, the Models page, the Dock app,
  and the monthly cleanup card.
- **M4, proof:** Persuaider's next 2–3 real features accepted with zero owner messages
  between approval and digest.
