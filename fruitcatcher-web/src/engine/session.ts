// One visit: plays the parts one after another (like main() in the Python version).
import { SEQUENCE, type Settings } from "./config";
import { Game, KeyState, type Carry, type GameUI } from "./game";
import type { SoundEngine } from "./audio";
import type { Ctx } from "./draw";
import type { Tracker } from "./tracker";
import type { Group, PartResult, Progress } from "./types";

export interface VisitOpts {
  ctx: Ctx; tracker: Tracker; audio: SoundEngine; ui: GameUI; keys: KeyState;
  group: Group; progress: Progress; settings: Settings;
  startPart: number; painBefore: number | null;
  /** Called after every part, with the patient's updated progress. Must save both. */
  onPartDone(result: PartResult, progress: Progress): Promise<void>;
}

export function newVisitId() {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export async function runVisit(o: VisitOpts) {
  const visitId = newVisitId();
  const done = new Set<number>();
  let carry: Carry | null = null;
  let part = o.startPart;
  let first = true;
  while (part < SEQUENCE.length) {
    const game = new Game({
      ctx: o.ctx, tracker: o.tracker, audio: o.audio, ui: o.ui, group: o.group, progress: o.progress,
      settings: o.settings, part, visitId, carry, painBefore: first ? o.painBefore : null, done, keys: o.keys,
    });
    first = false;
    const { next, carry: c, result } = await game.run();
    carry = c;
    await o.onPartDone(result, o.progress);
    if (next === "jump" && o.keys.jump !== null) {
      part = o.keys.jump;
      o.keys.jump = null;
      continue;
    }
    if (next !== "next") break;
    part += 1;
  }
}
