// The game: one part (3, 5, 6 or 8 notes), ported from the Game class in fruitcatcher_1cam.py.
// Each Python "while ...: img = self.step(); ...; show(img)" loop becomes "await this.step()".
//
// Changes from the Python version (agreed "fix the gaps"):
//  - the heat map carries over between parts and sessions (Settings.heatCarry) instead of resetting
//  - automatic level changes are on: the next session starts at Progress.level
//  - the catch model's Brier score is computed only over fruits where the model was switched on
//  - target catch chance, posture limits, daily goal and the stroke assist are settings
import { CatchModel, fixedSequence, makePath, Pheromone, Spawner, type Spawn } from "./adaptive";
import { SoundEngine, instrumentName } from "./audio";
import {
  ANTIC_STAGES, ANTIC_TAIL, ANTIC_UNLOCK_MIN, ANTIC_UNLOCK_RATE, BRIEF_SHOW, CALIB_MIN_SECS, CALIB_SECS,
  CATCH_R, CUE_LEAD, FAIL_RATE, FAIL_STREAK, FREEPLAY_SECS, GRID, H, HOLD_SECS, HYST, INTENT_COS, LAYERS,
  LOOKAHEAD, MISS_LIMIT, MODEL_KEEP_ROWS, MODEL_MIN_EVENTS, ONSET_SPEED, PART_NAME, PASS_MIN, PASS_RATE,
  PHER_DEPOSIT, REP_MIN_DIST, ROUND_HELP, ROUND_STYLE, ROUND_TITLE, SEQUENCE, SETTLE_SPEED, SILENT_EVERY,
  SNAPSHOT_EXTRA, SNAPSHOT_MIN, SNAPSHOT_SECS, SONG_BEAT, W, ZONE_NAMES, bandColor, label, zkey, zoneOf,
  type LayerCfg, type Note, type RoundKind, type RoundOpt, type Settings,
} from "./config";
import { C, dashedCircle, drawFruit, drawHeat, roundRect, text, textCenter, textWidth, tint, wrapText, type Ctx } from "./draw";
import {
  Kalman, angleDeg, clamp, maxOf, mean, meanOf, median, minOf, nums, percentile, r3, randUniform, slope, std,
} from "./math";
import { motorScore } from "./score";
import { POSE_IDX, poseOk, shouldersOk, type Obs, type Pose, type Tracker } from "./tracker";
import type { FrameRow, Group, PartResult, Progress, RepRow, SessionSummary, TrialRow } from "./types";

export class QuitSession extends Error {}
export class JumpPart extends Error {}

/** Calibration and posture reference carried from part 1 to parts 2-4. */
export interface Carry {
  calib: [number, number, number, number];
  reach: [number, number];
  depthCal: [number, number];
  snap: Snap | null;
  rest: [number, number];
}

interface Snap {
  mid: [number, number]; width: number; diff: number; norm: Record<number, [number, number]>;
}

interface Body {
  mid: [number, number]; width: number; diff: number; norm: Record<number, [number, number]>;
  lean: number | null; hike: number | null; elbow: number | null; shoulder: number | null;
}

export interface PanelState {
  part: number; done: number[]; layer: number;
  help: string[]; hud: [string, string, string];
  reps: number; repsToday: number; dailyGoal: number;
  lean: number | null; hike: number | null; elbow: number | null; shoulder: number | null; goodForm: boolean | null;
  depth: number; note: string; instrument: string; heatOn: boolean; paused: boolean;
  handSeen: boolean; fps: number; poseOn: boolean; latencyMs: number;
}

export interface GameUI {
  panel(s: PanelState): void;
  askPain(question: string): Promise<number | null>;
  /** After each part. Resolves to "next", "stop" or a part index to jump to. */
  results(summary: SessionSummary, opts: { canGoNext: boolean; nextName: string | null }): Promise<"next" | "stop" | number>;
}

export interface GameOpts {
  ctx: Ctx; tracker: Tracker; audio: SoundEngine; ui: GameUI;
  group: Group; progress: Progress; settings: Settings;
  part: number; visitId: string; carry: Carry | null; painBefore: number | null;
  done: Set<number>;
  keys: KeyState;
}

/** Keys pressed since the last frame (set by the React page). */
export class KeyState {
  space = false;
  pause = false;
  heat = false;
  quit = false;
  jump: number | null = null;
  take() {
    const k = { space: this.space, pause: this.pause, heat: this.heat, quit: this.quit };
    this.space = this.pause = this.heat = this.quit = false;
    return k;
  }
}

const ZONE_ORDER = Object.keys(ZONE_NAMES);
const nextFrame = () => new Promise<number>((r) => requestAnimationFrame(r));
const todayStr = () => new Date().toISOString().slice(0, 10);

export class Game {
  ctx: Ctx;
  tracker: Tracker;
  audio: SoundEngine;
  ui: GameUI;
  group: Group;
  record: Progress;
  settings: Settings;
  layer: number;
  part: number;
  cfg: LayerCfg;
  notes: Note[];
  words: string[] | undefined;
  hideNotes: boolean;
  N: number;
  bh: number;
  bandImg: HTMLCanvasElement;
  painBefore: number | null;
  sessionId: string;
  visitId: string;
  today = todayStr();
  carry: Carry | null;
  keys: KeyState;
  done: Set<number>;

  kf = new Kalman();
  pher: Pheromone;
  model: CatchModel;
  spawner: Spawner;
  get targetP() {
    return this.settings.targetP;
  }

  pausedTotal = 0;
  calib: [number, number, number, number] | null = null;
  reach: [number | null, number | null] = [null, null];
  depthCal: [number, number] | null = null;
  depth = 0.5;
  depthSeen: number[] = [];
  rest: [number, number] = [W / 2, H * 0.85];
  snap: Snap | null = null;
  body: Body | null = null;
  handLabel = "";
  lastObs: Obs | null = null;
  lastSeen = -1e9;
  lastT: number | null = null;
  hand: [number, number] | null = null;
  vel: [number, number] = [0, 0];
  speed = 0;
  predPos: [number, number] | null = null;
  predQueue: [number, [number, number]][] = [];
  frameErr: number | null = null;
  curBand: number | null = null;
  motionGain = 1.0;
  currentFruit: [number, number] | null = null;
  targetNote: Note | null = null;
  showMap = false;
  space = false;
  frames = 0;
  lost = 0;
  frameRows: FrameRow[] = [];
  feedback: [string, string, number] | null = null;
  noticeMsg: [string, string, number] | null = null;
  sparks: [number, number, number, number, number][] = [];
  hud: [string, string, string] = ["", "", ""];
  panelHelp: string[] = [];
  rows: TrialRow[] = [];
  repRows: RepRow[] = [];
  staticCount = 0;
  trialNo = 0;
  zoneHist = new Map<string, number[]>();
  reps = 0;
  repForms: number[] = [];
  repsTodayStart: number;
  sessionT0 = 0;
  startedAt = Date.now();
  private panelT = 0;

  constructor(o: GameOpts) {
    this.ctx = o.ctx;
    this.tracker = o.tracker;
    this.audio = o.audio;
    this.ui = o.ui;
    this.group = o.group;
    this.record = o.progress;
    this.settings = o.settings;
    this.part = o.part;
    this.layer = SEQUENCE[o.part];
    this.cfg = LAYERS[this.layer];
    this.notes = this.cfg.notes;
    this.words = this.cfg.words;
    this.hideNotes = !!this.words;
    this.N = this.notes.length;
    this.bh = H / this.N;
    this.bandImg = document.createElement("canvas");
    this.bandImg.width = W;
    this.bandImg.height = H;
    const bctx = this.bandImg.getContext("2d")!;
    for (let b = 0; b < this.N; b++) {
      bctx.fillStyle = bandColor(b, this.N);
      bctx.fillRect(0, Math.round(H - (b + 1) * this.bh), W, Math.ceil(this.bh) + 1);
    }
    this.painBefore = o.painBefore;
    this.visitId = o.visitId;
    this.sessionId = `${o.visitId}_p${o.part + 1}`;
    this.carry = o.carry;
    this.keys = o.keys;
    this.done = o.done;
    this.pher = new Pheromone(this.record.pheromone, this.settings.heatCarry);
    this.model = new CatchModel(this.record.modelRows);
    this.spawner = new Spawner(this);
    this.repsTodayStart = this.record.repsByDate[this.today] ?? 0;
    Game.current = this;
  }

  /** The game being played (used by the simulated hand). */
  static current: Game | null = null;
  private simFruit: [number, number] | null = null;
  private simMiss: [number, number] = [0, 0];

