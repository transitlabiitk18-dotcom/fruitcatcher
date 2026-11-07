// Game constants, notes, songs and the four parts.
// Ported from fruitcatcher_1cam.py (same names in UPPER_CASE where possible).

export const W = 960; // play area
export const H = 720;

export const CALIB_SECS = 20; // free arm movement: comfortable reach + depth range
export const SNAPSHOT_SECS = 3; // "sit straight" posture reference
export const SNAPSHOT_MIN = 5; // shoulder samples needed for the reference (pose runs ~10 per second)
export const SNAPSHOT_EXTRA = 10; // s to keep waiting for the shoulders after the 3 s
export const FREEPLAY_SECS = 15; // warm-up: move and listen, no fruit (SPACE skips)
export const CALIB_MIN_SECS = 8; // calibration can end early with SPACE after this
export const CATCH_R = 80; // px catch circle around the wrist
export const MISS_LIMIT = 6.0; // s before a still fruit counts as a miss
export const CUE_LEAD = 1.0; // s between sound and fruit in listen-first rounds
export const BRIEF_SHOW = 0.7; // s a fruit stays visible in "quick look" rounds
export const HOLD_SECS = 0.3; // s in the right band for "from memory" rounds
export const HYST = 0.12; // sticky-note rule: pass a border by 12% of a band
export const LOOKAHEAD = 0.1; // s Kalman prediction horizon
export const ONSET_SPEED = 150.0; // px/s = movement started
export const SETTLE_SPEED = 80.0; // px/s = hand is still
export const SILENT_EVERY = 6; // every 6th still fruit: no movement sound
export const REP_MIN_DIST = 60; // px a reach must cover to count as a rep
export const INTENT_COS = 0.9; // heading this close to the fruit direction = intent

export const PASS_RATE = 0.8; // top note >= 80% over >= 4 tries -> move up
export const PASS_MIN = 4;
export const FAIL_RATE = 0.5; // < 50% in 2 sessions in a row -> go back
export const FAIL_STREAK = 2;
export const SURPRISE_P = 0.6;

// pheromone + MCTS
export const GRID = 20;
export const PHER_DEPOSIT = 1.0;
export const PHER_EVAP = 0.005; // per second
export const PHER_SEED = 0.3;
export const COLD_START = 15;
export const BLEND_END = 60;
export const MCTS_C = 0.6;
export const MCTS_TOPK = 5;

// catch-chance model
export const MODEL_MIN_EVENTS = 30;
export const MODEL_LR = 0.05;
export const MODEL_L2 = 0.001;
export const RECENCY = 0.97;
export const MODEL_KEEP_ROWS = 600; // past still trials kept on the patient for pre-training

// moving fruits (anticipation)
export const ANTIC_UNLOCK_RATE = 0.7;
export const ANTIC_UNLOCK_MIN = 5;
export const ANTIC_STAGES: Record<number, [string, number]> = {
  1: ["slow fall", 3.0],
  2: ["fast fall", 1.8],
  3: ["sideways drift", 2.4],
  4: ["curved arc", 2.4],
  5: ["surprise turn", 2.4],
};
export const ANTIC_TAIL = 0.8; // s the fruit keeps moving after its landing point

/** Clinician-adjustable settings (stored on the clinician's account). */
export interface Settings {
  targetP: number; // chance of a catch the fruit placement aims for
  leanLimit: number; // % of shoulder width = leaning
  hikeLimit: number; // % of shoulder width = shoulder hike
  dailyGoal: number; // reps per day
  heatCarry: number; // share of the heat map kept from one part/session to the next (0 = reset)
  strokeAssist: boolean; // stroke group: catch zone +15% once clear intent is seen
}

export const DEFAULT_SETTINGS: Settings = {
  targetP: 0.65,
  leanLimit: 15,
  hikeLimit: 10,
  dailyGoal: 200,
  heatCarry: 0.8,
  strokeAssist: true,
};

// ================================================================ notes
export type Note = "lowPa" | "lowDha" | "lowNi" | "Sa" | "Re" | "Ga" | "Ma" | "Pa" | "Dha" | "Ni";

export const NOTE_HZ: Record<Note, number> = {
  lowPa: 196.0, lowDha: 220.0, lowNi: 246.94, Sa: 261.63, Re: 293.66,
  Ga: 329.63, Ma: 349.23, Pa: 392.0, Dha: 440.0, Ni: 493.88,
};
const NOTE_LABEL: Partial<Record<Note, string>> = {
  lowPa: "Pa (low)", lowDha: "Dha (low)", lowNi: "Ni (low)",
};
export const label = (n: Note) => NOTE_LABEL[n] ?? n;

