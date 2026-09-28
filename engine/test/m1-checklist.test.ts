// M1 acceptance checklist, written before building (DESIGN.md: Guards). Covered items became
// real tests in engine.test.ts and units.test.ts; what is left needs the real machine.
import { test } from "node:test";

const todo = (name: string) => test(name, { todo: true });

todo("the engine runs as a launchd service and survives a restart");
todo("a hand-written Persuaider card reaches the waiting branch with real models and a recording, with no owner message");