  /** Where a simulated hand should reach, in normalised camera coordinates (inverse of toScreen).
   *  About one fruit in four is aimed badly, so the adaptive engine sees misses too. */
  simAim(): [number, number] | null {
    if (!this.calib) return null;
    const f = this.currentFruit;
    if (f !== this.simFruit) {
      this.simFruit = f;
      this.simMiss = Math.random() < 0.25 ? [randUniform(-260, 260), randUniform(-200, 200)] : [0, 0];
    }
    const [x5, x95, y5, y95] = this.calib;
    const [sx, sy] = f ? [f[0] + this.simMiss[0], f[1] + this.simMiss[1]] : this.rest;
    return [x5 + ((sx / W - 0.15) / 0.7) * (x95 - x5), y5 + ((sy / H - 0.15) / 0.7) * (y95 - y5)];
  }

  // ------------------------------------------------------------ basics
  now() {
    return performance.now() / 1000 - this.pausedTotal;
  }

  toScreen(raw: [number, number]): [number, number] {
    if (!this.calib) return [raw[0] * W, raw[1] * H];
    const [x5, x95, y5, y95] = this.calib;
    const sx = W * (0.15 + (0.7 * (raw[0] - x5)) / (x95 - x5));
    const sy = H * (0.15 + (0.7 * (raw[1] - y5)) / (y95 - y5));
    return [clamp(sx, 0, W - 1), clamp(sy, 0, H - 1)];
  }

  bandCenter(b: number) {
    return H - (b + 0.5) * this.bh;
  }

  bandOfY(y: number) {
    return clamp(Math.floor((H - y) / this.bh), 0, this.N - 1);
  }

  updateBand(y: number) {
    const u = (H - y) / this.bh;
    const nb = clamp(Math.floor(u), 0, this.N - 1);
    if (this.curBand === null || u > this.curBand + 1 + HYST || u < this.curBand - HYST) this.curBand = nb;
  }

  zoneRecent(z: [number, number]) {
    const h = this.zoneHist.get(zkey(z));
    if (h && h.length) return (h.reduce((a, b) => a + b, 0) + 1) / (h.length + 2);
    const [c, n] = this.record.zones[zkey(z)] ?? [0, 0];
    return (c + 1) / (n + 2);
  }

  notice(s: string, color = "#78dcff") {
    this.noticeMsg = [s, color, this.now()];
  }

  goodForm(lean: number | null, hike: number | null) {
    return (lean === null || lean < this.settings.leanLimit) && (hike === null || hike < this.settings.hikeLimit);
  }

  // ------------------------------------------------------------ body (posture + angles)
  updateBody(pose: Pose | null, raw: [number, number] | null) {
    if (!shouldersOk(pose)) {
      this.body = null;
      return;
    }
    const ok = (i: number) => poseOk(pose, i);
    const P: Record<number, [number, number]> = {};
    for (const i of POSE_IDX) P[i] = [pose[i][0] * 640, pose[i][1] * 480];
    // tracked arm = the pose wrist nearest the hand landmarker's wrist
    let side = 0;
    if (raw) {
      const d = [15, 16].map((w) => Math.hypot(pose[w][0] - raw[0], pose[w][1] - raw[1]));
      side = d[0] <= d[1] ? 0 : 1;
    }
    const [sh, el, wr, hip] = side === 0 ? [11, 13, 15, 23] : [12, 14, 16, 24];
    const other = side === 0 ? 12 : 11;
    const mid: [number, number] = [(P[11][0] + P[12][0]) / 2, (P[11][1] + P[12][1]) / 2];
    const width = Math.hypot(P[11][0] - P[12][0], P[11][1] - P[12][1]);
    const b: Body = {
      mid, width, diff: P[other][1] - P[sh][1],
      norm: { 11: [pose[11][0], pose[11][1]], 12: [pose[12][0], pose[12][1]] },
      lean: null, hike: null, elbow: null, shoulder: null,
    };
    if (this.snap) {
      const s = this.snap;
      const shift = (Math.hypot(mid[0] - s.mid[0], mid[1] - s.mid[1]) / s.width) * 100;
      const grow = Math.max(0, ((width - s.width) / s.width) * 100);
      b.lean = Math.max(shift, grow);
      b.hike = Math.max(0, ((b.diff - s.diff) / s.width) * 100);
    }
    if (ok(el) && ok(wr)) {
      const inner = angleDeg(P[sh], P[el], P[wr]);
      b.elbow = inner === null ? null : 180 - inner; // 0 = straight arm
    }
    if (ok(el)) {
      const down: [number, number] = ok(hip) ? P[hip] : [P[sh][0], P[sh][1] + 100];
      b.shoulder = angleDeg(down, P[sh], P[el]); // arm vs trunk
    }
    this.body = b;
  }

  // ------------------------------------------------------------ one frame
  async step() {
    const obs = await this.tracker.read();
    const t = this.now();
    const dt = this.lastT !== null ? t - this.lastT : 1 / 30;
    this.lastT = t;
    this.frames += 1;
    const raw = obs.wrist;
    this.lastObs = obs;
    let meas: [number, number] | null = null;
    if (!raw) {
      this.lost += 1;
      this.kf.coast(t);
    } else {
      meas = this.toScreen(raw);
      this.kf.update(meas, t);
      this.lastSeen = t;
      if (obs.hand) this.handLabel = obs.hand;
      if (obs.palm && this.depthCal) {
        const [p5, p95] = this.depthCal;
        this.depth = clamp((obs.palm - p5) / (p95 - p5), 0, 1);
        this.depthSeen.push(this.depth);
      }
    }
    this.updateBody(obs.pose, raw);
    this.pher.evaporate(dt);

    this.frameErr = null;
    if (this.kf.ready && t - this.lastSeen < 0.3) {
      this.hand = this.kf.pos();
      this.vel = this.kf.vel();
      this.speed = Math.hypot(...this.vel);
      this.predPos = this.kf.ahead(LOOKAHEAD);
      this.predQueue.push([t + LOOKAHEAD, this.predPos]);
      while (this.predQueue.length && this.predQueue[0][0] <= t) {
        const [, pp] = this.predQueue.shift()!;
        if (meas) this.frameErr = Math.hypot(pp[0] - meas[0], pp[1] - meas[1]);
      }
      if (this.calib) {
        this.updateBand(this.predPos[1]);
        const speedGain = clamp((this.speed - 25) / 175, 0, 1); // sound starts at once
        const amp = (0.3 + 0.7 * this.depth) * speedGain * this.motionGain;
        this.audio.setMotion(this.notes[this.curBand!], this.hand[0] / W, amp);
      }
    } else {
      this.hand = null;
      this.vel = [0, 0];
      this.speed = 0;
      this.predPos = null;
      this.audio.setMotion(this.notes[this.curBand ?? 0], 0.5, 0);
    }

    if (this.calib) {
      const b = this.body;
      this.frameRows.push([
        r3(t - this.sessionT0), raw ? 1 : 0, r3(raw?.[0]), r3(raw?.[1]), r3(this.hand?.[0]), r3(this.hand?.[1]),
        r3(this.predPos?.[0]), r3(this.predPos?.[1]), r3(this.frameErr), r3(this.speed), this.curBand,
        r3(this.depth), r3(b?.lean), r3(b?.hike), r3(b?.elbow), r3(b?.shoulder),
        r3(this.currentFruit?.[0]), r3(this.currentFruit?.[1]),
      ]);
    }

    this.drawCamera();
    const k = this.keys.take();
    this.space = k.space;
    if (k.quit) throw new QuitSession();
    if (k.heat) this.showMap = !this.showMap;
    if (this.keys.jump !== null) {
      if (this.keys.jump === this.part) this.keys.jump = null;
      else throw new JumpPart();
    }
    if (k.pause) await this.pause();
    this.pushPanel();
  }