const TWINKLE: Note[] = ["Sa", "Sa", "Pa", "Pa", "Dha", "Dha", "Pa", "Ma", "Ma", "Ga", "Ga", "Re", "Re", "Sa",
  "Pa", "Pa", "Ma", "Ma", "Ga", "Ga", "Re", "Pa", "Pa", "Ma", "Ma", "Ga", "Ga", "Re",
  "Sa", "Sa", "Pa", "Pa", "Dha", "Dha", "Pa", "Ma", "Ma", "Ga", "Ga", "Re", "Re", "Sa"];
const TWINKLE_BEATS = Array.from({ length: 6 }, () => [1, 1, 1, 1, 1, 1, 2]).flat();
const HAPPY_BIRTHDAY_BEATS = [0.75, 0.25, 1, 1, 1, 2, 0.75, 0.25, 1, 1, 1, 2,
  0.75, 0.25, 1, 1, 1, 1, 2, 0.75, 0.25, 1, 1, 1, 2];
const TWINKLE_LINE_ENDS = [7, 14, 21, 28, 35, 42];
const TWINKLE_WORDS = ["Twin", "kle", "twin", "kle", "lit", "tle", "star",
  "How", "I", "won", "der", "what", "you", "are",
  "Up", "a", "bove", "the", "world", "so", "high",
  "Like", "a", "dia", "mond", "in", "the", "sky",
  "Twin", "kle", "twin", "kle", "lit", "tle", "star",
  "How", "I", "won", "der", "what", "you", "are"];
const TWINKLE_LINES = ["Twinkle, twinkle, little star", "How I wonder what you are",
  "Up above the world so high", "Like a diamond in the sky",
  "Twinkle, twinkle, little star", "How I wonder what you are"];
const HAPPY_BIRTHDAY_LINE_ENDS = [6, 12, 19, 25];
export const SONG_BEAT = 0.5; // seconds per beat in the preview (120 bpm)
const HAPPY_BIRTHDAY: Note[] = ["lowPa", "lowPa", "lowDha", "lowPa", "Sa", "lowNi",
  "lowPa", "lowPa", "lowDha", "lowPa", "Re", "Sa",
  "lowPa", "lowPa", "Pa", "Ga", "Sa", "lowNi", "lowDha",
  "Ma", "Ma", "Ga", "Sa", "Re", "Sa"];
const HAPPY_BIRTHDAY_WORDS = ["Hap", "py", "birth", "day", "to", "you",
  "Hap", "py", "birth", "day", "to", "you",
  "Hap", "py", "birth", "day", "dear", "fri", "end",
  "Hap", "py", "birth", "day", "to", "you"];
const HAPPY_BIRTHDAY_LINES = ["Happy birthday to you", "Happy birthday to you",
  "Happy birthday dear friend", "Happy birthday to you"];

// Instrument recipes (harmonics 1..6), blended left -> right
export const CLARINET = [1.0, 0.05, 0.55, 0.05, 0.3, 0.05];
export const SAX = [1.0, 0.65, 0.5, 0.35, 0.25, 0.15];
export const VIOLIN = [1.0, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6];

// ================================================================ the four parts
export type RoundKind =
  | "warmup" | "scale" | "jump" | "sound_first" | "pattern" | "surprise" | "anticipation"
  | "song_together" | "song_cue_first" | "song_brief" | "song_memory";

export interface RoundOpt { reps?: number; trials?: number; pairs?: number; song?: Note[] }

export interface LayerCfg {
  name: string;
  notes: Note[];
  passNote: Note;
  words?: string[];
  lineText?: string[];
  topName?: string;
  songName?: string;
  beats?: number[];
  lineEnds?: number[];
  rounds: [RoundKind, RoundOpt][];
}

export const LAYERS: Record<number, LayerCfg> = {
  1: {
    name: "3 notes: Sa Re Ga", notes: ["Sa", "Re", "Ga"], passNote: "Ga",
    rounds: [["scale", { reps: 2 }], ["sound_first", { trials: 8 }], ["jump", { pairs: 6 }],
      ["anticipation", { trials: 6 }]],
  },
  2: {
    name: "5 notes: Sa Re Ga Ma Pa", notes: ["Sa", "Re", "Ga", "Ma", "Pa"], passNote: "Pa",
    rounds: [["scale", { reps: 2 }], ["pattern", { reps: 3 }], ["surprise", { reps: 4 }],
      ["sound_first", { trials: 8 }], ["jump", { pairs: 6 }], ["anticipation", { trials: 6 }]],
  },
  3: {
    name: "Twinkle Twinkle Little Star", notes: ["Sa", "Re", "Ga", "Ma", "Pa", "Dha"],
    words: TWINKLE_WORDS, lineText: TWINKLE_LINES, passNote: "Dha", topName: 'top fruits ("little")',
    songName: "Twinkle Twinkle", beats: TWINKLE_BEATS, lineEnds: TWINKLE_LINE_ENDS,
    rounds: [["song_together", { song: TWINKLE }], ["song_cue_first", { song: TWINKLE }],
      ["song_brief", { song: TWINKLE.slice(0, 14) }], ["song_memory", { song: TWINKLE.slice(0, 14) }],
      ["anticipation", { trials: 6 }]],
  },
  5: {
    name: "Happy Birthday", notes: ["lowPa", "lowDha", "lowNi", "Sa", "Re", "Ga", "Ma", "Pa"],
    words: HAPPY_BIRTHDAY_WORDS, lineText: HAPPY_BIRTHDAY_LINES, passNote: "Pa",
    topName: 'top fruit ("birth", line 3)', songName: "Happy Birthday", beats: HAPPY_BIRTHDAY_BEATS,
    lineEnds: HAPPY_BIRTHDAY_LINE_ENDS,
    rounds: [["song_together", { song: HAPPY_BIRTHDAY }], ["song_cue_first", { song: HAPPY_BIRTHDAY }],
      ["song_brief", { song: HAPPY_BIRTHDAY }], ["song_memory", { song: HAPPY_BIRTHDAY }],
      ["anticipation", { trials: 6 }]],
  },
};