  drawCamera() {
    const ctx = this.ctx;
    ctx.save();
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, W, H);
    ctx.translate(W, 0);
    ctx.scale(-1, 1); // mirror, like a looking-glass
    ctx.globalAlpha = 0.35;
    if (this.tracker.video.readyState >= 2) ctx.drawImage(this.tracker.video, 0, 0, W, H);
    ctx.restore();
  }

  pushPanel(force = false) {
    const t = performance.now();
    if (!force && t - this.panelT < 120) return; // about 8 times a second
    this.panelT = t;
    const b = this.body;
    const band = this.curBand ?? 0;
    this.ui.panel({
      part: this.part, done: [...this.done], layer: this.layer,
      help: this.panelHelp, hud: this.hud, reps: this.reps, repsToday: this.repsTodayStart + this.reps,
      dailyGoal: this.settings.dailyGoal,
      lean: b?.lean ?? null, hike: b?.hike ?? null, elbow: b?.elbow ?? null, shoulder: b?.shoulder ?? null,
      goodForm: b && this.snap ? this.goodForm(b.lean, b.hike) : null,
      depth: this.depth, note: this.hideNotes ? "" : label(this.notes[band]),
      instrument: this.hand ? instrumentName(this.hand[0] / W) : "", heatOn: this.showMap, paused: false,
      handSeen: this.hand !== null, fps: this.tracker.fps, poseOn: this.tracker.poseOn,
      latencyMs: this.audio.outputLatencyMs,
    });
  }

  async pause() {
    const t0 = performance.now() / 1000;
    this.audio.setMotion("Sa", 0.5, 0);
    this.ui.panel({ ...this.panelSnapshot(), paused: true });
    for (;;) {
      await nextFrame();
      const ctx = this.ctx;
      ctx.fillStyle = "#0f172a";
      ctx.fillRect(0, 0, W, H);
      textCenter(ctx, "PAUSED", H / 2 - 20, 56, C.text, 800);
      textCenter(ctx, "P = continue    Q = quit and save", H / 2 + 40, 24, C.dim, 500);
      const k = this.keys.take();
      if (this.keys.jump !== null && this.keys.jump !== this.part) {
        this.pausedTotal += performance.now() / 1000 - t0;
        throw new JumpPart();
      }
      if (k.pause) break;
      if (k.quit) throw new QuitSession();
    }
    this.pausedTotal += performance.now() / 1000 - t0;
    this.kf.reset();
    this.predQueue = [];
    this.lastT = null;
  }

  private panelSnapshot(): PanelState {
    return {
      part: this.part, done: [...this.done], layer: this.layer, help: this.panelHelp, hud: this.hud,
      reps: this.reps, repsToday: this.repsTodayStart + this.reps, dailyGoal: this.settings.dailyGoal,
      lean: null, hike: null, elbow: null, shoulder: null, goodForm: null, depth: this.depth, note: "",
      instrument: "", heatOn: this.showMap, paused: false, handSeen: false, fps: this.tracker.fps,
      poseOn: this.tracker.poseOn, latencyMs: this.audio.outputLatencyMs,
    };
  }

  // ------------------------------------------------------------ drawing
  drawScene(targetBand: number | null = null) {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 0.3; // one colour per note height
    ctx.drawImage(this.bandImg, 0, 0);
    ctx.restore();
    if (this.showMap) {
      const { mask } = this.pher.frontier();
      drawHeat(ctx, this.pher.g, mask);
    }
    if (this.curBand !== null && this.hand) {
      // band under the hand glows
      const y0 = H - (this.curBand + 1) * this.bh;
      tint(ctx, y0, y0 + this.bh, bandColor(this.curBand, this.N), 0.5);
    }
    if (targetBand !== null) {
      const y0 = H - (targetBand + 1) * this.bh;
      ctx.save();
      ctx.lineWidth = 4;
      ctx.strokeStyle = C.yellow;
      ctx.strokeRect(4, y0 + 4, W - 8, this.bh - 8);
      ctx.restore();
    }
    ctx.save();
    ctx.strokeStyle = "rgba(215,215,215,0.8)";
    ctx.lineWidth = 1;
    for (let i = 1; i < this.N; i++) {
      const y = H - i * this.bh;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();
    if (!this.hideNotes) {
      this.notes.forEach((n, b) => {
        const on = b === this.curBand;
        text(ctx, label(n), 14, this.bandCenter(b) + 9, on ? 28 : 22, bandColor(b, this.N), on ? 800 : 700);
      });
    }

    // posture: shoulder line only (green = good, orange = leaning / shoulder up)
    const b = this.body;
    if (b) {
      const [n11, n12] = [b.norm[11], b.norm[12]];
      ctx.save();
      ctx.lineWidth = 5;
      ctx.lineCap = "round";
      ctx.strokeStyle = this.goodForm(b.lean, b.hike) ? C.green : C.orange;
      ctx.beginPath();
      ctx.moveTo(n11[0] * W, n11[1] * H);
      ctx.lineTo(n12[0] * W, n12[1] * H);
      ctx.stroke();
      ctx.restore();
    }
    if (this.snap) {
      ctx.save();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      for (const [nx, ny] of Object.values(this.snap.norm)) {
        const cx = nx * W, cy = ny * H;
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy);
        ctx.lineTo(cx + 6, cy);
        ctx.moveTo(cx, cy - 6);
        ctx.lineTo(cx, cy + 6);
        ctx.stroke();
      }
      ctx.restore();
    }

    // wrist pointer + catch zone
    if (this.hand) {
      const [hx, hy] = this.hand;
      ctx.save();
      ctx.fillStyle = C.cyan;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(hx, hy, 13, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      dashedCircle(ctx, hx, hy, CATCH_R, C.cyan);
    } else if (this.calib && this.now() - this.lastSeen > 0.5) {
      textCenter(ctx, "Hand not seen", H / 2 + 60, 30, C.pink);
    }

    // sparks (rainbow)
    const t = this.now();
    this.sparks = this.sparks.filter(([x, y, vx, vy, t0]) => {
      const a = t - t0;
      if (a >= 0.6) return false;
      ctx.fillStyle = bandColor(Math.floor(Math.abs(vx)) % 8, 8);
      ctx.beginPath();
      ctx.arc(x + vx * a, y + vy * a + 300 * a * a, 4, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });
    if (this.feedback && t - this.feedback[2] < 1.2) textCenter(ctx, this.feedback[0], 120, 28, this.feedback[1]);
    if (this.noticeMsg && t - this.noticeMsg[2] < 2.0) textCenter(ctx, this.noticeMsg[0], 160, 24, this.noticeMsg[1]);
  }

  topName() {
    const top = this.cfg.passNote;
    return this.hideNotes ? (this.cfg.topName ?? label(top)) : label(top);
  }

  lineOf(idx: number): [number, number] {
    const ends = this.cfg.lineEnds ?? [this.words?.length ?? 0];
    let start = 0;
    for (const e of ends) {
      if (idx < e) return [start, e];
      start = e;
    }
    return [start, this.words?.length ?? 0];
  }

  drawLyrics(idx: number | null, y = 160) {
    if (!this.words || idx === null || idx >= this.words.length) return;
    const ctx = this.ctx;
    const [a, b] = this.lineOf(idx);
    const parts = this.words.slice(a, b);
    const size = 26, gap = 14;
    const widths = parts.map((w) => textWidth(ctx, w, size, 700));
    const total = widths.reduce((s, w) => s + w, 0) + gap * (parts.length - 1);
    let x = (W - total) / 2;
    roundRect(ctx, x - 16, y - 32, total + 32, 46, 12, "rgba(15,23,42,0.6)");
    parts.forEach((w, i) => {
      const on = a + i === idx;
      text(ctx, w, x, y, size, on ? "#78ff78" : "#d2d2d2", on ? 800 : 600);
      x += widths[i] + gap;
    });
  }

  /** Explanation card over the camera view; SPACE continues early. */
  async card(title: string, lines: string[], secs = 6.0) {
    this.motionGain = 0;
    const t0 = this.now();
    while (this.now() - t0 < secs) {
      await this.step();
      const ctx = this.ctx;
      roundRect(ctx, 60, 110, W - 120, H - 220, 20, C.card);
      ctx.fillStyle = C.accent;
      ctx.beginPath();
      ctx.roundRect(60, 110, W - 120, 10, [20, 20, 0, 0]);
      ctx.fill();
      // wrap every line to the card; shrink the text a little if it still does not fit between title and footer
      const maxW = W - 120 - 80;
      let titleSize = 30;
      while (titleSize > 20 && textWidth(ctx, title, titleSize, 800) > maxW) titleSize -= 2;
      textCenter(ctx, title, 175, titleSize, C.yellow, 800);
      let size = 19, rows: string[] = [], gap = 0;
      for (; size >= 14; size--) {
        rows = lines.flatMap((ln) => (ln ? wrapText(ctx, ln, maxW, size, 500) : [""]));
        gap = Math.round(size * 1.6);
        if (rows.length * gap <= H - 140 - 40 - 230 + gap) break;
      }
      let y = 230;
      for (const ln of rows) {
        textCenter(ctx, ln, y, size, C.text, 500);
        y += gap;
      }
      textCenter(ctx, `Starts in ${Math.max(0, secs - (this.now() - t0)).toFixed(0)} s   (SPACE = start now)`, H - 140, 20, C.green, 600);
      if (this.space) break;
    }
    this.motionGain = 1;
  }

  /** Play the tune (or one line of it, from index `start`) with its real rhythm. SPACE skips. */
  async songPreview(song: Note[], start = 0, title: string | null = null) {
    const beats = (this.cfg.beats ?? Array(start + song.length).fill(1)).slice(start, start + song.length);
    const times: number[] = [];
    let t = 0;
    for (const b of beats) {
      times.push(t);
      t += b * SONG_BEAT;
    }
    const total = t + 0.8;
    this.motionGain = 0;
    const t0 = this.now();
    let played = 0;
    while (this.now() - t0 < total) {
      await this.step();
      const ctx = this.ctx;
      const el = this.now() - t0;
      while (played < song.length && el >= times[played]) {
        this.audio.play("song_" + song[played]);
        played += 1;
      }
      const cur = played - 1;
      if (cur >= 0) {
        const b = this.notes.indexOf(song[cur]);
        const y0 = H - (b + 1) * this.bh;
        tint(ctx, y0, y0 + this.bh, bandColor(b, this.N), 0.45);
      }
      if (!this.hideNotes) this.notes.forEach((n, b) => text(ctx, label(n), 12, this.bandCenter(b) + 7, 20, "#e6e6e6", 700));
      textCenter(ctx, title ?? `LISTEN: this is how ${this.cfg.songName ?? "the song"} sounds`, 60, 26, "#ffdc78");
      if (this.words) this.drawLyrics(start + Math.max(cur, 0), 115);
      else {
        const lineStart = title ? 0 : Math.floor(Math.max(cur, 0) / 7) * 7;
        song.slice(lineStart, lineStart + 7).forEach((n, i) =>
          text(ctx, label(n), 140 + 100 * i, 110, 24, lineStart + i === cur ? "#78ff78" : "#dcdcdc", 700));
      }
      textCenter(ctx, "(SPACE = skip)", H - 30, 16, "#aaaaaa", 500);
      if (this.space) break;
    }
    this.motionGain = 1;
  }

  async intro() {
    const names = this.cfg.rounds.map(([r]) => ROUND_TITLE[r]);
    const first = this.hideNotes
      ? `Song: ${this.cfg.songName} - ${this.N} heights, low to high`
      : `Notes in this part: ${this.notes.map(label).join("  ")}`;
    const steps = this.carry
      ? "Same calibration as before - the rounds start next."
      : "Set-up: 1. Calibration (about 20 s)   2. Sit straight (3 s)   3. Warm-up (15 s)";
    this.panelHelp = ["Read the card. SPACE = start now."];
    await this.card(`PART ${this.part + 1} of ${SEQUENCE.length}: ${PART_NAME[this.layer].toUpperCase()}`,
      [first, steps, `Rounds: ${names.join(", ")}`, "Catch a fruit by moving your wrist circle onto it.", "",
        "Instructions stay in the panel on the right while you play."], this.carry ? 8 : 12);
  }

  // ------------------------------------------------------------ phases
  async calibrate() {
    const pts: [number, number][] = [];
    const palms: number[] = [];
    this.panelHelp = ["Move your arm as far as is comfortable: up, down, left, right.",
      "Also reach forward and pull back - this sets the depth range.", "SPACE = done (after 8 s)."];
    const t0 = this.now();
    while (this.now() - t0 < CALIB_SECS) {
      await this.step();
      const ctx = this.ctx;
      const o = this.lastObs;
      if (o?.wrist) {
        pts.push(o.wrist);
        if (o.palm) palms.push(o.palm);
        ctx.fillStyle = "#00ffff";
        ctx.beginPath();
        ctx.arc(o.wrist[0] * W, o.wrist[1] * H, 12, 0, Math.PI * 2);
        ctx.fill();
      }
      textCenter(ctx, "CALIBRATION", 60, 32, C.yellow, 800);
      textCenter(ctx, "Move your arm as far as is comfortable - also forward and back", 100, 20, C.text, 500);
      textCenter(ctx, Math.max(0, CALIB_SECS - (this.now() - t0)).toFixed(0), H / 2, 72, "#fff", 800);
      if (this.now() - t0 > CALIB_MIN_SECS) textCenter(ctx, "SPACE = done", H - 60, 22, C.green);
      if (this.space && this.now() - t0 > CALIB_MIN_SECS) break;
    }
    let x5: number, x95: number, y5: number, y95: number;
    if (pts.length >= 40) {
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      [x5, x95, y5, y95] = [percentile(xs, 5), percentile(xs, 95), percentile(ys, 5), percentile(ys, 95)];
    } else [x5, x95, y5, y95] = [0.2, 0.8, 0.2, 0.8];
    if (x95 - x5 < 0.08) {
      const m = (x5 + x95) / 2;
      [x5, x95] = [m - 0.04, m + 0.04];
    }
    if (y95 - y5 < 0.08) {
      const m = (y5 + y95) / 2;
      [y5, y95] = [m - 0.04, m + 0.04];
    }
    this.calib = [x5, x95, y5, y95];
    this.reach = [x95 - x5, y95 - y5];
    let p5: number, p95: number;
    if (palms.length >= 20) {
      [p5, p95] = [percentile(palms, 5), percentile(palms, 95)];
      if (p95 - p5 < 0.3 * median(palms)) {
        const m = median(palms);
        [p5, p95] = [m * 0.8, m * 1.2];
      }
    } else [p5, p95] = [40, 90];
    this.depthCal = [p5, p95];
    this.kf.reset();
    this.predQueue = [];
    this.curBand = null;
  }

  /** "Sit straight, arm relaxed": posture reference + resting hand position. */
  async snapshot() {
    const mids: [number, number][] = [], widths: number[] = [], diffs: number[] = [];
    const norms: Record<number, [number, number]>[] = [];
    const hands: [number, number][] = [];
    this.panelHelp = ["Sit up straight.", "Rest your arm.", "This is the posture reference for leaning and shoulder lift."];
    const t0 = this.now();
    // The reference needs the shoulders: if they were hardly seen in the 3 s, keep going (up to
    // SNAPSHOT_EXTRA s more, SPACE skips) instead of playing the whole visit without posture.
    while (true) {
      const el = this.now() - t0;
      const waiting = el >= SNAPSHOT_SECS;
      if (waiting && (mids.length >= SNAPSHOT_MIN || !this.tracker.poseOn || el >= SNAPSHOT_SECS + SNAPSHOT_EXTRA || this.space)) break;
      await this.step();
      if (this.body) {
        mids.push(this.body.mid);
        widths.push(this.body.width);
        diffs.push(this.body.diff);
        norms.push(this.body.norm);
      }
      if (this.hand) hands.push(this.hand);
      textCenter(this.ctx, "SIT STRAIGHT", 80, 34, C.yellow, 800);
      if (!waiting) textCenter(this.ctx, Math.max(0, SNAPSHOT_SECS - el).toFixed(0), H / 2, 64, "#fff", 800);
      else {
        textCenter(this.ctx, "Shoulders not seen", H / 2 - 20, 34, C.orange, 800);
        textCenter(this.ctx, "Sit back so both shoulders are in the picture   (SPACE = skip)", H / 2 + 24, 20, C.text, 500);
      }
    }
    if (!mids.length) this.notice("Posture check off: shoulders were not seen", C.orange);
    if (mids.length) {
      const avg = (arr: [number, number][]): [number, number] => [mean(arr.map((p) => p[0]))!, mean(arr.map((p) => p[1]))!];
      this.snap = {
        mid: avg(mids), width: mean(widths)!, diff: mean(diffs)!,
        norm: { 11: avg(norms.map((n) => n[11])), 12: avg(norms.map((n) => n[12])) },
      };
    }
    if (hands.length) this.rest = [median(hands.map((h) => h[0])), median(hands.map((h) => h[1]))];
  }

  async freePlay() {
    this.motionGain = 1;
    this.targetNote = null;
    const t0 = this.now();
    this.hud = ["Warm-up: free play", "", ""];
    this.panelHelp = ["Move and listen - no fruits yet.", "Up / down = note", "Left / right = instrument",
      "Forward / back = loudness", "SPACE = start the fruits now."];
    while (this.now() - t0 < FREEPLAY_SECS) {
      await this.step();
      this.drawScene();
      textCenter(this.ctx, "WARM-UP", 200, 34, C.yellow, 800);
      textCenter(this.ctx, `Fruits in ${Math.max(0, FREEPLAY_SECS - (this.now() - t0)).toFixed(0)} s   (SPACE = start now)`, H / 2, 24, "#c8ffc8", 600);
      if (this.space) break;
    }
  }

  // ------------------------------------------------------------ one fruit
  async runTrial(rnd: RoundKind, o: {
    target?: Note | null; expected?: Note | null; broken?: number; pos?: number; length?: number;
    counted?: boolean; preset?: Spawn; preview?: [number, number]; moving?: boolean;
    restrict?: Set<string> | null; hudExtra?: string;
  } = {}): Promise<number> {
    const { broken = 0, pos = 0, length = 1, counted = true, preset, preview, moving = false, restrict = null, hudExtra = "" } = o;
    let target = o.target ?? null;
    const [cueFirst, brief, memory, song, iti] = ROUND_STYLE[rnd];
    const word = song && this.words && pos < this.words.length ? this.words[pos] : null;
    const tStart = this.now();
    let silent = false;
    if (counted && !(memory || song || moving)) {
      this.staticCount += 1;
      silent = this.staticCount % SILENT_EVERY === 0;
    }
    // songs: arm voice off, so only the melody notes are heard
    this.motionGain = silent || song ? 0 : 1;

    let band = target ? this.notes.indexOf(target) : null;
    const { c, r, p, modelOn, feats, method } = preset ?? this.spawner.choose(band, restrict);
    let [fx, fy] = Pheromone.center(c, r);
    fx += (randUniform(-0.3, 0.3) * W) / GRID;
    if (band === null) {
      band = this.bandOfY(fy);
      target = this.notes[band];
    }
    const tgt: Note = target!;
    const bnd: number = band;
    const lo = H - (bnd + 1) * this.bh, hi = H - bnd * this.bh;
    fy = clamp(fy, lo + 0.2 * this.bh, hi - 0.2 * this.bh);
    fy = clamp(fy, 40, H - 40);
    const expected = o.expected ?? tgt;
    this.targetNote = tgt;
    const landing: [number, number] = [fx, fy];

    let radius = CATCH_R;
    let limit = MISS_LIMIT;
    let stage: number | null = null;
    let pathName = "";
    let path: ((t: number) => [number, number]) | null = null;
    if (moving) {
      stage = this.record.anticStage;
      const speedF = clamp(this.record.aimMedian / 1.5, 0.8, 2.0);
      const dur = ANTIC_STAGES[stage][1] * speedF;
      const mp = makePath(stage, landing, dur);
      path = mp.pos;
      pathName = mp.name;
      limit = dur + ANTIC_TAIL;
      radius = CATCH_R * 1.1; // allowance for webcam delay
    } else if (song && p < 0.5) {
      radius = CATCH_R * 1.3;
      limit = MISS_LIMIT * 1.5;
    }

    const cueT = tStart + iti;
    const fruitT = cueT + (cueFirst ? CUE_LEAD : 0);
    const endT = fruitT + limit;
    if (silent) this.notice("Silent try - no sound this time", "#c8c8ff");

    let hummed = false;
    let settledSince: number | null = null, onset: number | null = null, dirOk: number | null = null;
    let holdSince: number | null = null;
    let caught = 0;
    let catchT: number | null = null;
    const speeds: number[] = [];
    let peaks = 0, pathLen = 0, maxExt = 0, inOut = 0;
    let startPos: [number, number] | null = null, lastPos: [number, number] | null = null;
    let inside = false;
    let intentSince: number | null = null, intentT: number | null = null;
    let endpoint: [number, number] | null = null;
    let endSlow: number | null = null;
    let minDist: number | null = null, dStart: number | null = null;
    let strategy = "";
    let onsetHand: [number, number] | null = null, onsetFruit: [number, number] | null = null;
    const errs: number[] = [], leans: number[] = [], hikes: number[] = [], elbows: number[] = [];
    const shoulders: number[] = [], depths: number[] = [];
    let assist = false;
    let fpos: [number, number] | null = null;
    const songName = this.cfg.songName ?? "";
    this.hud = [`${ROUND_TITLE[rnd]} ${song ? songName + " " : ""}(${pos + 1}/${length})`,
      counted ? `Fruit ${this.trialNo + 1}` : "warm-up",
      hudExtra || (moving ? `Moving fruit: stage ${stage} ${pathName}` : "")];

    for (;;) {
      await this.step();
      const t = this.now();
      fpos = null;
      if (t >= fruitT) fpos = moving ? path!(t - fruitT) : landing;
      this.currentFruit = t >= fruitT ? (memory ? [W / 2, this.bandCenter(bnd)] : fpos) : null;

      // fruit hums its note when it appears (before it, in listen-first rounds)
      if (!hummed && !memory && !silent && (cueFirst || !song)) {
        if ((cueFirst && t >= cueT) || (!cueFirst && t >= fruitT)) {
          this.audio.play("hum_" + tgt);
          hummed = true;
        }
      }

      const h = this.hand;
      if (h && t >= tStart + 0.2 && onset === null) {
        if (this.speed < SETTLE_SPEED) {
          settledSince ??= t;
        } else if (this.speed > ONSET_SPEED && settledSince !== null && t - settledSince >= 0.15) {
          onset = t;
          const ref = fpos ?? landing;
          const dy = ref[1] - h[1];
          if (Math.abs(dy) > this.bh * 0.5 && Math.abs(this.vel[1]) > 1e-6) dirOk = Math.sign(this.vel[1]) === Math.sign(dy) ? 1 : 0;
          onsetHand = h;
          onsetFruit = fpos;
        } else settledSince = null;
      }

      if (h && t >= fruitT) {
        if (!startPos) startPos = lastPos = h;
        pathLen += Math.hypot(h[0] - lastPos![0], h[1] - lastPos![1]);
        lastPos = h;
        speeds.push(this.speed);
        const n = speeds.length;
        if (n >= 3 && speeds[n - 2] > speeds[n - 3] && speeds[n - 2] >= speeds[n - 1] && speeds[n - 2] > ONSET_SPEED) {
          peaks += 1;
          if (peaks > 1 && !silent) this.audio.play("click"); // shaky movement = clicks
        }
        maxExt = Math.max(maxExt, 1 - h[1] / H);
        if (this.frameErr !== null) errs.push(this.frameErr);
        const ref: [number, number] = fpos ?? [h[0], this.bandCenter(bnd)];
        const d = Math.hypot(h[0] - ref[0], h[1] - ref[1]);
        dStart ??= d;
        minDist = minDist === null ? d : Math.min(minDist, d);
        const nowIn = d < radius;
        if (nowIn && !inside) inOut += 1;
        inside = nowIn;
        if (intentT === null && this.speed > ONSET_SPEED && d > 1) {
          const cosv = ((ref[0] - h[0]) * this.vel[0] + (ref[1] - h[1]) * this.vel[1]) / (d * this.speed);
          if (cosv > INTENT_COS) {
            intentSince ??= t;
            if (t - intentSince >= 0.15) {
              intentT = t;
              if (this.group === "S" && this.settings.strokeAssist && !assist) {
                assist = true;
                radius *= 1.15; // reward clear intent
              }
            }
          } else intentSince = null;
        }
        if (onset !== null && endpoint === null) {
          if (this.speed < SETTLE_SPEED) {
            endSlow ??= t;
            if (t - endSlow >= 0.15) endpoint = h;
          } else endSlow = null;
        }
        if (moving && onsetHand && !strategy && Math.hypot(h[0] - onsetHand[0], h[1] - onsetHand[1]) > 25) {
          const mvx = h[0] - onsetHand[0], mvy = h[1] - onsetHand[1];
          const cur = onsetFruit ?? fpos!;
          const ang = (tx: number, ty: number) => {
            const nn = Math.hypot(tx, ty) * Math.hypot(mvx, mvy);
            return nn ? Math.acos(clamp((tx * mvx + ty * mvy) / nn, -1, 1)) : Math.PI;
          };
          const aCur = ang(cur[0] - onsetHand[0], cur[1] - onsetHand[1]);
          const aLand = ang(landing[0] - onsetHand[0], landing[1] - onsetHand[1]);
          strategy = aLand < aCur ? "anticipating" : "chasing";
        }
      }
      const b = this.body;
      if (t >= fruitT) {
        if (b?.lean != null) leans.push(b.lean);
        if (b?.hike != null) hikes.push(b.hike);
        if (b?.elbow != null) elbows.push(b.elbow);
        if (b?.shoulder != null) shoulders.push(b.shoulder);
        if (h) depths.push(this.depth);
      }

      // catch check
      if (t >= fruitT && h) {
        if (memory) {
          if (this.curBand === bnd) {
            holdSince ??= t;
            if (t - holdSince >= HOLD_SECS) caught = 1;
          } else holdSince = null;
        } else {
          const d = Math.hypot(h[0] - fpos![0], h[1] - fpos![1]);
          // inside the circle, or in the right note band and close enough
          const nearBand = !moving && this.curBand === bnd && Math.abs(h[0] - fpos![0]) < 1.25 * radius &&
            Math.abs(h[1] - fpos![1]) < 0.6 * this.bh;
          if (d < radius || nearBand) caught = 1;
        }
      }
      if (caught) {
        catchT = t;
        break;
      }
      if (t >= endT) break;

      // draw
      const ctx = this.ctx;
      this.drawScene(memory ? null : bnd);
      const visible = t >= fruitT && !memory && !(brief && t > fruitT + BRIEF_SHOW);
      if (word) this.drawLyrics(pos);
      if (visible && fpos) {
        drawFruit(ctx, fpos[0], fpos[1]);
        if (word) text(ctx, word, fpos[0], fpos[1] - 50, 26, "#fff", 800, "center");
      }
      if (preview) drawFruit(ctx, preview[0], preview[1], true);
      if (cueFirst && cueT <= t && t < fruitT) textCenter(ctx, "Listen...", H / 2, 44, "#ffdc78", 800);
      if (memory && t >= fruitT) {
        if (word) textCenter(ctx, `From memory: raise your hand to the height of "${word}"`, 250, 24, "#ffdc78");
        else textCenter(ctx, `From memory: note ${pos + 1} of ${length}`, 200, 28, "#ffdc78");
      }
    }

    // ---------- outcome
    const leanMax = leans.length ? Math.max(...leans) : null;
    const hikeMax = hikes.length ? Math.max(...hikes) : null;
    const withLean = !!(caught && !this.goodForm(leanMax, hikeMax));
    if (caught) {
      this.audio.play((song ? "song_" : "ring_") + tgt);
      const hp = this.hand ?? landing;
      for (let i = 0; i < 14; i++) {
        const a = randUniform(0, 2 * Math.PI), v = randUniform(80, 240);
        this.sparks.push([hp[0], hp[1], v * Math.cos(a), v * Math.sin(a) - 120, catchT!]);
      }
      this.feedback = withLean
        ? ["Caught - next time sit back and stretch the arm", "#ffc800", catchT!]
        : [`+1  ${word ?? (this.hideNotes ? "" : label(tgt))}`, "#50ff50", catchT!];
      if (counted) {
        const at = memory ? [W / 2, this.bandCenter(bnd)] : fpos!;
        this.pher.deposit(at[0], at[1], PHER_DEPOSIT * (withLean ? 0.5 : 1.0));
      }
    } else {
      this.audio.play("miss");
      this.feedback = ["Missed", "#ff5050", this.now()];
    }

    const endH = this.hand;
    if (!endpoint) endpoint = endH;
    const refEnd = moving ? (fpos ?? landing) : landing;
    const endpointErr = endpoint ? Math.hypot(endpoint[0] - refEnd[0], endpoint[1] - refEnd[1]) : null;
    const noteErr = endpoint ? Math.abs(this.bandOfY(endpoint[1]) - bnd) : null;
    const straight = startPos && lastPos && pathLen > 20
      ? Math.hypot(lastPos[0] - startPos[0], lastPos[1] - startPos[1]) / pathLen : null;
    const active = speeds.filter((s) => s > SETTLE_SPEED);
    const rt = onset !== null ? onset - cueT : null;
    const z = zoneOf(...landing);
    const t0 = this.sessionT0;

    const row: TrialRow = {
      round: rnd, trial: counted ? this.trialNo + 1 : null, roundPos: pos + 1,
      targetNote: tgt, expectedNote: expected, patternBroken: broken, band: bnd, nBands: this.N,
      silent: silent ? 1 : 0, moving: moving ? 1 : 0, anticStage: stage, pathType: pathName,
      fruitX: r3(landing[0])!, fruitY: r3(landing[1])!, cellCol: c, cellRow: r, zone: ZONE_NAMES[zkey(z)],
      spawnMethod: method, featX: r3(feats.x)!, featY: r3(feats.y)!, featDist: r3(feats.dist)!,
      featPher: r3(feats.pher)!, featRecent: r3(feats.recent)!, predCatchProb: r3(p)!, modelOn: modelOn ? 1 : 0,
      radiusPx: Math.round(radius), timeLimitS: r3(limit)!,
      cueTime: r3(cueT - t0)!, fruitTime: r3(fruitT - t0)!, onsetTime: onset !== null ? r3(onset - t0) : null,
      intentTime: intentT !== null ? r3(intentT - fruitT) : null, catchTime: catchT !== null ? r3(catchT - t0) : null,
      caught, caughtWithLean: withLean ? 1 : 0, aimingTime: catchT !== null ? r3(catchT - fruitT) : null,
      reactionTime: r3(rt), anticipated: onset === null ? null : onset < fruitT ? 1 : 0,
      firstDirectionCorrect: dirOk,
      maxSpeed: speeds.length ? r3(Math.max(...speeds)) : null,
      avgSpeed: active.length ? r3(mean(active)) : null,
      vVariation: speeds.length > 2 ? r3(std(speeds)) : null,
      maxVerticalExt: speeds.length ? r3(maxExt) : null, inOutCount: inOut,
      velocityPeaks: peaks, corrections: Math.max(0, peaks - 1), pathEfficiency: r3(straight),
      endpointErrorPx: r3(endpointErr), noteError: noteErr, predErrorPx: errs.length ? r3(mean(errs)) : null,
      interceptionErrorPx: moving ? r3(caught ? 0 : minDist) : null, strategy,
      leanMax: r3(leanMax), hikeMax: r3(hikeMax), elbowMin: r3(minOf(elbows)), elbowMax: r3(maxOf(elbows)),
      shoulderMax: r3(maxOf(shoulders)), depthMean: depths.length ? r3(mean(depths)) : null,
      depthMax: r3(maxOf(depths)), counted: counted ? 1 : 0,
    };
    this.rows.push(row);

    // rep = a real reach toward this fruit (closed >= REP_MIN_DIST px of the gap); moving back is not counted
    if (counted && dStart !== null && minDist !== null && dStart - minDist >= REP_MIN_DIST) {
      this.reps += 1;
      const form = this.goodForm(this.snap ? leanMax : null, this.snap ? hikeMax : null);
      this.repForms.push(form ? 1 : 0);
      this.repRows.push({
        rep: this.reps, tStart: r3(fruitT - t0)!, durationS: r3((catchT ?? this.now()) - fruitT)!,
        distancePx: r3(dStart - minDist)!, pathPx: r3(pathLen)!, straightness: r3(straight),
        peakSpeed: speeds.length ? r3(Math.max(...speeds)) : null, targetNote: tgt,
        leanMax: r3(leanMax), hikeMax: r3(hikeMax), goodForm: form ? 1 : 0,
        elbowMin: r3(minOf(elbows)), elbowMax: r3(maxOf(elbows)), shoulderMax: r3(maxOf(shoulders)),
      });
    }
    if (counted) {
      this.trialNo += 1;
      if (!moving && !memory) {
        this.model.update(feats, caught); // the model learns after every still fruit
        this.spawner.record(c, r, caught);
        const hist = this.zoneHist.get(zkey(z)) ?? [];
        hist.push(caught);
        if (hist.length > 5) hist.shift();
        this.zoneHist.set(zkey(z), hist);
        const [zc, zn] = this.record.zones[zkey(z)] ?? [0, 0];
        this.record.zones[zkey(z)] = [zc + caught, zn + 1];
      }
      if (!moving) {
        const key = `L${this.layer}:${tgt}`;
        const [sc, sn] = this.record.stats[key] ?? [0, 0];
        this.record.stats[key] = [sc + caught, sn + 1];
        this.record.modelRows.push([feats.x, feats.y, feats.dist, feats.pher, feats.recent, caught]);
        if (this.record.modelRows.length > MODEL_KEEP_ROWS) this.record.modelRows.splice(0, this.record.modelRows.length - MODEL_KEEP_ROWS);
      }
    }
    this.currentFruit = null;
    return caught;
  }

  // ------------------------------------------------------------ rounds
  /** Sa -> higher note in pairs. 3 good pairs: bigger jump. 2 missed pairs: smaller. */
  async runJump(opt: RoundOpt) {
    let k = 1, good = 0, bad = 0;
    const base = this.notes[0];
    const pairs = opt.pairs ?? 6;
    for (let i = 0; i < pairs; i++) {
      k = clamp(k, 1, this.N - 1);
      const high = this.notes[k];
      const pre = this.spawner.choose(k);
      let [px, py] = Pheromone.center(pre.c, pre.r);
      py = clamp(py, H - (k + 1) * this.bh + 0.2 * this.bh, H - k * this.bh - 0.2 * this.bh);
      const extra = `Jump: ${label(base)} -> ${label(high)}`;
      const c1 = await this.runTrial("jump", { target: base, pos: 2 * i, length: 2 * pairs, preview: [px, py], hudExtra: extra });
      const c2 = await this.runTrial("jump", { target: high, pos: 2 * i + 1, length: 2 * pairs, preset: pre, hudExtra: extra });
      if (c1 && c2) {
        good += 1;
        bad = 0;
        if (good >= 3 && k < this.N - 1) {
          k += 1;
          good = 0;
          this.notice(`Bigger jump: ${label(base)} -> ${label(this.notes[k])}`);
        }
      } else {
        bad += 1;
        good = 0;
        if (bad >= 2 && k > 1) {
          k -= 1;
          bad = 0;
          this.notice(`Smaller jump: ${label(base)} -> ${label(this.notes[k])}`);
        }
      }
    }
  }

  unlockedZones() {
    const out = new Set<string>();
    for (const [key, [c, n]] of Object.entries(this.record.zones)) {
      if (n >= ANTIC_UNLOCK_MIN && (c + 1) / (n + 2) >= ANTIC_UNLOCK_RATE) out.add(key);
    }
    return out;
  }

  async runAnticipation(opt: RoundOpt) {
    const zones = this.unlockedZones();
    if (!zones.size) {
      this.notice("Moving fruits locked: catch more still fruits first", "#c8c8c8");
      const t0 = this.now();
      while (this.now() - t0 < 2) {
        await this.step();
        this.drawScene();
      }
      return;
    }
    const n = opt.trials ?? 6;
    for (let i = 0; i < n; i++) await this.runTrial("anticipation", { pos: i, length: n, moving: true, restrict: zones });
  }

  async runRounds() {
    const total = this.cfg.rounds.length;
    for (let i = 0; i < total; i++) {
      const [rnd, opt] = this.cfg.rounds[i];
      this.panelHelp = ["Read the card. SPACE = start now."];
      await this.card(`ROUND ${i + 1} of ${total}: ${ROUND_TITLE[rnd]}`, [ROUND_HELP[rnd]], 5);
      this.panelHelp = [`Round ${i + 1} of ${total}: ${ROUND_TITLE[rnd]}`, ROUND_HELP[rnd]];
      if (rnd.startsWith("song_")) this.panelHelp.push("The song words are shown at the top.");
      else this.panelHelp.push("Move your wrist circle onto each fruit.");
      if (rnd === "jump") await this.runJump(opt);
      else if (rnd === "anticipation") await this.runAnticipation(opt);
      else if (rnd === "sound_first") {
        const n = opt.trials ?? 8;
        for (let j = 0; j < n; j++) await this.runTrial(rnd, { pos: j, length: n });
      } else {
        if (rnd.startsWith("song_")) await this.songPreview(opt.song!);
        const seq = fixedSequence(rnd, opt, this.notes);
        const ends = rnd.startsWith("song_") ? (this.cfg.lineEnds ?? []) : [];
        let lineStart = 0;
        for (let j = 0; j < seq.length; j++) {
          const [tg, ex, br] = seq[j];
          await this.runTrial(rnd, { target: tg, expected: ex, broken: br, pos: j, length: seq.length });
          if (ends.includes(j + 1)) {
            // a line of the song is done: play it back
            await this.songPreview(opt.song!.slice(lineStart, j + 1), lineStart, `You played line ${ends.indexOf(j + 1) + 1}:`);
            lineStart = j + 1;
          }
        }
      }
    }
  }

  // ------------------------------------------------------------ session
  /** Plays this part. Returns what to do next, the carry for the next part and the saved result. */
  async run(): Promise<{ next: "next" | "stop" | "jump"; carry: Carry | null; result: PartResult; isLastPart: boolean }> {
    let completed = false;
    let jumped = false;
    this.sessionT0 = this.now();
    try {
      await this.intro();
      if (this.carry) {
        // parts 2-4: reuse part 1's calibration
        this.calib = this.carry.calib;
        this.reach = this.carry.reach;
        this.depthCal = this.carry.depthCal;
        this.snap = this.carry.snap;
        this.rest = this.carry.rest;
      } else {
        await this.calibrate();
        await this.snapshot();
        await this.freePlay();
      }
      if (this.layer > 1 && !this.cfg.songName) {
        // songs: no scale warm-up
        this.panelHelp = ["Warm-up scale: catch each fruit, low to high.", "Not scored."];
        for (let i = 0; i < this.N; i++) {
          await this.runTrial("warmup", { target: this.notes[i], pos: i, length: this.N, counted: false });
        }
      }
      await this.runRounds();
      completed = true;
    } catch (e) {
      if (e instanceof JumpPart) jumped = true;
      else if (!(e instanceof QuitSession)) throw e;
    }
    this.audio.setMotion("Sa", 0.5, 0);
    if (completed) this.done.add(this.part);
    const last = !completed || this.part === SEQUENCE.length - 1;
    this.panelHelp = [];
    this.pushPanel(true);
    let painAfter = last && !jumped ? await this.ui.askPain("Pain now (after the session)?") : null;
    const result = this.finish(completed, painAfter);
    const carry: Carry | null = this.calib
      ? { calib: this.calib, reach: this.reach as [number, number], depthCal: this.depthCal!, snap: this.snap, rest: this.rest }
      : null;
    if (jumped) return { next: "jump", carry, result, isLastPart: false };
    const canGoNext = completed && this.part < SEQUENCE.length - 1;
    const choice = await this.ui.results(result.summary, {
      canGoNext, nextName: canGoNext ? PART_NAME[SEQUENCE[this.part + 1]] : null,
    });
    if (typeof choice === "number") {
      this.keys.jump = choice;
      return { next: "jump", carry, result, isLastPart: false };
    }
    if (choice === "stop" && !last) {
      // stopping after a completed part ends the visit: ask about pain now (saved with this part)
      painAfter = await this.ui.askPain("Pain now (after the session)?");
      result.summary.painAfter = painAfter;
    }
    return { next: canGoNext ? choice : "stop", carry, result, isLastPart: true };
  }

  reachability() {
    return ZONE_ORDER.map((key) => {
      const [zr, zc] = key.split(",").map(Number);
      const [c, r] = Pheromone.cellOf(((zc + 0.5) * W) / 3, ((zr + 0.5) * H) / 3);
      const f = this.spawner.features(c, r);
      const p = this.model.events >= MODEL_MIN_EVENTS ? this.model.predict(f) : f.recent;
      return { zone: ZONE_NAMES[key], p: r3(p)! };
    });
  }

  /** Automatic level changes (switched off in the Python version, on here). */
  decide(completed: boolean, rate: number, topC: number, topN: number): [string, number] {
    const rec = this.record;
    if (!completed) return ["part stopped early: level unchanged", rec.level];
    if (topN >= PASS_MIN && topC / topN >= PASS_RATE) {
      rec.badStreak = 0;
      const nxt = Math.min(this.part + 1, SEQUENCE.length - 1);
      return [`passed: ${this.topName()} caught ${topC}/${topN}` + (nxt > this.part ? " - next level unlocked" : ""), Math.max(rec.level, nxt)];
    }
    if (rate < FAIL_RATE) {
      rec.badStreak += 1;
      if (rec.badStreak >= FAIL_STREAK && this.part > 0) {
        rec.badStreak = 0;
        return ["two hard sessions in a row: back one level", this.part - 1];
      }
      return [`hard session (${Math.round(rate * 100)}%): stay`, rec.level];
    }
    rec.badStreak = 0;
    return [`not yet: ${this.topName()} caught ${topC}/${topN}`, rec.level];
  }

  finish(completed: boolean, painAfter: number | null): PartResult {
    const rows = this.rows.filter((r) => r.counted === 1);
    const stat = rows.filter((r) => r.moving === 0);
    const moving = rows.filter((r) => r.moving === 1);
    const done = rows.length;
    const catches = rows.reduce((a, r) => a + r.caught, 0);
    const rate = done ? catches / done : 0;
    const top = this.cfg.passNote;
    const topRows = stat.filter((r) => r.targetNote === top);
    const topC = topRows.reduce((a, r) => a + r.caught, 0), topN = topRows.length;
    const perNote = this.notes.flatMap((n) => {
      const nr = stat.filter((r) => r.targetNote === n);
      return nr.length ? [`${label(n)}:${nr.reduce((a, r) => a + r.caught, 0)}/${nr.length}`] : [];
    });
    const silent = rows.filter((r) => r.silent === 1);

    // prediction accuracy: only fruits where the catch model was switched on
    const pr = stat.filter((r) => r.round !== "song_memory");
    const prOn = pr.filter((r) => r.modelOn === 1);
    let brier: number | null = null, base: number | null = null;
    if (prOn.length) {
      const ym = mean(prOn.map((r) => r.caught))!;
      brier = Math.round(mean(prOn.map((r) => (r.predCatchProb - r.caught) ** 2))! * 1e4) / 1e4;
      base = Math.round(mean(prOn.map((r) => (ym - r.caught) ** 2))! * 1e4) / 1e4;
    }

    // anticipation
    const gaps: number[] = [];
    for (const zn of Object.values(ZONE_NAMES)) {
      const s = stat.filter((r) => r.zone === zn).map((r) => r.caught);
      const m = moving.filter((r) => r.zone === zn).map((r) => r.caught);
      if (s.length && m.length) gaps.push(mean(s)! - mean(m)!);
    }
    const strat = moving.map((r) => r.strategy).filter(Boolean);

    // patient prediction from sound / pattern
    const cueRows = rows.filter((r) => r.round === "sound_first" || r.round === "song_cue_first");
    const surprise = rows.filter((r) => r.round === "surprise");
    const broken = surprise.filter((r) => r.patternBroken === 1);
    const normal = surprise.filter((r) => r.patternBroken === 0);

    // learning rate
    const lrCatch = stat.length >= 8 ? slope(stat.map((_, i) => i), stat.map((r) => r.caught)) : null;
    const aims = stat.flatMap((r, i) => (r.aimingTime !== null ? [[i, r.aimingTime] as [number, number]] : []));
    const lrAim = aims.length >= 8 ? slope(aims.map((a) => a[0]), aims.map((a) => a[1])) : null;
    const hist = this.record.history.filter((h) => h.layer === this.layer && h.catchRate !== null).map((h) => h.catchRate!);
    if (done) hist.push(rate);
    const lrSess = hist.length >= 2 ? slope(hist.map((_, i) => i), hist) : null;

    const [coverage, frontierN, pherMean] = this.pher.stats();
    const reachMap = this.reachability();
    const [decision, nxt] = this.decide(completed, rate, topC, topN);

    const rec = this.record;
    if (completed) rec.level = nxt;
    rec.sessions += 1;
    rec.repsByDate[this.today] = this.repsTodayStart + this.reps;
    const aimVals = nums(stat.map((r) => r.aimingTime));
    if (aimVals.length) rec.aimMedian = median(aimVals);
    if (completed && moving.length >= 5) {
      const mr = mean(moving.map((r) => r.caught))!;
      if (mr >= ANTIC_UNLOCK_RATE && rec.anticStage < 5) rec.anticStage += 1;
      else if (mr < 0.3 && rec.anticStage > 1) rec.anticStage -= 1;
    }
    rec.history.push({
      sessionId: this.sessionId, layer: this.layer, catchRate: done ? r3(rate) : null,
      meanPred: meanOf(pr.map((r) => r.predCatchProb)), decision,
    });
    if (rec.history.length > 200) rec.history.splice(0, rec.history.length - 200);
    rec.pheromone = this.pher.toArray();

    const col = (key: keyof TrialRow, rs: TrialRow[] = rows) => meanOf(rs.map((r) => r[key] as number | null));
    let perLine: SessionSummary["perLine"] = [];
    if (this.words) {
      const m = new Map<number, [number, number]>();
      for (const r of rows) {
        if (!r.round.startsWith("song_")) continue;
        const [a] = this.lineOf(r.roundPos - 1);
        const [c, n] = m.get(a) ?? [0, 0];
        m.set(a, [c + r.caught, n + 1]);
      }
      const ends = this.cfg.lineEnds ?? [];
      perLine = [...m.entries()].sort((x, y) => x[0] - y[0]).map(([a, [c, n]]) => ({
        text: this.cfg.lineText?.[ends.indexOf(this.lineOf(a)[1])] ?? this.words!.slice(a, this.lineOf(a)[1]).join(" "),
        caught: c, tries: n,
      }));
    }

    const summary: SessionSummary = {
      sessionId: this.sessionId, visitId: this.visitId, date: new Date().toISOString(), startedAt: this.startedAt,
      group: this.group, layer: this.layer, layerName: this.cfg.name, completed,
      trialsDone: done, catches, catchRate: done ? r3(rate) : null,
      silentCatchRate: silent.length ? col("caught", silent) : null,
      topNote: label(top), topNoteCatches: topC, topNoteAttempts: topN, perNote: perNote.join("; "),
      reps: this.reps, repsToday: this.repsTodayStart + this.reps, dailyGoal: this.settings.dailyGoal,
      goodFormPct: this.repForms.length ? Math.round(1000 * mean(this.repForms)!) / 10 : null,
      leanMeanPct: col("leanMax"), leanMaxPct: maxOf(rows.map((r) => r.leanMax)),
      hikeMaxPct: maxOf(rows.map((r) => r.hikeMax)), elbowMinDeg: minOf(rows.map((r) => r.elbowMin)),
      elbowMaxDeg: maxOf(rows.map((r) => r.elbowMax)), shoulderMaxDeg: maxOf(rows.map((r) => r.shoulderMax)),
      aimingTimeS: col("aimingTime", stat), maxSpeedPxS: col("maxSpeed"), avgSpeedPxS: col("avgSpeed"),
      vVariation: col("vVariation"), maxVerticalExt: col("maxVerticalExt"), inOutCount: col("inOutCount"),
      velocityPeaks: col("velocityPeaks"), pathEfficiency: col("pathEfficiency"),
      endpointErrorPx: col("endpointErrorPx", stat), noteError: col("noteError", stat),
      predErrorPx: col("predErrorPx"), correctionsPerReach: col("corrections"), intentTimeS: col("intentTime"),
      modelOnPct: pr.length ? Math.round(1000 * mean(pr.map((r) => r.modelOn))!) / 10 : null,
      meanPredCatch: meanOf(pr.map((r) => r.predCatchProb)), brierModel: brier, brierBaseline: base,
      reachMap, anticipationStage: rec.anticStage, movingTrials: moving.length,
      movingCatchRate: moving.length ? col("caught", moving) : null,
      interceptionErrorPx: moving.length ? col("interceptionErrorPx", moving) : null,
      anticipatingPct: strat.length ? Math.round((1000 * strat.filter((s) => s === "anticipating").length) / strat.length) / 10 : null,
      movingOnsetS: moving.length ? col("reactionTime", moving) : null,
      staticMovingGap: gaps.length ? r3(mean(gaps)) : null,
      soundFirstAnticipationRate: col("anticipated", cueRows),
      rtNormalS: col("reactionTime", normal), rtSurpriseS: col("reactionTime", broken),
      firstDirCorrectOnSurprise: col("firstDirectionCorrect", broken),
      learningRateCatchPer10: lrCatch !== null ? r3(lrCatch * 10) : null,
      learningRateAimPer10: lrAim !== null ? r3(lrAim * 10) : null, learningRateSessions: r3(lrSess),
      pheromoneCoverage: r3(coverage)!, frontierCells: frontierN, meanPheromone: Math.round(pherMean * 1e4) / 1e4,
      reachX: r3(this.reach[0]), reachY: r3(this.reach[1]),
      depthRange: this.depthSeen.length > 10 ? r3(percentile(this.depthSeen, 95) - percentile(this.depthSeen, 5)) : null,
      trackingLossPct: this.frames ? Math.round((1000 * this.lost) / this.frames) / 10 : null,
      painBefore: this.painBefore, painAfter, decision, nextLevel: rec.level,
      perLine, pheromone: this.pher.toArray(), score: null,
    };
    summary.score = done ? motorScore(summary) : null;
    return { summary, trials: this.rows, reps: this.repRows, frames: this.frameRows };
  }
}