export const SEQUENCE = [1, 2, 3, 5]; // play order: 3 -> 5 -> 6 -> 8 notes
export const PART_NAME: Record<number, string> = {
  1: "Sa Re Ga (3 notes)", 2: "Sa Re Ga Ma Pa (5 notes)",
  3: "Twinkle Twinkle (6 notes)", 5: "Happy Birthday (8 notes)",
};
export const PART_BTN: Record<number, string> = {
  1: "3 notes: Sa Re Ga", 2: "5 notes: Sa Re Ga Ma Pa",
  3: "6 notes: Twinkle Twinkle", 5: "8 notes: Happy Birthday",
};

//                                  cueFirst brief  memory song   iti
export const ROUND_STYLE: Record<RoundKind, [boolean, boolean, boolean, boolean, number]> = {
  warmup: [false, false, false, false, 0.8],
  scale: [false, false, false, false, 0.8],
  jump: [false, false, false, false, 0.6],
  sound_first: [true, false, false, false, 0.8],
  pattern: [false, false, false, false, 1.0],
  surprise: [false, false, false, false, 1.0],
  anticipation: [false, false, false, false, 0.8],
  song_together: [false, false, false, true, 0.35],
  song_cue_first: [true, false, false, true, 0.35],
  song_brief: [false, true, false, true, 0.35],
  song_memory: [false, false, true, true, 0.6],
};
export const ROUND_TITLE: Record<RoundKind, string> = {
  warmup: "Warm-up scale", scale: "Scale catch", jump: "Jump catch",
  sound_first: "Listen, then catch", pattern: "Learn the pattern",
  surprise: "Pattern with surprises", anticipation: "Moving fruits",
  song_together: "Melody catch", song_cue_first: "Melody: listen first",
  song_brief: "Melody: quick look", song_memory: "Melody: from memory",
};
export const ROUND_HELP: Record<RoundKind, string> = {
  warmup: "Easy scale to get going - not scored.",
  scale: "Fruits go up and down the scale, one note at a time.",
  jump: "Catch the low fruit, then jump to the faded one. Good pairs make the jump bigger.",
  sound_first: "LISTEN: the note plays first, the fruit appears 1 s later. Start moving early!",
  pattern: "The same up-scale repeats. Learn the pattern.",
  surprise: "The pattern repeats - but sometimes a surprise note breaks it.",
  anticipation: "Fruits MOVE. Go to where the fruit WILL be, not where it is now.",
  song_together: "Catch the fruits in order - they play the song.",
  song_cue_first: "Hear each note first, then the fruit appears.",
  song_brief: "Each fruit shows only for a moment - remember where it was.",
  song_memory: "No fruits! Play the song from memory: hold your hand in each note's band.",
};

// Rainbow, lowest note = red ... highest = violet
export const RAINBOW = ["#ff3737", "#ff8c00", "#ffd700", "#3ce150", "#00d7cd", "#1e91ff", "#7d55ff", "#eb3ceb"];
export const bandColor = (b: number, n: number) =>
  RAINBOW[Math.round((b * (RAINBOW.length - 1)) / Math.max(n - 1, 1))];

export const ZONE_NAMES: Record<string, string> = {
  "0,0": "UL", "0,1": "UC", "0,2": "UR", "1,0": "ML", "1,1": "MC",
  "1,2": "MR", "2,0": "LL", "2,1": "LC", "2,2": "LR",
};
export const zoneOf = (x: number, y: number): [number, number] =>
  [Math.min(Math.floor((y / H) * 3), 2), Math.min(Math.floor((x / W) * 3), 2)];
export const zkey = (z: [number, number]) => `${z[0]},${z[1]}`;
