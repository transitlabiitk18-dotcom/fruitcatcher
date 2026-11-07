"""
fruitcatcher_1cam.py  -  FruitCatcher Music: all four parts in one go
=======================================================================

One run plays the four parts one after another:

    Part 1   3 notes   Sa Re Ga                  scale, listen first, jump, moving fruits
    Part 2   5 notes   Sa Re Ga Ma Pa            + pattern and surprise rounds
    Part 3   6 notes   Twinkle Twinkle           song rounds (words on screen)
    Part 4   8 notes   Happy Birthday            song rounds (words on screen)

Calibration, "sit straight" and warm-up happen once, in Part 1; Parts 2-4 reuse them.
After each part the results show; SPACE starts the next part, Q stops (all saved).
Each part is saved as its own session row (layer 1, 2, 3, 5 - same numbers as the
main game, so the data can be compared).

SCREEN
    Left  = the game (bright colour bands, one colour per note height).
    Right = the side panel: the four note parts (3, 5, 6, 8 notes - click one to switch)
            and the keys (SPACE, P, H, Q). Nothing else, so the screen stays clear.

ONE EXTERNAL WEBCAM
    Put the webcam in front of the patient, at about chest / shoulder height, fixed in
    place (tape or clamp). It gives x and y (up/down, left/right), the body pose, and
    depth (forward/back) from the size of the hand: a hand nearer the camera looks
    bigger. The free arm movement in Part 1 sets the far..near range.
    A camera check screen opens before Part 1.

    The camera and the hand tracking run in the background, so the game screen never
    waits for them. That keeps the game smooth and the notes quick.

Run (Command Prompt, in this folder):
    python fruitcatcher_1cam.py --find-cameras          (shows every camera with its number)
    python fruitcatcher_1cam.py --id P01 --group Y --cam 1
    python fruitcatcher_1cam.py --id P01 --group Y --cam 1 --start 6     (start at Twinkle)
    (--cam 1 is usually the external webcam; the laptop's own camera is usually 0)

CLINICIAN VIEW (shows all the saved metrics on screen; reads the saved data, no webcam needed):
    python fruitcatcher_1cam.py --clinician --id P01
    N / P (or arrow keys, or click a saved part) = next / previous part    Q or Esc = close

Keys:  P pause/resume   H show/hide the LIVE HEAT MAP (where the patient succeeds)   SPACE skip waiting   Q or Esc quit and save
       1 2 3 4 (or click a part in the side panel) = jump to that part (handy for demos).
       The part you leave is saved as "stopped early".

Data is kept apart from the other files:
    data_all_layers/trials.csv, sessions.csv, reps.csv, frames/, pheromone/   (everyone together)
    data_all_layers/participants/<ID>/trials.csv, sessions.csv, reps.csv,
                                      frames/, pheromone/                      (one folder per person)
    patients_all_layers/<ID>.json
"""

import argparse
import csv
import glob
import json
import math
import os
import random
import sys
import threading
import traceback
import time
import wave
from collections import deque
from datetime import datetime

os.environ.setdefault("OPENCV_LOG_LEVEL", "ERROR")   # hide harmless camera-search warnings
import cv2
import numpy as np

try:
    import winsound
except ImportError:
    winsound = None


# ================================================================ paths
HERE = os.path.dirname(os.path.abspath(__file__))
HAND_MODEL = os.path.join(HERE, "hand_landmarker.task")
DATA_DIR = os.path.join(HERE, "data_all_layers")
FRAMES_DIR = os.path.join(DATA_DIR, "frames")
PHER_DIR = os.path.join(DATA_DIR, "pheromone")
PATIENT_DIR = os.path.join(HERE, "patients_all_layers")
SOUND_DIR = os.path.join(HERE, "sounds")
TRIALS_CSV = os.path.join(DATA_DIR, "trials.csv")
SESSIONS_CSV = os.path.join(DATA_DIR, "sessions.csv")
REPS_CSV = os.path.join(DATA_DIR, "reps.csv")

# ================================================================ settings
W, H = 960, 720            # play area
PANEL_W = 340              # side panel (instructions) to the right
WIN = "FruitCatcher - All Layers"

CALIB_SECS = 20            # free arm movement: comfortable reach + depth range
SNAPSHOT_SECS = 3          # "sit straight" posture reference
FREEPLAY_SECS = 15         # warm-up: move and listen, no fruit (SPACE skips)
CALIB_MIN_SECS = 8         # calibration can end early with SPACE after this
CATCH_R = 80               # px catch circle around the wrist
MISS_LIMIT = 6.0           # s before a still fruit counts as a miss
CUE_LEAD = 1.0             # s between sound and fruit in listen-first rounds
BRIEF_SHOW = 0.7           # s a fruit stays visible in "quick look" rounds
HOLD_SECS = 0.3            # s in the right band for "from memory" rounds
HYST = 0.12                # sticky-note rule: pass a border by 12% of a band (small = quick switch)
LOOKAHEAD = 0.1            # s Kalman prediction horizon
ONSET_SPEED = 150.0        # px/s = movement started
SETTLE_SPEED = 80.0        # px/s = hand is still
SILENT_EVERY = 6           # every 6th still fruit: no movement sound
DAILY_GOAL = 200           # reps per day (therapist goal)
REP_MIN_DIST = 60          # px a reach must cover to count as a rep
LEAN_LIMIT = 15.0          # % of shoulder width = leaning
HIKE_LIMIT = 10.0          # % of shoulder width = shoulder hike
INTENT_COS = 0.9           # heading this close to the fruit direction = intent
ASSIST_GROUPS = ("S",)     # groups that get the intent catch-zone assist

PASS_RATE, PASS_MIN = 0.80, 4      # top note >= 80% over >= 4 tries -> move up
FAIL_RATE, FAIL_STREAK = 0.50, 2   # < 50% in 2 sessions in a row -> go back
SURPRISE_P = 0.6

# pheromone + MCTS
GRID = 20
PHER_DEPOSIT = 1.0
PHER_EVAP = 0.005          # per second
PHER_SEED = 0.3
COLD_START = 15
BLEND_END = 60
MCTS_C = 0.6
MCTS_TOPK = 5

# Idea 1 model
TARGET_P = 0.65
MODEL_MIN_EVENTS = 30
MODEL_LR = 0.05
MODEL_L2 = 0.001
RECENCY = 0.97

# Idea 3 anticipation
ANTIC_UNLOCK_RATE, ANTIC_UNLOCK_MIN = 0.70, 5
ANTIC_STAGES = {
    1: ("slow fall", 3.0), 2: ("fast fall", 1.8), 3: ("sideways drift", 2.4),
    4: ("curved arc", 2.4), 5: ("surprise turn", 2.4),
}
ANTIC_TAIL = 0.8           # s the fruit keeps moving after its landing point

# ================================================================ notes
NOTE_HZ = {"lowPa": 196.00, "lowDha": 220.00, "lowNi": 246.94, "Sa": 261.63,
           "Re": 293.66, "Ga": 329.63, "Ma": 349.23, "Pa": 392.00,
           "Dha": 440.00, "Ni": 493.88}
NOTE_WEST = {"lowPa": "G3", "lowDha": "A3", "lowNi": "B3", "Sa": "C4", "Re": "D4",
             "Ga": "E4", "Ma": "F4", "Pa": "G4", "Dha": "A4", "Ni": "B4"}
NOTE_LABEL = {"lowPa": "Pa (low)", "lowDha": "Dha (low)", "lowNi": "Ni (low)"}

TWINKLE = ["Sa", "Sa", "Pa", "Pa", "Dha", "Dha", "Pa", "Ma", "Ma", "Ga", "Ga", "Re", "Re", "Sa",
           "Pa", "Pa", "Ma", "Ma", "Ga", "Ga", "Re", "Pa", "Pa", "Ma", "Ma", "Ga", "Ga", "Re",
           "Sa", "Sa", "Pa", "Pa", "Dha", "Dha", "Pa", "Ma", "Ma", "Ga", "Ga", "Re", "Re", "Sa"]
# Note lengths in beats (for playing the tune correctly before song rounds)
TWINKLE_BEATS = [1, 1, 1, 1, 1, 1, 2] * 6
HAPPY_BIRTHDAY_BEATS = [0.75, 0.25, 1, 1, 1, 2, 0.75, 0.25, 1, 1, 1, 2,
                        0.75, 0.25, 1, 1, 1, 1, 2, 0.75, 0.25, 1, 1, 1, 2]
TWINKLE_LINE_ENDS = [7, 14, 21, 28, 35, 42]          # 6 lines of 7 notes
# One word (syllable) per note, shown on screen instead of the note name
TWINKLE_WORDS = ["Twin", "kle", "twin", "kle", "lit", "tle", "star",
                 "How", "I", "won", "der", "what", "you", "are",
                 "Up", "a", "bove", "the", "world", "so", "high",
                 "Like", "a", "dia", "mond", "in", "the", "sky",
                 "Twin", "kle", "twin", "kle", "lit", "tle", "star",
                 "How", "I", "won", "der", "what", "you", "are"]
TWINKLE_LINES = ["Twinkle, twinkle, little star", "How I wonder what you are",
                 "Up above the world so high", "Like a diamond in the sky",
                 "Twinkle, twinkle, little star", "How I wonder what you are"]
HAPPY_BIRTHDAY_LINE_ENDS = [6, 12, 19, 25]           # 4 lines: "Happy birthday to you" ...
SONG_BEAT = 0.5            # seconds per beat in the preview (120 bpm)
HAPPY_BIRTHDAY = ["lowPa", "lowPa", "lowDha", "lowPa", "Sa", "lowNi",
                  "lowPa", "lowPa", "lowDha", "lowPa", "Re", "Sa",
                  "lowPa", "lowPa", "Pa", "Ga", "Sa", "lowNi", "lowDha",
                  "Ma", "Ma", "Ga", "Sa", "Re", "Sa"]

# Instrument recipes (harmonics 1..6), blended left -> right
CLARINET = np.array([1.0, 0.05, 0.55, 0.05, 0.30, 0.05])
SAX = np.array([1.0, 0.65, 0.50, 0.35, 0.25, 0.15])
VIOLIN = np.array([1.0, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6])

# ================================================================ layers
# ---------------------------------------------------------------- THE FOUR PARTS
HAPPY_BIRTHDAY_WORDS = ["Hap", "py", "birth", "day", "to", "you",
                        "Hap", "py", "birth", "day", "to", "you",
                        "Hap", "py", "birth", "day", "dear", "fri", "end",
                        "Hap", "py", "birth", "day", "to", "you"]
HAPPY_BIRTHDAY_LINES = ["Happy birthday to you", "Happy birthday to you",
                        "Happy birthday dear friend", "Happy birthday to you"]
LAYERS = {
    1: {"name": "3 notes: Sa Re Ga",
        "notes": ["Sa", "Re", "Ga"],
        "pass_note": "Ga",
        "rounds": [
            ("scale",        {"reps": 2}),                  # Sa Re Ga Re Sa Re Ga Re Sa (9)
            ("sound_first",  {"trials": 8}),                # note first, fruit 1 s later (8)
            ("jump",         {"pairs": 6}),                 # Sa -> faded higher fruit (6 pairs)
            ("anticipation", {"trials": 6}),                # moving fruits (6)
        ]},
    2: {"name": "5 notes: Sa Re Ga Ma Pa",
        "notes": ["Sa", "Re", "Ga", "Ma", "Pa"],
        "pass_note": "Pa",
        "rounds": [
            ("scale",        {"reps": 2}),
            ("pattern",      {"reps": 3}),
            ("surprise",     {"reps": 4}),
            ("sound_first",  {"trials": 8}),
            ("jump",         {"pairs": 6}),
            ("anticipation", {"trials": 6}),
        ]},
    3: {"name": "Twinkle Twinkle Little Star",
        "notes": ["Sa", "Re", "Ga", "Ma", "Pa", "Dha"],     # 6 heights (sound only)
        "words": TWINKLE_WORDS, "line_text": TWINKLE_LINES,
        "pass_note": "Dha", "top_name": 'top fruits ("little")',
        "song_name": "Twinkle Twinkle", "beats": TWINKLE_BEATS, "line_ends": TWINKLE_LINE_ENDS,
        "rounds": [
            ("song_together",  {"song": TWINKLE}),          # 42 words
            ("song_cue_first", {"song": TWINKLE}),          # 42 words
            ("song_brief",     {"song": TWINKLE[:14]}),     # 14 words
            ("song_memory",    {"song": TWINKLE[:14]}),     # 14 words, no fruits
            ("anticipation",   {"trials": 6}),
        ]},
    5: {"name": "Happy Birthday",
        "notes": ["lowPa", "lowDha", "lowNi", "Sa", "Re", "Ga", "Ma", "Pa"],  # 8 heights (sound only)
        "words": HAPPY_BIRTHDAY_WORDS, "line_text": HAPPY_BIRTHDAY_LINES,
        "pass_note": "Pa", "top_name": 'top fruit ("birth", line 3)',
        "song_name": "Happy Birthday", "beats": HAPPY_BIRTHDAY_BEATS,
        "line_ends": HAPPY_BIRTHDAY_LINE_ENDS,
        "rounds": [
            ("song_together",  {"song": HAPPY_BIRTHDAY}),   # 25 words
            ("song_cue_first", {"song": HAPPY_BIRTHDAY}),   # 25 words
            ("song_brief",     {"song": HAPPY_BIRTHDAY}),   # 25 words
            ("song_memory",    {"song": HAPPY_BIRTHDAY}),   # 25 words, no fruits
            ("anticipation",   {"trials": 6}),
        ]},
}
SEQUENCE = [1, 2, 3, 5]                     # play order: 3 -> 5 -> 6 -> 8 notes
PART_NAME = {1: "Sa Re Ga (3 notes)", 2: "Sa Re Ga Ma Pa (5 notes)",
             3: "Twinkle Twinkle (6 notes)", 5: "Happy Birthday (8 notes)"}
PART_BTN = {1: "3 notes: Sa Re Ga", 2: "5 notes: Sa Re Ga Ma Pa",
            3: "6 notes: Twinkle Twinkle", 5: "8 notes: Happy Birthday"}
START_BY_NOTES = {3: 0, 5: 1, 6: 2, 8: 3}   # --start 3/5/6/8 -> part index


# ---------------------------------------------------------------- vibrant colours (BGR)
def rgb(r, g, b):
    return (b, g, r)


C_BG = rgb(44, 24, 14)          # panel background (deep warm brown)
C_CARD = rgb(92, 50, 26)        # panel / card boxes (warm rust brown)
C_PINK = rgb(240, 90, 30)       # header bar and accents (warm vermilion; name kept for the code)
C_CYAN = rgb(0, 230, 255)
C_YELLOW = rgb(255, 215, 0)
C_GREEN = rgb(50, 235, 110)
C_ORANGE = rgb(255, 140, 0)
C_PURPLE = rgb(255, 170, 90)    # (unused) warm amber
C_TEXT = rgb(255, 248, 238)     # warm white
C_DIM = rgb(222, 196, 168)      # warm sand
RAINBOW = [rgb(255, 55, 55), rgb(255, 140, 0), rgb(255, 215, 0), rgb(60, 225, 80),
           rgb(0, 215, 205), rgb(30, 145, 255), rgb(125, 85, 255), rgb(235, 60, 235)]


def band_color(b, n):
    """Lowest note = red ... highest note = violet."""
    return RAINBOW[round(b * (len(RAINBOW) - 1) / max(n - 1, 1))]


CURRENT = {"game": None, "part": 0, "done": set(), "help": [], "jump": None}   # side panel state
PART_ROWS = []          # (y_top, y_bottom) of each part button in the side panel (for clicks)
MAX_LAYER = max(LAYERS)

#                  cue_first brief  memory song   iti
ROUND_STYLE = {
    "warmup":         (False, False, False, False, 0.8),
    "scale":          (False, False, False, False, 0.8),
    "jump":           (False, False, False, False, 0.6),
    "sound_first":    (True,  False, False, False, 0.8),
    "pattern":        (False, False, False, False, 1.0),
    "surprise":       (False, False, False, False, 1.0),
    "anticipation":   (False, False, False, False, 0.8),
    "song_together":  (False, False, False, True,  0.35),
    "song_cue_first": (True,  False, False, True,  0.35),
    "song_brief":     (False, True,  False, True,  0.35),
    "song_memory":    (False, False, True,  True,  0.6),
}
ROUND_TITLE = {
    "warmup": "Warm-up scale", "scale": "Scale catch", "jump": "Jump catch",
    "sound_first": "Listen, then catch", "pattern": "Learn the pattern",
    "surprise": "Pattern with surprises", "anticipation": "Moving fruits",
    "song_together": "Melody catch", "song_cue_first": "Melody: listen first",
    "song_brief": "Melody: quick look", "song_memory": "Melody: from memory",
}

ROUND_HELP = {
    "warmup": "Easy scale to get going - not scored.",
    "scale": "Fruits go up and down the scale, one note at a time.",
    "jump": "Catch the low fruit, then jump to the faded one. Good pairs make the jump bigger.",
    "sound_first": "LISTEN: the note plays first, the fruit appears 1 s later. Start moving early!",
    "pattern": "The same up-scale repeats. Learn the pattern.",
    "surprise": "The pattern repeats - but sometimes a surprise note breaks it.",
    "anticipation": "Fruits MOVE. Go to where the fruit WILL be, not where it is now.",
    "song_together": "Catch the fruits in order - they play the song.",
    "song_cue_first": "Hear each note first, then the fruit appears.",
    "song_brief": "Each fruit shows only for a moment - remember where it was.",
    "song_memory": "No fruits! Play the song from memory: hold your hand in each note's band.",
}

TRIAL_FIELDS = [
    "session_id", "participant", "group", "mode", "layer", "round", "trial", "round_pos",
    "target_note", "expected_note", "pattern_broken", "band", "n_bands", "silent", "moving",
    "antic_stage", "path_type", "fruit_x", "fruit_y", "cell_col", "cell_row", "zone",
    "spawn_method", "feat_x", "feat_y", "feat_dist", "feat_pher", "feat_recent",
    "pred_catch_prob", "model_on", "radius_px", "time_limit_s",
    "cue_time", "fruit_time", "onset_time", "intent_time", "catch_time", "caught",
    "caught_with_lean", "aiming_time", "reaction_time", "anticipated",
    "first_direction_correct", "max_speed", "avg_speed", "v_variation", "max_vertical_ext",
    "in_out_count", "velocity_peaks", "corrections", "path_efficiency", "endpoint_error_px",
    "note_error", "pred_error_px", "interception_error_px", "strategy", "lean_max",
    "hike_max", "elbow_min", "elbow_max", "shoulder_max", "depth_mean", "depth_max", "counted",
]
SESSION_FIELDS = [
    "session_id", "date", "participant", "group", "mode", "layer", "layer_name", "completed",
    "trials_done", "catches", "catch_rate", "silent_catch_rate", "top_note",
    "top_note_catches", "top_note_attempts", "per_note",
    "reps", "reps_today", "daily_goal", "good_form_pct", "lean_mean_pct", "lean_max_pct",
    "hike_max_pct", "elbow_min_deg", "elbow_max_deg", "shoulder_max_deg",
    "aiming_time_s", "max_speed_px_s", "avg_speed_px_s", "v_variation", "max_vertical_ext",
    "in_out_count", "velocity_peaks", "path_efficiency", "endpoint_error_px", "note_error",
    "pred_error_px", "corrections_per_reach", "intent_time_s",
    "model_on_pct", "mean_pred_catch", "brier_model", "brier_baseline", "reachability",
    "anticipation_stage", "moving_trials", "moving_catch_rate", "interception_error_px",
    "anticipating_pct", "moving_onset_s", "static_moving_gap",
    "sound_first_anticipation_rate", "rt_normal_s", "rt_surprise_s",
    "first_dir_correct_on_surprise",
    "learning_rate_catch_per10", "learning_rate_aim_per10", "learning_rate_sessions",
    "pheromone_coverage", "frontier_cells", "mean_pheromone", "reach_x", "reach_y",
    "depth_range", "tracking_loss_pct", "pain_before", "pain_after", "decision", "next_layer",
]
REP_FIELDS = ["session_id", "participant", "rep", "t_start", "duration_s", "distance_px",
              "path_px", "straightness", "peak_speed", "target_note", "lean_max", "hike_max",
              "good_form", "elbow_min", "elbow_max", "shoulder_max"]
FRAME_FIELDS = ["t", "seen", "raw_x", "raw_y", "x", "y", "pred_x", "pred_y", "pred_err",
                "speed", "band", "depth", "lean", "hike", "elbow", "shoulder",
                "fruit_x", "fruit_y"]


class QuitSession(Exception):
    pass


class JumpPart(Exception):
    """A part button was clicked (or 1-4 pressed): leave this part and play that one."""


# ================================================================ small helpers
def label(note):
    return NOTE_LABEL.get(note, note)


def _append_one(path, fields, row):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    new = not os.path.exists(path)
    with open(path, "a", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        if new:
            w.writeheader()
        w.writerow(row)


def participant_dir(pid):
    """data_all_layers/participants/<ID>/ - this participant's own copy of every file."""
    return os.path.join(DATA_DIR, "participants", str(pid))


def append_csv(path, fields, row):
    """Write the row to the combined file (all participants) AND to the participant's own file."""
    _append_one(path, fields, row)
    pid = row.get("participant")
    if pid:
        _append_one(os.path.join(participant_dir(pid), os.path.basename(path)), fields, row)


def r3(v):
    return "" if v is None else round(float(v), 3)


def mean_of(vals):
    vals = [float(v) for v in vals if v not in ("", None)]
    return round(float(np.mean(vals)), 3) if vals else ""


def slope(xs, ys):
    if len(xs) < 2 or len(set(xs)) < 2:
        return None
    return float(np.polyfit(np.array(xs, float), np.array(ys, float), 1)[0])


def timbre_weights(t):
    t = min(max(t, 0.0), 1.0)
    if t < 0.5:
        a = t / 0.5
        return (1 - a) * CLARINET + a * SAX
    a = (t - 0.5) / 0.5
    return (1 - a) * SAX + a * VIOLIN


def instrument_name(t):
    return "Clarinet" if t < 0.33 else ("Saxophone" if t < 0.66 else "Violin")


def render_tone(freq, dur, weights, vol, sr=44100, decay=3.0):
    t = np.arange(int(sr * dur)) / sr
    s = sum(w * np.sin(2 * np.pi * freq * (k + 1) * t) for k, w in enumerate(weights))
    env = np.minimum(1.0, t / 0.01) * np.exp(-decay * t / dur)
    s = s * env
    return (s / (np.max(np.abs(s)) + 1e-9) * vol).astype(np.float32)


def write_wav(path, samples, sr=44100):
    with wave.open(path, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(sr)
        wf.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())


# ================================================================ sound engine
class SoundEngine:
    """Real-time synth (sounddevice): one continuous 'arm' voice whose note, instrument
    and loudness follow the hand, plus mixed one-shot sounds (hum, ring, clicks).
    Fallback (winsound): plays pre-rendered note files when the note or instrument
    changes. If neither works, the game runs silently."""

    def __init__(self):
        self.sr = 44100
        self.lock = threading.Lock()
        self.voices = []
        self.freq = NOTE_HZ["Sa"]
        self.weights = timbre_weights(0.0)
        self.amp_target = 0.0
        self.amp = 0.0
        self.phases = np.zeros(6)
        self.shots = {}
        for n, hz in NOTE_HZ.items():
            self.shots["hum_" + n] = render_tone(hz, 0.6, [1, 0.3], 0.35)
            self.shots["ring_" + n] = render_tone(hz, 0.9, SAX, 0.6)
            self.shots["song_" + n] = render_tone(hz, 0.7, [1, 0.45, 0.2, 0.08], 0.75, decay=4.0)
        self.shots["catch"] = np.concatenate(
            [render_tone(f, 0.12, [1, 0.4, 0.2], 0.5) for f in (523.25, 659.25, 783.99)])
        self.shots["miss"] = render_tone(164.81, 0.3, [1, 0.3], 0.3)
        n = int(self.sr * 0.006)
        self.shots["click"] = (np.random.uniform(-1, 1, n) * np.exp(-np.arange(n) / (n / 5)) * 0.4
                               ).astype(np.float32)
        self.backend = None
        self.stream = None
        try:
            import sounddevice as sd
            for lat in ("low", None):          # "low" = much shorter delay between hand and sound
                try:
                    kw = {"latency": lat} if lat else {}
                    self.stream = sd.OutputStream(samplerate=self.sr, channels=1, blocksize=512,
                                                  dtype="float32", callback=self._callback, **kw)
                    self.stream.start()
                    break
                except Exception:
                    self.stream = None
            if self.stream is None:
                raise RuntimeError("no audio stream")
            self.backend = "sounddevice"
        except Exception:
            if winsound is not None:
                self._prepare_winsound()
                self.backend = "winsound"
        self.last_key = None

    # ---- sounddevice
    def _callback(self, out, frames, time_info, status):
        a0 = self.amp
        a1 = a0 + (self.amp_target - a0) * min(1.0, frames / 1100.0)
        self.amp = a1
        k = np.arange(1, 7)[:, None]
        inc = 2 * np.pi * self.freq * k / self.sr
        steps = np.arange(1, frames + 1)[None, :]
        ph = self.phases[:, None] + inc * steps
        w = self.weights
        sig = (w[:, None] * np.sin(ph)).sum(0) / w.sum()
        self.phases = ph[:, -1] % (2 * np.pi)
        buf = sig * np.linspace(a0, a1, frames) * 0.3
        with self.lock:
            keep = []
            for v in self.voices:
                arr, pos = v
                chunk = arr[pos:pos + frames]
                buf[:len(chunk)] += chunk
                if pos + frames < len(arr):
                    keep.append([arr, pos + frames])
            self.voices = keep
        out[:, 0] = np.clip(buf, -1, 1)

    # ---- winsound fallback
    def _prepare_winsound(self):
        os.makedirs(SOUND_DIR, exist_ok=True)
        self.files = {}
        for n, hz in NOTE_HZ.items():
            for ti, t in enumerate((0.0, 0.5, 1.0)):
                for vi, vol in enumerate((0.35, 0.6, 0.9)):
                    p = os.path.join(SOUND_DIR, f"arm_{n}_{ti}_{vi}.wav")
                    write_wav(p, render_tone(hz, 0.4, timbre_weights(t), vol))
                    self.files[(n, ti, vi)] = p
        for name, arr in self.shots.items():
            p = os.path.join(SOUND_DIR, f"{name}.wav")
            write_wav(p, arr * 1.5)
            self.files[name] = p

    def set_motion(self, note, timbre, amp):
        if self.backend == "sounddevice":
            self.freq = NOTE_HZ[note]
            self.weights = timbre_weights(timbre)
            self.amp_target = float(amp)
        elif self.backend == "winsound":
            if amp < 0.08:
                self.last_key = None
                return
            key = (note, int(round(timbre * 2)), min(2, int(amp * 3)))
            if self.last_key is None or key[:2] != self.last_key[:2]:
                winsound.PlaySound(self.files[key], winsound.SND_FILENAME |
                                   winsound.SND_ASYNC | winsound.SND_NODEFAULT)
            self.last_key = key

    def play(self, name):
        if self.backend == "sounddevice":
            with self.lock:
                self.voices.append([self.shots[name], 0])
        elif self.backend == "winsound" and name != "click":
            winsound.PlaySound(self.files[name], winsound.SND_FILENAME |
                               winsound.SND_ASYNC | winsound.SND_NODEFAULT)

    def close(self):
        if self.stream is not None:
            self.stream.stop()
            self.stream.close()


# ================================================================ Kalman (Idea 2)
class Kalman:
    """Constant-velocity Kalman filter on the wrist (screen px). State x, y, vx, vy."""

    def __init__(self, sigma_a=1500.0, meas_px=6.0):
        self.sa = sigma_a
        self.R = np.eye(2) * meas_px ** 2
        self.Hm = np.array([[1, 0, 0, 0], [0, 1, 0, 0]], float)
        self.reset()

    def reset(self):
        self.x = self.P = self.t = None

    @property
    def ready(self):
        return self.x is not None

    def _predict(self, t):
        dt = max(1e-3, min(0.2, t - self.t))
        self.t = t
        F = np.array([[1, 0, dt, 0], [0, 1, 0, dt], [0, 0, 1, 0], [0, 0, 0, 1]], float)
        G = np.array([[dt * dt / 2, 0], [0, dt * dt / 2], [dt, 0], [0, dt]], float)
        self.x = F @ self.x
        self.P = F @ self.P @ F.T + G @ G.T * self.sa ** 2

    def update(self, z, t):
        z = np.asarray(z, float)
        if self.x is None:
            self.x = np.array([z[0], z[1], 0.0, 0.0])
            self.P = np.diag([40.0, 40.0, 400.0, 400.0])
            self.t = t
            return
        self._predict(t)
        y = z - self.Hm @ self.x
        S = self.Hm @ self.P @ self.Hm.T + self.R
        K = self.P @ self.Hm.T @ np.linalg.inv(S)
        self.x = self.x + K @ y
        self.P = (np.eye(4) - K @ self.Hm) @ self.P

    def coast(self, t):
        if self.ready:
            self._predict(t)

    def pos(self):
        return float(self.x[0]), float(self.x[1])

    def vel(self):
        return float(self.x[2]), float(self.x[3])

    def ahead(self, dt):
        return float(self.x[0] + self.x[2] * dt), float(self.x[1] + self.x[3] * dt)


# ================================================================ camera + MediaPipe
POSE_IDX = (11, 12, 13, 14, 15, 16, 23, 24)


CAM_W, CAM_H = 640, 480     # camera picture size (4:3, light on the USB)


def open_cam(idx):
    """Open one external webcam. On Windows DirectShow is used: faster and steadier
    with Logitech cameras. Returns None if the camera gives no picture."""
    cap = cv2.VideoCapture(idx, cv2.CAP_DSHOW) if os.name == "nt" else cv2.VideoCapture(idx)
    if not cap.isOpened():
        return None
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))   # smooth picture, light on the USB
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, CAM_W)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, CAM_H)
    cap.set(cv2.CAP_PROP_FPS, 30)
    cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)      # no old frames waiting in a queue
    for _ in range(10):                      # the first frames are often empty
        ok, f = cap.read()
        if ok and f is not None:
            return cap
        time.sleep(0.05)
    cap.release()
    return None


def find_cameras():
    """LIVE view of every camera that opens, with its number, so the right webcam
    can be picked. (Webcams need about a second to adjust their light, so a single
    snapshot can look black - the live view shows the real picture.)"""
    caps = []
    for i in range(6):
        cap = open_cam(i)
        if cap is not None:
            caps.append((i, cap))
    if not caps:
        print("No camera found. Check the USB cables.")
        return
    print("Cameras found (numbers):", ", ".join(str(i) for i, _ in caps))
    print("A window shows them live. Press any key in that window to close it.")
    win = "Cameras (live) - press any key to close"
    cv2.namedWindow(win, cv2.WINDOW_NORMAL)
    while True:
        tiles = []
        for i, cap in caps:
            ok, f = cap.read()
            t = cv2.resize(cv2.flip(f, 1), (400, 300)) if ok and f is not None else np.zeros((300, 400, 3), np.uint8)
            put(t, f"number {i}", (10, 36), 1.0, C_YELLOW, 2)
            if not ok:
                put(t, "no picture", (10, 150), 0.8, C_PINK, 2)
            tiles.append(t)
        while len(tiles) % 3:
            tiles.append(np.zeros_like(tiles[0]))
        cv2.imshow(win, np.vstack([np.hstack(tiles[k:k + 3]) for k in range(0, len(tiles), 3)]))
        if cv2.waitKey(30) != -1:
            break
    for _, cap in caps:
        cap.release()
    cv2.destroyAllWindows()
    print("Now run with the webcam number, e.g.:  python fruitcatcher_1cam.py --id P01 --group Y --cam 1")


class Tracker:
    """ONE external webcam + MediaPipe, run in background threads.
    The game screen never waits for the camera or the AI: a camera thread grabs frames and
    finds the hand, a second thread finds the body pose (slower, posture does not need
    to be instant), and the game just picks up the newest result each frame.
    x, y   wrist position.
    depth  hand (palm) size in pixels - nearer = bigger. Calibrated to 0..1 in Part 1.
    pose   shoulders, elbows, hips (for lean / shoulder-hike / elbow angle)."""

    def __init__(self, cam=1):
        if not os.path.exists(HAND_MODEL):
            sys.exit(f"hand_landmarker.task not found. Copy it into:\n  {HERE}")
        import mediapipe as mp
        from mediapipe.tasks import python as mp_python
        from mediapipe.tasks.python import vision
        self.mp = mp
        self.cam_id = cam
        self.cap = open_cam(cam)
        if self.cap is None:
            sys.exit(f"Camera number {cam} did not open. Find the number with:  "
                     f"python fruitcatcher_1cam.py --find-cameras")
        self.hands = vision.HandLandmarker.create_from_options(vision.HandLandmarkerOptions(
            base_options=mp_python.BaseOptions(model_asset_path=HAND_MODEL),
            running_mode=vision.RunningMode.VIDEO, num_hands=1,
            min_hand_detection_confidence=0.5, min_hand_presence_confidence=0.5,
            min_tracking_confidence=0.5))
        self.pose_tasks = None
        self.pose_sol = None
        self.pose_mode = "off"
        models = sorted(glob.glob(os.path.join(HERE, "pose_landmarker*.task")))
        if models:
            self.pose_tasks = vision.PoseLandmarker.create_from_options(
                vision.PoseLandmarkerOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=models[0]),
                    running_mode=vision.RunningMode.VIDEO, num_poses=1))
            self.pose_mode = "tasks"
        elif hasattr(mp, "solutions") and hasattr(mp.solutions, "pose"):
            self.pose_sol = mp.solutions.pose.Pose(model_complexity=0)
            self.pose_mode = "solutions"
        self.t0 = time.time()
        self.last_ts = -1
        self.pose_ts = -1
        self.last_pose = None
        self.frame = None
        self.obs = None
        self.pub_t = 0.0
        self.seq = 0
        self.read_seq = 0
        self.pose_src = None
        self.cond = threading.Condition()
        self.running = True
        self.th = threading.Thread(target=self._loop, daemon=True)
        self.th.start()
        self.pth = None
        if self.pose_mode != "off":
            self.pth = threading.Thread(target=self._pose_loop, daemon=True)
            self.pth.start()

    def _loop(self):
        """Camera thread: newest frame -> hand -> publish. Runs as fast as the camera."""
        warned = False
        while self.running:
            try:
                ok, f = self.cap.read()
                if not ok or f is None:
                    time.sleep(0.01)
                    continue
                f = cv2.flip(f, 1)
                ts = max(int((time.time() - self.t0) * 1000), self.last_ts + 1)
                self.last_ts = ts
                rgb_ = cv2.cvtColor(f, cv2.COLOR_BGR2RGB)
                img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb_)
                res = self.hands.detect_for_video(img, ts)
                obs = {"wrist": None, "palm": None, "hand": None}
                if res.hand_landmarks:
                    lm = res.hand_landmarks[0]
                    fh, fw = f.shape[:2]
                    obs["wrist"] = (lm[0].x, lm[0].y)
                    obs["palm"] = math.hypot((lm[9].x - lm[0].x) * fw, (lm[9].y - lm[0].y) * fh)
                    obs["hand"] = res.handedness[0][0].category_name if res.handedness else None
                with self.cond:
                    self.frame, self.obs = f, obs
                    self.seq += 1
                    self.pose_src = (self.seq, rgb_)
                    self.pub_t = time.time()
                    self.cond.notify_all()
            except Exception:
                if not warned:
                    warned = True
                    print("Camera thread problem (it keeps trying):")
                    traceback.print_exc()
                time.sleep(0.05)

    def _pose_loop(self):
        """Pose thread: runs at its own pace (about 10 per second), never blocks the game."""
        last = 0
        warned = False
        while self.running:
            with self.cond:
                src = self.pose_src
            if src is None or src[0] == last:
                time.sleep(0.01)
                continue
            last = src[0]
            try:
                self.last_pose = self._pose(src[1])
            except Exception:
                if not warned:
                    warned = True
                    print("Pose thread problem (posture may be missing):")
                    traceback.print_exc()
            time.sleep(0.05)

    def read(self):
        """Newest (frame, obs). Waits briefly for a NEW frame so the game runs at camera speed."""
        with self.cond:
            if self.seq == self.read_seq:
                self.cond.wait(timeout=0.15)
            if self.frame is None:
                return np.zeros((H, W, 3), np.uint8), None
            self.read_seq = self.seq
            f, o, pub = self.frame, dict(self.obs), self.pub_t
        if time.time() - pub > 0.5:               # camera stopped giving pictures
            o["wrist"] = None
            o["palm"] = None
        o["pose"] = self.last_pose
        return f, o

    def _pose(self, rgb_):
        if self.pose_tasks is not None:
            img = self.mp.Image(image_format=self.mp.ImageFormat.SRGB, data=rgb_)
            self.pose_ts = max(int((time.time() - self.t0) * 1000), self.pose_ts + 1)
            r = self.pose_tasks.detect_for_video(img, self.pose_ts)
            if not r.pose_landmarks:
                return None
            lms = r.pose_landmarks[0]
            return {i: (lms[i].x, lms[i].y,
                        lms[i].visibility if getattr(lms[i], "visibility", None) is not None
                        else 1.0) for i in POSE_IDX}
        r = self.pose_sol.process(rgb_)
        if not r.pose_landmarks:
            return None
        lms = r.pose_landmarks.landmark
        return {i: (lms[i].x, lms[i].y, lms[i].visibility) for i in POSE_IDX}

    def close(self):
        self.running = False
        for t in (self.th, self.pth):
            if t is not None:
                t.join(timeout=1.0)
        self.cap.release()
        self.hands.close()
        if self.pose_tasks is not None:
            self.pose_tasks.close()


# ================================================================ patient record
def record_path(pid):
    return os.path.join(PATIENT_DIR, f"{pid}.json")


def load_record(pid, group):
    path = record_path(pid)
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
    else:
        rec = {"id": pid, "group": group, "layer": 1, "bad_streak": 0, "sessions": 0}
    for k, v in (("stats", {}), ("zones", {}), ("history", []), ("reps_by_date", {}),
                 ("antic_stage", 1), ("aim_median", 1.5), ("bad_streak", 0)):
        rec.setdefault(k, v)
    if group:
        rec["group"] = group
    return rec


def save_record(rec):
    with open(record_path(rec["id"]), "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=2)


# ================================================================ pheromone grid
class Pheromone:
    """20x20 memory of where the patient has succeeded. High = comfortable (avoid);
    the Sobel edge between high and low is the therapeutic frontier."""

    def __init__(self):
        self.g = np.zeros((GRID, GRID), np.float32)
        c = GRID // 2
        self.g[c - 1:c + 2, c - 1:c + 2] = PHER_SEED

    @staticmethod
    def cell_of(x, y):
        return (min(max(int(x / W * GRID), 0), GRID - 1),
                min(max(int(y / H * GRID), 0), GRID - 1))

    @staticmethod
    def center(c, r):
        return (c + 0.5) * W / GRID, (r + 0.5) * H / GRID

    def evaporate(self, dt):
        self.g *= math.exp(-PHER_EVAP * max(dt, 0))

    def deposit(self, x, y, amount):
        c, r = self.cell_of(x, y)
        for dr in (-1, 0, 1):
            for dc in (-1, 0, 1):
                rr, cc = r + dr, c + dc
                if 0 <= rr < GRID and 0 <= cc < GRID:
                    self.g[rr, cc] += amount * (1.0 if dr == dc == 0 else 0.35)

    def frontier(self):
        gx = cv2.Sobel(self.g, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(self.g, cv2.CV_32F, 0, 1, ksize=3)
        mag = np.hypot(gx, gy)
        mx = float(mag.max())
        norm = mag / mx if mx > 1e-6 else mag
        gmax = float(self.g.max())
        mask = (norm > 0.25) & (self.g < 0.5 * gmax + 1e-6)
        return norm, mask

    def stats(self):
        _, mask = self.frontier()
        return float((self.g > 0.15).mean()), int(mask.sum()), float(self.g.mean())


def zone_of(x, y):
    return min(int(y / H * 3), 2), min(int(x / W * 3), 2)


ZONE_NAMES = {(0, 0): "UL", (0, 1): "UC", (0, 2): "UR", (1, 0): "ML", (1, 1): "MC",
              (1, 2): "MR", (2, 0): "LL", (2, 1): "LC", (2, 2): "LR"}


def zkey(z):
    return f"{z[0]},{z[1]}"


# ================================================================ Idea 1: catch-success model
class CatchModel:
    """Online logistic regression: features of a spawn cell -> chance of a catch.
    Pre-trained on this participant's past trials (recent ones weigh more), then
    updated after every catch or miss. Switched on after the cold start."""

    def __init__(self, pid):
        self.w = np.zeros(6)
        self.events = 0
        self.classes = set()
        self._pretrain(pid)

    @staticmethod
    def x(f):
        return np.array([1.0, f["x"], f["y"], f["dist"], f["pher"], f["recent"]])

    def _pretrain(self, pid):
        if not os.path.exists(TRIALS_CSV):
            return
        X, y = [], []
        with open(TRIALS_CSV, newline="", encoding="utf-8") as fh:
            for r in csv.DictReader(fh):
                if r.get("participant") != pid or r.get("counted") != "1" or r.get("moving") != "0":
                    continue
                try:
                    X.append([1.0, float(r["feat_x"]), float(r["feat_y"]), float(r["feat_dist"]),
                              float(r["feat_pher"]), float(r["feat_recent"])])
                    y.append(float(r["caught"]))
                except (KeyError, ValueError):
                    continue
        if not y:
            return
        X, y = np.array(X), np.array(y)
        wts = RECENCY ** np.arange(len(y))[::-1]
        w = np.zeros(6)
        for _ in range(600):
            p = 1 / (1 + np.exp(-X @ w))
            w -= 0.5 * ((X.T @ ((p - y) * wts)) / wts.sum() + MODEL_L2 * np.r_[0, w[1:]])
        self.w = w
        self.events = len(y)
        self.classes = set(y.tolist())

    def ready(self, spawn_idx):
        return (spawn_idx >= COLD_START and self.events >= MODEL_MIN_EVENTS
                and len(self.classes) == 2)

    def predict(self, f):
        return float(1 / (1 + math.exp(-float(self.x(f) @ self.w))))

    def update(self, f, caught):
        xv = self.x(f)
        p = 1 / (1 + math.exp(-float(xv @ self.w)))
        self.w += MODEL_LR * ((caught - p) * xv - MODEL_L2 * np.r_[0, self.w[1:]])
        self.events += 1
        self.classes.add(float(caught))


# ================================================================ spawner (three-tier + MCTS + Idea 1)
class Spawner:
    def __init__(self, game):
        self.g = game
        self.count = 0
        self.cell_stats = {}

    def features(self, c, r):
        g = self.g
        x, y = Pheromone.center(c, r)
        rx, ry = g.rest
        z = zone_of(x, y)
        return {"x": (c + 0.5) / GRID, "y": 1 - (r + 0.5) / GRID,
                "dist": math.hypot(x - rx, y - ry) / math.hypot(W, H),
                "pher": float(g.pher.g[r, c] / (1 + g.pher.g[r, c])),
                "recent": g.zone_recent(z)}

    def chance(self, c, r, f=None):
        f = f or self.features(c, r)
        if self.g.model.ready(self.count):
            return self.g.model.predict(f), True, f
        x, y = Pheromone.center(c, r)
        return f["recent"], False, f

    def choose(self, band=None, restrict=None):
        """Return (col, row, p, model_on, feats, method)."""
        g = self.g
        s = self.count
        self.count += 1
        cols = range(1, GRID - 1)
        allowed = []
        for r in range(GRID):
            y = Pheromone.center(0, r)[1]
            if band is not None and g.band_of_y(y) != band:
                continue
            for c in cols:
                if restrict is not None and zone_of(*Pheromone.center(c, r)) not in restrict:
                    continue
                allowed.append((c, r))
        if not allowed and band is not None:             # band thinner than a grid row
            r = min(max(int(g.band_center(band) / H * GRID), 0), GRID - 1)
            allowed = [(c, r) for c in cols]
        if not allowed:
            allowed = [(c, r) for c in cols for r in range(GRID)]

        if s < COLD_START:                                # tier 1: LEFT/CENTRE/RIGHT cycling
            third = s % 3
            cand = [cr for cr in allowed if int(cr[0] / GRID * 3) == third] or allowed
            c, r = random.choice(cand)
            p, on, f = self.chance(c, r)
            return c, r, p, on, f, "zone_cycle"
        blend = 0.2 + 0.4 * min(1.0, (s - COLD_START) / (BLEND_END - COLD_START))
        if random.random() >= blend:                      # uniform share
            c, r = random.choice(allowed)
            p, on, f = self.chance(c, r)
            return c, r, p, on, f, "uniform"

        mag, mask = g.pher.frontier()                     # Sobel frontier
        cand = [cr for cr in allowed if mask[cr[1], cr[0]]]
        if not cand:
            cand = sorted(allowed, key=lambda cr: -mag[cr[1], cr[0]])[:10]
        total = sum(v[1] for v in self.cell_stats.values()) + 1
        scored = []
        for c, r in cand:                                 # MCTS: UCB1 per cell
            succ, n = self.cell_stats.get((c, r), (0, 0))
            q = 0.5 * float(mag[r, c]) + 0.5 * (succ + 1) / (n + 2)
            ucb = q + MCTS_C * math.sqrt(math.log(total + 1) / (n + 1)) + random.uniform(0, 0.01)
            scored.append((ucb, c, r))
        scored.sort(reverse=True)
        top = scored[:MCTS_TOPK]
        if g.model.ready(s):                              # Idea 1 picks among MCTS top-k
            best = None
            for _, c, r in top:
                f = self.features(c, r)
                p = g.model.predict(f)
                if best is None or abs(p - TARGET_P) < best[0]:
                    best = (abs(p - TARGET_P), c, r, p, f)
            _, c, r, p, f = best
            return c, r, p, True, f, "mcts+prediction"
        _, c, r = top[0]
        p, on, f = self.chance(c, r)
        return c, r, p, on, f, "mcts"

    def record(self, c, r, caught):
        s, n = self.cell_stats.get((c, r), (0, 0))
        self.cell_stats[(c, r)] = (s + caught, n + 1)


# ================================================================ plan for fixed-sequence rounds
def fixed_sequence(rnd, opt, notes):
    """(target, expected, broken) list for scale / pattern / surprise / song rounds."""
    if rnd == "scale":
        seq = []
        for r in range(opt["reps"]):
            seq += (notes if r == 0 else notes[1:]) + notes[-2::-1]
        return [(n, n, 0) for n in seq]
    if rnd == "pattern":
        return [(n, n, 0) for n in notes * opt["reps"]]
    if rnd == "surprise":
        out = []
        for _ in range(opt["reps"]):
            rep = [(n, n, 0) for n in notes]
            if random.random() < SURPRISE_P:
                i = random.randint(2, len(notes) - 1)
                far = notes[0] if i >= len(notes) / 2 else notes[-1]
                rep[i] = (far, notes[i], 1)
            out += rep
        return out
    if rnd.startswith("song_"):
        return [(n, n, 0) for n in opt["song"]]
    return []


# ================================================================ drawing helpers
def put(img, text, org, scale=0.6, color=(255, 255, 255), thick=1):
    cv2.putText(img, text, (org[0] + 1, org[1] + 1), cv2.FONT_HERSHEY_SIMPLEX, scale,
                (0, 0, 0), thick + 2, cv2.LINE_AA)
    cv2.putText(img, text, org, cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)


def put_center(img, text, y, scale=1.0, color=(255, 255, 255), thick=2):
    (tw, _), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)
    put(img, text, ((W - tw) // 2, y), scale, color, thick)


def tint(img, y0, y1, color, alpha):
    """Blend a solid colour over rows y0..y1 only (much cheaper than a whole-frame copy)."""
    y0, y1 = max(0, int(y0)), min(img.shape[0], int(y1))
    if y1 <= y0:
        return
    roi = img[y0:y1]
    solid = np.empty_like(roi)
    solid[:] = color
    roi[:] = cv2.addWeighted(roi, 1 - alpha, solid, alpha, 0)


def blend_circle(img, c, r, color, alpha):
    """Soft filled circle, blended only inside its own small box."""
    x0, y0 = max(c[0] - r - 1, 0), max(c[1] - r - 1, 0)
    x1, y1 = min(c[0] + r + 2, img.shape[1]), min(c[1] + r + 2, img.shape[0])
    if x1 <= x0 or y1 <= y0:
        return
    roi = img[y0:y1, x0:x1]
    ov = roi.copy()
    cv2.circle(ov, (c[0] - x0, c[1] - y0), r, color, -1, cv2.LINE_AA)
    roi[:] = cv2.addWeighted(ov, alpha, roi, 1 - alpha, 0)


def draw_fruit(img, x, y, faded=False):
    c = (int(x), int(y))
    if faded:
        blend_circle(img, c, 30, C_ORANGE, 0.35)
        return
    blend_circle(img, c, 46, C_YELLOW, 0.35)                     # soft yellow glow
    cv2.circle(img, c, 33, rgb(255, 70, 40), -1, cv2.LINE_AA)    # bright red-orange body
    cv2.circle(img, c, 33, rgb(255, 210, 0), 3, cv2.LINE_AA)
    cv2.circle(img, (c[0] - 11, c[1] - 12), 9, rgb(255, 245, 220), -1, cv2.LINE_AA)
    cv2.line(img, (c[0], c[1] - 33), (c[0] + 6, c[1] - 46), rgb(40, 200, 60), 5, cv2.LINE_AA)
    cv2.ellipse(img, (c[0] + 14, c[1] - 42), (11, 5), -20, 0, 360, rgb(60, 230, 80), -1, cv2.LINE_AA)


def dashed_circle(img, c, r, color):
    for a in range(0, 360, 20):
        cv2.ellipse(img, c, (int(r), int(r)), 0, a, a + 10, color, 1, cv2.LINE_AA)


def angle_deg(a, b, c):
    """Angle at b between b->a and b->c, degrees."""
    v1 = np.array(a) - np.array(b)
    v2 = np.array(c) - np.array(b)
    n = np.linalg.norm(v1) * np.linalg.norm(v2)
    if n < 1e-6:
        return None
    return float(np.degrees(np.arccos(np.clip(v1 @ v2 / n, -1, 1))))


# ================================================================ moving-fruit paths (Idea 3)
def make_path(stage, landing, dur):
    lx, ly = landing
    side = random.choice((-1, 1))
    if stage in (1, 2):
        pts = [(lx, -40.0), landing]
        kind = "line"
    elif stage == 3:
        pts = [(min(max(lx + side * 260, 40), W - 40), -40.0), landing]
        kind = "line"
    elif stage == 4:
        sx = -40.0 if side < 0 else W + 40.0
        sy = max(40.0, ly - 200)
        ctrl = ((sx + lx) / 2, min(sy, ly) - 220)
        pts = [(sx, sy), ctrl, landing]
        kind = "arc"
    else:
        start = (min(max(lx + side * 260, 40), W - 40), -40.0)
        mid = (start[0] + 0.6 * (lx - start[0]) - side * 140, start[1] + 0.6 * (ly - start[1]))
        pts = [start, mid, landing]
        kind = "turn"

    def at(u):
        if kind == "line":
            a, b = np.array(pts[0]), np.array(pts[1])
            return a + (b - a) * u
        if kind == "arc":
            a, c, b = (np.array(p) for p in pts)
            if u <= 1:
                return (1 - u) ** 2 * a + 2 * (1 - u) * u * c + u ** 2 * b
            return b + 2 * (b - c) * (u - 1)
        a, m, b = (np.array(p) for p in pts)
        if u < 0.6:
            return a + (m - a) * (u / 0.6)
        return m + (b - m) * ((u - 0.6) / 0.4)

    def pos(t):
        u = t / dur
        return tuple(float(v) for v in at(u))

    return pos, ANTIC_STAGES[stage][0]


# ================================================================ game
class Game:
    def __init__(self, pid, group, mode, layer, record, tracker, pain_before="", part=0, carry=None):
        self.pid, self.group, self.mode, self.layer = pid, group, mode, layer
        self.auto = mode == "auto"
        self.record = record if self.auto else json.loads(json.dumps(record))
        self.cfg = LAYERS[layer]
        self.notes = self.cfg["notes"]
        self.words = self.cfg.get("words")          # song words shown instead of note names
        self.hide_notes = bool(self.words)
        self.N = len(self.notes)
        self.bh = H / self.N
        self.band_img = np.zeros((H, W, 3), np.uint8)       # colour bands, drawn once
        for b_ in range(self.N):
            y0_ = int(H - (b_ + 1) * self.bh)
            cv2.rectangle(self.band_img, (0, y0_), (W, int(y0_ + self.bh)), band_color(b_, self.N), -1)
        self.pain_before = pain_before
        self.session_id = f"{pid}_{datetime.now().strftime('%Y%m%d_%H%M%S')}"
        self.today = datetime.now().strftime("%Y-%m-%d")

        self.tracker = tracker                      # opened once in main(), shared by all parts
        self.part = part                            # 0..3 = which of the four parts
        self.carry = carry                          # calibration from part 1 (parts 2-4)
        self.panel_help = []                        # "what to do" lines in the side panel
        CURRENT["game"] = self
        CURRENT["part"] = part
        self.audio = SoundEngine()
        self.kf = Kalman()
        self.pher = Pheromone()
        self.model = CatchModel(pid)
        self.spawner = Spawner(self)

        self.paused_total = 0.0
        self.calib = None
        self.reach = (None, None)
        self.depth_cal = None
        self.depth = 0.5
        self.depth_seen = []
        self.rest = (W / 2, H * 0.85)
        self.snap = None
        self.body = None
        self.hand_label = ""
        self.last_obs = None
        self.last_seen = -1e9
        self.last_t = None
        self.hand = None
        self.vel = (0.0, 0.0)
        self.speed = 0.0
        self.pred_pos = None
        self.pred_queue = deque()
        self.frame_err = None
        self.cur_band = None
        self.motion_gain = 1.0
        self.current_fruit = None
        self.target_note = None
        self.show_map = False
        self.space = False
        self.frames = 0
        self.lost = 0
        self.frame_rows = []
        self.feedback = None
        self.notice_msg = None
        self.sparks = []
        self.hud = ("", "", "")
        self.rows = []
        self.static_count = 0
        self.trial_no = 0
        self.zone_hist = {}
        self.last_b = None
        # reps
        self.reps = 0
        self.rep_forms = []
        self.moving = False
        self.still_since = None
        self.slow_since = None
        self.mv = None
        self.reps_today_start = self.record["reps_by_date"].get(self.today, 0)

    # ------------------------------------------------------------ basics
    def now(self):
        return time.time() - self.paused_total

    def to_screen(self, raw):
        if self.calib is None:
            return raw[0] * W, raw[1] * H
        x5, x95, y5, y95 = self.calib
        sx = W * (0.15 + 0.70 * (raw[0] - x5) / (x95 - x5))
        sy = H * (0.15 + 0.70 * (raw[1] - y5) / (y95 - y5))
        return min(max(sx, 0), W - 1), min(max(sy, 0), H - 1)

    def band_center(self, b):
        return H - (b + 0.5) * self.bh

    def band_of_y(self, y):
        return min(max(int((H - y) / self.bh), 0), self.N - 1)

    def update_band(self, y):
        u = (H - y) / self.bh
        nb = min(max(int(math.floor(u)), 0), self.N - 1)
        if self.cur_band is None or u > self.cur_band + 1 + HYST or u < self.cur_band - HYST:
            self.cur_band = nb

    def zone_recent(self, z):
        h = self.zone_hist.get(z)
        if h:
            return (sum(h) + 1) / (len(h) + 2)
        c, n = self.record["zones"].get(zkey(z), [0, 0])
        return (c + 1) / (n + 2)

    def notice(self, text, color=(120, 220, 255)):
        self.notice_msg = (text, color, self.now())

    # ------------------------------------------------------------ body (posture + angles)
    def update_body(self, pose, raw):
        if pose is None:
            self.body = None
            return

        def ok(i):
            x, y, v = pose[i]
            return v > 0.5 and 0.02 < x < 0.98 and 0.02 < y < 0.98

        if not (ok(11) and ok(12)):
            self.body = None
            return
        fw, fh = self.fw, self.fh
        P = {i: (pose[i][0] * fw, pose[i][1] * fh) for i in POSE_IDX}
        # tracked arm = the pose wrist nearest the hand landmarker's wrist
        side = 0
        if raw is not None:
            d = [math.hypot(pose[w][0] - raw[0], pose[w][1] - raw[1]) for w in (15, 16)]
            side = 0 if d[0] <= d[1] else 1
        sh, el, wr, hip = (11, 13, 15, 23) if side == 0 else (12, 14, 16, 24)
        other = 12 if side == 0 else 11
        mid = ((P[11][0] + P[12][0]) / 2, (P[11][1] + P[12][1]) / 2)
        width = math.hypot(P[11][0] - P[12][0], P[11][1] - P[12][1])
        b = {"mid": mid, "width": width, "sh": P[sh], "other": P[other],
             "norm": {i: pose[i][:2] for i in (11, 12)},
             "lean": None, "hike": None, "elbow": None, "shoulder": None}
        if self.snap:
            s = self.snap
            shift = math.hypot(mid[0] - s["mid"][0], mid[1] - s["mid"][1]) / s["width"] * 100
            grow = max(0.0, (width - s["width"]) / s["width"] * 100)
            b["lean"] = max(shift, grow)
            diff = P[other][1] - P[sh][1]
            b["hike"] = max(0.0, (diff - s["diff"]) / s["width"] * 100)
        if ok(el) and ok(wr):
            inner = angle_deg(P[sh], P[el], P[wr])
            b["elbow"] = None if inner is None else 180 - inner      # 0 = straight arm
        if ok(el):
            down = P[hip] if ok(hip) else (P[sh][0], P[sh][1] + 100)
            b["shoulder"] = angle_deg(down, P[sh], P[el])           # arm vs trunk
        b["diff"] = P[other][1] - P[sh][1]
        self.body = b

    def good_form(self, lean, hike):
        return (lean is None or lean < LEAN_LIMIT) and (hike is None or hike < HIKE_LIMIT)

    # ------------------------------------------------------------ reps (each reach = 1)
    def update_reps(self, t):
        s = self.speed
        b = self.body or {}
        if not self.moving:
            if s < SETTLE_SPEED:
                if self.still_since is None:
                    self.still_since = t
            elif s > ONSET_SPEED and self.still_since is not None and t - self.still_since >= 0.15:
                self.moving = True
                self.slow_since = None
                self.mv = {"t0": t, "p0": self.hand, "last": self.hand, "path": 0.0, "peak": s,
                           "lean": 0.0, "hike": 0.0, "elbow": [], "shoulder": [],
                           "target": self.current_fruit, "note": self.target_note}
            elif s >= SETTLE_SPEED:
                self.still_since = None
            return
        m = self.mv
        m["path"] += math.hypot(self.hand[0] - m["last"][0], self.hand[1] - m["last"][1])
        m["last"] = self.hand
        m["peak"] = max(m["peak"], s)
        if b.get("lean") is not None:
            m["lean"] = max(m["lean"], b["lean"])
        if b.get("hike") is not None:
            m["hike"] = max(m["hike"], b["hike"])
        if b.get("elbow") is not None:
            m["elbow"].append(b["elbow"])
        if b.get("shoulder") is not None:
            m["shoulder"].append(b["shoulder"])
        if s < SETTLE_SPEED:
            if self.slow_since is None:
                self.slow_since = t
            if t - self.slow_since >= 0.15:
                self.finish_rep(t)
                self.moving = False
                self.still_since = t
        else:
            self.slow_since = None

    def finish_rep(self, t):
        m = self.mv
        dx, dy = self.hand[0] - m["p0"][0], self.hand[1] - m["p0"][1]
        net = math.hypot(dx, dy)
        tgt = m["target"]
        if net < REP_MIN_DIST or tgt is None:
            return
        tx, ty = tgt[0] - m["p0"][0], tgt[1] - m["p0"][1]
        tn = math.hypot(tx, ty)
        if tn < 1 or (dx * tx + dy * ty) < 0.5 * net * tn:     # returning, not reaching
            return
        self.reps += 1
        form = self.good_form(m["lean"] if self.snap else None, m["hike"] if self.snap else None)
        self.rep_forms.append(int(form))
        append_csv(REPS_CSV, REP_FIELDS, {
            "session_id": self.session_id, "participant": self.pid, "rep": self.reps,
            "t_start": r3(m["t0"] - self.session_t0), "duration_s": r3(t - m["t0"]),
            "distance_px": r3(net), "path_px": r3(m["path"]),
            "straightness": r3(net / m["path"]) if m["path"] > 1 else "",
            "peak_speed": r3(m["peak"]), "target_note": m["note"] or "",
            "lean_max": r3(m["lean"]) if self.snap else "", "hike_max": r3(m["hike"]) if self.snap else "",
            "good_form": int(form), "elbow_min": r3(min(m["elbow"])) if m["elbow"] else "",
            "elbow_max": r3(max(m["elbow"])) if m["elbow"] else "",
            "shoulder_max": r3(max(m["shoulder"])) if m["shoulder"] else ""})

    # ------------------------------------------------------------ one frame
    def step(self):
        frame, obs = self.tracker.read()
        t = self.now()
        dt = (t - self.last_t) if self.last_t is not None else 1 / 30
        self.last_t = t
        self.fh, self.fw = frame.shape[:2]
        self.frames += 1
        raw = obs["wrist"] if obs else None
        self.last_obs = obs
        meas = None
        if raw is None:
            self.lost += 1
            self.kf.coast(t)
        else:
            meas = self.to_screen(raw)
            self.kf.update(meas, t)
            self.last_seen = t
            if obs.get("hand"):
                self.hand_label = obs["hand"]
            if obs.get("palm") and self.depth_cal:
                p5, p95 = self.depth_cal
                self.depth = min(max((obs["palm"] - p5) / (p95 - p5), 0.0), 1.0)
                self.depth_seen.append(self.depth)
        if obs:
            self.update_body(obs.get("pose"), raw)
        self.pher.evaporate(dt)

        self.frame_err = None
        if self.kf.ready and t - self.last_seen < 0.3:
            self.hand = self.kf.pos()
            self.vel = self.kf.vel()
            self.speed = math.hypot(*self.vel)
            self.pred_pos = self.kf.ahead(LOOKAHEAD)
            self.pred_queue.append((t + LOOKAHEAD, self.pred_pos))
            while self.pred_queue and self.pred_queue[0][0] <= t:
                _, pp = self.pred_queue.popleft()
                if meas is not None:
                    self.frame_err = math.hypot(pp[0] - meas[0], pp[1] - meas[1])
            if self.calib is not None:
                self.update_band(self.pred_pos[1])
                speed_gain = min(max((self.speed - 25.0) / 175.0, 0.0), 1.0)   # sound starts at once
                amp = (0.3 + 0.7 * self.depth) * speed_gain * self.motion_gain
                self.audio.set_motion(self.notes[self.cur_band], self.hand[0] / W, amp)
        else:
            self.hand = None
            self.vel = (0.0, 0.0)
            self.speed = 0.0
            self.pred_pos = None
            self.audio.set_motion(self.notes[self.cur_band or 0], 0.5, 0.0)

        if self.calib is not None:
            b = self.body or {}
            self.frame_rows.append([
                r3(t - self.session_t0), int(raw is not None),
                r3(raw[0]) if raw else "", r3(raw[1]) if raw else "",
                r3(self.hand[0]) if self.hand else "", r3(self.hand[1]) if self.hand else "",
                r3(self.pred_pos[0]) if self.pred_pos else "",
                r3(self.pred_pos[1]) if self.pred_pos else "", r3(self.frame_err),
                r3(self.speed), self.cur_band if self.cur_band is not None else "",
                r3(self.depth), r3(b.get("lean")), r3(b.get("hike")), r3(b.get("elbow")),
                r3(b.get("shoulder")),
                r3(self.current_fruit[0]) if self.current_fruit else "",
                r3(self.current_fruit[1]) if self.current_fruit else ""])

        canvas = cv2.convertScaleAbs(cv2.resize(frame, (W, H)), alpha=0.35)
        k = getkey(1) & 0xFF
        self.space = k == 32
        if k in (ord("q"), ord("Q"), 27):
            raise QuitSession
        if k in (ord("p"), ord("P")):
            self.pause()
        if k in (ord("h"), ord("H")):
            self.show_map = not self.show_map
        if ord("1") <= k <= ord("4"):
            CURRENT["jump"] = k - ord("1")
        if CURRENT["jump"] is not None:
            if CURRENT["jump"] == self.part:
                CURRENT["jump"] = None
            else:
                raise JumpPart
        return canvas

    def pause(self):
        t0 = time.time()
        self.audio.set_motion("Sa", 0.5, 0.0)
        img = np.zeros((H, W, 3), np.uint8)
        put_center(img, "PAUSED", H // 2 - 20, 1.6)
        put_center(img, "P = continue    Q = quit and save", H // 2 + 40, 0.8)
        while True:
            show(img)
            k = getkey(50) & 0xFF
            if ord("1") <= k <= ord("4"):
                CURRENT["jump"] = k - ord("1")
            if CURRENT["jump"] is not None and CURRENT["jump"] != self.part:
                self.paused_total += time.time() - t0
                raise JumpPart
            if k in (ord("p"), ord("P")):
                break
            if k in (ord("q"), ord("Q"), 27):
                raise QuitSession
        self.paused_total += time.time() - t0
        self.kf.reset()
        self.pred_queue.clear()
        self.last_t = None

    # ------------------------------------------------------------ drawing
    def draw_heat(self, img):
        """LIVE HEAT MAP for the clinician (key H): where the patient succeeds.
        Warm colour = caught here often, blue = not yet; white boxes = the edge, where
        the next fruits are placed."""
        g = self.pher.g / (self.pher.g.max() + 1e-6)
        heat = cv2.applyColorMap((g * 255).astype(np.uint8), cv2.COLORMAP_JET)
        heat = cv2.resize(heat, (W, H), interpolation=cv2.INTER_LINEAR)
        a = cv2.resize((0.15 + 0.55 * g).astype(np.float32), (W, H), interpolation=cv2.INTER_LINEAR)[..., None]
        img[:] = (img * (1 - a) + heat * a).astype(np.uint8)
        _, mask = self.pher.frontier()
        for r, c in zip(*np.nonzero(mask)):
            x0, y0 = int(c * W / GRID), int(r * H / GRID)
            cv2.rectangle(img, (x0, y0), (int(x0 + W / GRID), int(y0 + H / GRID)), (255, 255, 255), 2)
        tint(img, 0, 66, (0, 0, 0), 0.6)
        ptext(img, "LIVE HEAT MAP   (press H to hide)", 14, 26, 0.65, C_YELLOW, 2)
        ptext(img, "Red = caught here often    Blue = not yet    White boxes = edge, where new fruits go",
              14, 54, 0.5, C_TEXT, 1)

    def draw_scene(self, img, target_band=None):
        """Play area only: colour bands, note names, fruit, hand (and the heat map on H)."""
        cv2.addWeighted(img, 0.70, self.band_img, 0.30, 0, img)   # one colour per note height
        if self.show_map:
            self.draw_heat(img)
        if self.cur_band is not None and self.hand is not None:   # band under the hand glows
            y0 = int(H - (self.cur_band + 1) * self.bh)
            tint(img, y0, int(y0 + self.bh) + 1, band_color(self.cur_band, self.N), 0.50)
        if target_band is not None:
            y0 = int(H - (target_band + 1) * self.bh)
            cv2.rectangle(img, (3, y0 + 3), (W - 4, int(y0 + self.bh) - 3), C_YELLOW, 3)
        for i in range(1, self.N):
            y = int(H - i * self.bh)
            cv2.line(img, (0, y), (W, y), (215, 215, 215), 1, cv2.LINE_AA)
        if not self.hide_notes:
            for b, n in enumerate(self.notes):
                on = b == self.cur_band
                put(img, label(n), (12, int(self.band_center(b)) + 8), 0.85 if on else 0.7,
                    band_color(b, self.N), 3 if on else 2)

        # posture: shoulder line only (green = good, orange = leaning / shoulder up)
        b = self.body
        if b:
            n11, n12 = b["norm"][11], b["norm"][12]
            p1 = (int(n11[0] * W), int(n11[1] * H))
            p2 = (int(n12[0] * W), int(n12[1] * H))
            okf = self.good_form(b.get("lean"), b.get("hike"))
            cv2.line(img, p1, p2, C_GREEN if okf else C_ORANGE, 4, cv2.LINE_AA)
        if self.snap:
            for nx, ny in self.snap["norm"].values():
                c = (int(nx * W), int(ny * H))
                cv2.line(img, (c[0] - 6, c[1]), (c[0] + 6, c[1]), (255, 255, 255), 1)
                cv2.line(img, (c[0], c[1] - 6), (c[0], c[1] + 6), (255, 255, 255), 1)

        # wrist pointer + catch zone
        if self.hand is not None:
            hx, hy = int(self.hand[0]), int(self.hand[1])
            cv2.circle(img, (hx, hy), 13, C_CYAN, -1, cv2.LINE_AA)
            cv2.circle(img, (hx, hy), 13, (255, 255, 255), 2, cv2.LINE_AA)
            for a in range(0, 360, 20):
                cv2.ellipse(img, (hx, hy), (CATCH_R, CATCH_R), 0, a, a + 10, C_CYAN, 2, cv2.LINE_AA)
        elif self.calib is not None and self.now() - self.last_seen > 0.5:
            put_center(img, "Hand not seen", H // 2 + 60, 1.0, C_PINK, 2)

        # sparks (rainbow)
        t = self.now()
        alive = []
        for (x, y, vx, vy, t0) in self.sparks:
            a = t - t0
            if a < 0.6:
                cv2.circle(img, (int(x + vx * a), int(y + vy * a + 300 * a * a)), 4,
                           RAINBOW[int(abs(vx)) % len(RAINBOW)], -1)
                alive.append((x, y, vx, vy, t0))
        self.sparks = alive

        if self.feedback and t - self.feedback[2] < 1.2:
            put_center(img, self.feedback[0], 120, 0.9, self.feedback[1], 2)
        if self.notice_msg and t - self.notice_msg[2] < 2.0:
            put_center(img, self.notice_msg[0], 160, 0.8, self.notice_msg[1], 2)

    def panel(self):
        """Side panel while playing: the four note parts (click to switch) and the keys."""
        p, y = panel_base()
        keys = [("SPACE", "skip waiting / continue", C_TEXT), ("P", "pause / resume", C_TEXT),
                ("H", "live heat map: " + ("ON" if self.show_map else "off"),
                 C_GREEN if self.show_map else C_TEXT),
                ("Q or Esc", "quit and save", C_TEXT)]
        hh = 18 + 26 * len(keys)
        cv2.rectangle(p, (10, y - 20), (PANEL_W - 10, y + hh), C_CARD, -1)
        cv2.rectangle(p, (10, y - 20), (14, y + hh), C_GREEN, -1)
        ptext(p, "KEYS", 24, y, 0.5, C_GREEN, 2)
        for i, (k_, what, col) in enumerate(keys):
            ptext(p, k_, 24, y + 28 + 26 * i, 0.5, C_YELLOW, 2)
            ptext(p, what, 124, y + 28 + 26 * i, 0.48, col, 1)
        return p

    def top_name(self):
        top = self.cfg["pass_note"]
        return self.cfg.get("top_name", label(top)) if self.hide_notes else label(top)

    def line_of(self, idx):
        """(start, end) of the song line that contains note number idx."""
        ends = self.cfg.get("line_ends") or [len(self.words or [])]
        start = 0
        for e in ends:
            if idx < e:
                return start, e
            start = e
        return start, len(self.words or [])

    def draw_lyrics(self, img, idx, y=160):
        """Karaoke line: the words of the current line, the current word in green."""
        if not self.words or idx is None or idx >= len(self.words):
            return
        a, b = self.line_of(idx)
        parts = self.words[a:b]
        scale, gap = 0.8, 14
        widths = [cv2.getTextSize(w, cv2.FONT_HERSHEY_SIMPLEX, scale, 2)[0][0] for w in parts]
        total = sum(widths) + gap * (len(parts) - 1)
        x = (W - total) // 2
        bx0, bx1 = max(x - 16, 0), min(x + total + 16, img.shape[1])
        by0, by1 = max(y - 30, 0), min(y + 12, img.shape[0])
        if bx1 > bx0 and by1 > by0:
            img[by0:by1, bx0:bx1] = cv2.convertScaleAbs(img[by0:by1, bx0:bx1], alpha=0.4, beta=12)
        for i, (w_, tw) in enumerate(zip(parts, widths)):
            on = a + i == idx
            put(img, w_, (x, y), scale, (120, 255, 120) if on else (210, 210, 210), 3 if on else 2)
            x += tw + gap

    def pass_progress(self):
        top = self.cfg["pass_note"]
        rs = [r for r in self.rows if r["counted"] == 1 and r["moving"] == 0 and r["target_note"] == top]
        c = sum(r["caught"] for r in rs)
        return f"{self.top_name().capitalize()}: {c}/{len(rs)} caught"

    def card(self, title, lines, secs=6.0):
        """Explanation screen over the camera view; SPACE continues early."""
        self.motion_gain = 0.0
        t0 = self.now()
        while self.now() - t0 < secs:
            img = self.step()
            ov = img.copy()
            cv2.rectangle(ov, (60, 110), (W - 60, H - 110), C_CARD, -1)
            cv2.addWeighted(ov, 0.9, img, 0.1, 0, img)
            cv2.rectangle(img, (60, 110), (W - 60, 128), C_PINK, -1)
            put_center(img, title, 172, 0.95, C_YELLOW, 2)
            y = 225
            for ln in lines:
                put_center(img, ln, y, 0.62, C_TEXT, 1)
                y += 34
            put_center(img, f"Starts in {max(0, secs - (self.now() - t0)):.0f} s   (SPACE = start now)",
                       H - 140, 0.65, C_GREEN, 2)
            show(img)
            if self.space:
                break
        self.motion_gain = 1.0

    def song_preview(self, song, start=0, title=None):
        """Play the tune (or one line of it, from index `start`) with its real rhythm,
        highlighting each note's band. SPACE skips."""
        beats = self.cfg.get("beats", [1] * (start + len(song)))[start:start + len(song)]
        times, t = [], 0.0
        for b in beats:
            times.append(t)
            t += b * SONG_BEAT
        total = t + 0.8
        self.motion_gain = 0.0
        t0 = self.now()
        played = 0
        while self.now() - t0 < total:
            img = self.step()
            el = self.now() - t0
            while played < len(song) and el >= times[played]:
                self.audio.play("song_" + song[played])
                played += 1
            cur = played - 1
            if cur >= 0:                                  # light up the band of the note now playing
                b = self.notes.index(song[cur])
                y0 = int(H - (b + 1) * self.bh)
                tint(img, y0, int(y0 + self.bh) + 1, band_color(b, self.N), 0.45)
            if not self.hide_notes:
                for b, n in enumerate(self.notes):
                    put(img, label(n), (10, int(self.band_center(b)) + 6), 0.65, (230, 230, 230), 2)
            put_center(img, title or f"LISTEN: this is how {self.cfg.get('song_name', 'the song')} sounds",
                       60, 0.85, (255, 220, 120), 2)
            if self.words:
                self.draw_lyrics(img, start + max(cur, 0), y=115)
            else:
                line_start = 0 if title else (max(cur, 0) // 7) * 7
                words = song[line_start:line_start + 7]
                x = 140
                for i, n in enumerate(words):
                    col = (120, 255, 120) if line_start + i == cur else (220, 220, 220)
                    put(img, label(n), (x, 110), 0.75, col, 2)
                    x += 100
            put_center(img, "(SPACE = skip)", H - 30, 0.55, (170, 170, 170), 1)
            show(img)
            if self.space:
                break
        self.motion_gain = 1.0

    def intro(self):
        names = [ROUND_TITLE[r] for r, _ in self.cfg["rounds"]]
        first = (f"Song: {self.cfg.get('song_name')} - {self.N} heights, low to high" if self.hide_notes
                 else f"Notes in this part: {'  '.join(label(n) for n in self.notes)}")
        steps = ("Set-up: 1. Calibration (about 20 s)   2. Sit straight (3 s)   3. Warm-up (15 s)"
                 if not self.carry else "Same calibration as before - the rounds start next.")
        lines = [first, steps, f"Rounds: {', '.join(names)}",
                 "Catch a fruit by moving your wrist circle onto it.", "",
                 "Instructions stay in the panel on the right while you play."]
        self.panel_help = ["Read the card. SPACE = start now."]
        self.card(f"PART {self.part + 1} of {len(SEQUENCE)}: {PART_NAME[self.layer].upper()}", lines,
                  secs=12 if not self.carry else 8)

    # ------------------------------------------------------------ phases
    def calibrate(self):
        pts, palms = [], []
        self.panel_help = ["Move your arm as far as is comfortable: up, down, left, right.",
                           "Also reach forward and pull back - this sets the depth range.",
                           "SPACE = done (after 8 s)."]
        t0 = self.now()
        while self.now() - t0 < CALIB_SECS:
            img = self.step()
            o = self.last_obs
            if o and o["wrist"] is not None:
                pts.append(o["wrist"])
                if o.get("palm"):
                    palms.append(o["palm"])
                cv2.circle(img, (int(o["wrist"][0] * W), int(o["wrist"][1] * H)), 12, (255, 255, 0), -1)
            put_center(img, "CALIBRATION", 60, 1.0, C_YELLOW, 2)
            put_center(img, f"{max(0, CALIB_SECS - (self.now() - t0)):.0f}", H // 2, 2.0)
            if self.now() - t0 > CALIB_MIN_SECS:
                put_center(img, "SPACE = done", H - 60, 0.7, C_GREEN, 2)
            show(img)
            if self.space and self.now() - t0 > CALIB_MIN_SECS:
                break
        if len(pts) >= 40:
            a = np.array(pts)
            x5, x95 = np.percentile(a[:, 0], [5, 95])
            y5, y95 = np.percentile(a[:, 1], [5, 95])
        else:
            x5, x95, y5, y95 = 0.2, 0.8, 0.2, 0.8
        if x95 - x5 < 0.08:
            m = (x5 + x95) / 2
            x5, x95 = m - 0.04, m + 0.04
        if y95 - y5 < 0.08:
            m = (y5 + y95) / 2
            y5, y95 = m - 0.04, m + 0.04
        self.calib = (float(x5), float(x95), float(y5), float(y95))
        self.reach = (x95 - x5, y95 - y5)
        if len(palms) >= 20:
            p5, p95 = np.percentile(palms, [5, 95])
            if p95 - p5 < 0.3 * np.median(palms):
                m = np.median(palms)
                p5, p95 = m * 0.8, m * 1.2
        else:
            p5, p95 = 40.0, 90.0
        self.depth_cal = (float(p5), float(p95))
        self.kf.reset()
        self.pred_queue.clear()
        self.cur_band = None

    def snapshot(self):
        """'Sit straight, arm relaxed': posture reference + resting hand position."""
        mids, widths, diffs, norms, hands = [], [], [], [], []
        self.panel_help = ["Sit up straight.", "Rest your arm.",
                           "This is the posture reference for leaning and shoulder lift."]
        t0 = self.now()
        while self.now() - t0 < SNAPSHOT_SECS:
            img = self.step()
            if self.body:
                mids.append(self.body["mid"])
                widths.append(self.body["width"])
                diffs.append(self.body["diff"])
                norms.append(self.body["norm"])
            if self.hand is not None:
                hands.append(self.hand)
            put_center(img, "SIT STRAIGHT", 80, 1.0, C_YELLOW, 2)
            put_center(img, f"{SNAPSHOT_SECS - (self.now() - t0):.0f}", H // 2, 1.8)
            show(img)
        if mids:
            self.snap = {"mid": tuple(np.mean(mids, 0)), "width": float(np.mean(widths)),
                         "diff": float(np.mean(diffs)),
                         "norm": {i: tuple(np.mean([n[i] for n in norms], 0)) for i in (11, 12)}}
        if hands:
            self.rest = tuple(np.median(hands, 0))

    def free_play(self):
        self.motion_gain = 1.0
        self.target_note = None
        t0 = self.now()
        self.hud = ("Warm-up: free play", "", "")
        self.panel_help = ["Move and listen - no fruits yet.", "Up / down = note",
                           "Left / right = instrument", "Forward / back = loudness",
                           "SPACE = start the fruits now."]
        while self.now() - t0 < FREEPLAY_SECS:
            img = self.step()
            self.draw_scene(img)
            put_center(img, "WARM-UP", 200, 1.0, C_YELLOW, 2)
            put_center(img, f"Fruits in {max(0, FREEPLAY_SECS - (self.now() - t0)):.0f} s   (SPACE = start now)",
                       H // 2, 0.9, (200, 255, 200))
            show(img)
            if self.space:
                break

    # ------------------------------------------------------------ one fruit
    def run_trial(self, rnd, target=None, expected=None, broken=0, pos=0, length=1,
                  counted=True, preset=None, preview=None, moving=False, restrict=None,
                  hud_extra=""):
        cue_first, brief, memory, song, iti = ROUND_STYLE[rnd]
        word = self.words[pos] if (song and self.words and pos < len(self.words)) else None
        t_start = self.now()
        silent = False
        if counted and not (memory or song or moving):
            self.static_count += 1
            silent = self.static_count % SILENT_EVERY == 0
        # songs: arm voice off, so only the melody notes are heard
        self.motion_gain = 0.0 if (silent or song) else 1.0

        band = self.notes.index(target) if target else None
        c, r, p, model_on, feats, method = preset or self.spawner.choose(band, restrict)
        fx, fy = Pheromone.center(c, r)
        fx += random.uniform(-0.3, 0.3) * W / GRID
        if band is None:
            band = self.band_of_y(fy)
            target = self.notes[band]
        lo, hi = H - (band + 1) * self.bh, H - band * self.bh
        fy = min(max(fy, lo + 0.2 * self.bh), hi - 0.2 * self.bh)
        fy = min(max(fy, 40), H - 40)
        expected = expected or target
        self.target_note = target
        landing = (fx, fy)

        radius = CATCH_R
        limit = MISS_LIMIT
        stage = path_name = ""
        path = None
        if moving:
            stage = self.record["antic_stage"]
            speed_f = min(max(self.record["aim_median"] / 1.5, 0.8, ), 2.0)
            dur = ANTIC_STAGES[stage][1] * speed_f
            path, path_name = make_path(stage, landing, dur)
            limit = dur + ANTIC_TAIL
            radius = CATCH_R * 1.1                      # allowance for webcam delay
        elif song and p < 0.5:
            radius, limit = CATCH_R * 1.3, MISS_LIMIT * 1.5

        cue_t = t_start + iti
        fruit_t = cue_t + (CUE_LEAD if cue_first else 0.0)
        end_t = fruit_t + limit
        if silent:
            self.notice("Silent try - no sound this time", (200, 200, 255))

        hummed = False
        settled_since = onset = dir_ok = None
        hold_since = None
        caught = 0
        catch_t = None
        # per-trial measures
        speeds, peaks = [], 0
        path_len = 0.0
        start_pos = last_pos = None
        max_ext = 0.0
        inside = False
        in_out = 0
        intent_since = intent_t = None
        endpoint = None
        end_slow = None
        min_dist = None
        d_start = None
        strategy = ""
        onset_hand = onset_fruit = None
        errs = []
        leans, hikes, elbows, shoulders, depths = [], [], [], [], []
        assist = False
        song_name = self.cfg.get("song_name", "")
        self.hud = (f"{ROUND_TITLE[rnd]} {(song_name + ' ') if song else ''}({pos + 1}/{length})",
                    (f"Fruit {self.trial_no + 1}" if counted else "warm-up") +
                    "",   # prediction is still used and saved, just not shown on screen
                    hud_extra or (f"Moving fruit: stage {stage} {path_name}" if moving else ""))

        while True:
            img = self.step()
            t = self.now()
            fpos = None
            if t >= fruit_t:
                fpos = path(t - fruit_t) if moving else landing
            self.current_fruit = fpos if not memory else (W / 2, self.band_center(band)) \
                if t >= fruit_t else None

            # fruit hums its note when it appears (before it, in listen-first rounds)
            if not hummed and not memory and not silent and (cue_first or not song):
                if (cue_first and t >= cue_t) or (not cue_first and t >= fruit_t):
                    self.audio.play("hum_" + target)
                    hummed = True

            h = self.hand
            if h is not None and t >= t_start + 0.2 and onset is None:
                if self.speed < SETTLE_SPEED:
                    if settled_since is None:
                        settled_since = t
                elif self.speed > ONSET_SPEED and settled_since is not None and t - settled_since >= 0.15:
                    onset = t
                    ref = fpos or landing
                    dy = ref[1] - h[1]
                    if abs(dy) > self.bh * 0.5 and abs(self.vel[1]) > 1e-6:
                        dir_ok = int(np.sign(self.vel[1]) == np.sign(dy))
                    onset_hand, onset_fruit = h, fpos
                else:
                    settled_since = None

            if h is not None and t >= fruit_t:
                # Chung + Idea 2 measures
                if start_pos is None:
                    start_pos = last_pos = h
                path_len += math.hypot(h[0] - last_pos[0], h[1] - last_pos[1])
                last_pos = h
                speeds.append(self.speed)
                if len(speeds) >= 3 and speeds[-2] > speeds[-3] and speeds[-2] >= speeds[-1] \
                        and speeds[-2] > ONSET_SPEED:
                    peaks += 1
                    if peaks > 1 and not silent:
                        self.audio.play("click")            # shaky movement = clicks
                max_ext = max(max_ext, 1 - h[1] / H)
                if self.frame_err is not None:
                    errs.append(self.frame_err)
                ref = fpos if fpos is not None else (h[0], self.band_center(band))
                d = math.hypot(h[0] - ref[0], h[1] - ref[1])
                if d_start is None:
                    d_start = d
                min_dist = d if min_dist is None else min(min_dist, d)
                now_in = d < radius
                if now_in and not inside:
                    in_out += 1
                inside = now_in
                if intent_t is None and self.speed > ONSET_SPEED and d > 1:
                    cosv = ((ref[0] - h[0]) * self.vel[0] + (ref[1] - h[1]) * self.vel[1]) / (d * self.speed)
                    if cosv > INTENT_COS:
                        intent_since = intent_since or t
                        if t - intent_since >= 0.15:
                            intent_t = t
                            if self.group in ASSIST_GROUPS and not assist:
                                assist = True
                                radius *= 1.15            # reward clear intent
                    else:
                        intent_since = None
                if onset is not None and endpoint is None:
                    if self.speed < SETTLE_SPEED:
                        end_slow = end_slow or t
                        if t - end_slow >= 0.15:
                            endpoint = h
                    else:
                        end_slow = None
                if moving and onset_hand is not None and not strategy and \
                        math.hypot(h[0] - onset_hand[0], h[1] - onset_hand[1]) > 25:
                    mvx, mvy = h[0] - onset_hand[0], h[1] - onset_hand[1]
                    cur = onset_fruit or fpos

                    def ang(tx, ty):
                        n = math.hypot(tx, ty) * math.hypot(mvx, mvy)
                        return math.acos(max(-1, min(1, (tx * mvx + ty * mvy) / n))) if n else math.pi
                    a_cur = ang(cur[0] - onset_hand[0], cur[1] - onset_hand[1])
                    a_land = ang(landing[0] - onset_hand[0], landing[1] - onset_hand[1])
                    strategy = "anticipating" if a_land < a_cur else "chasing"
            b = self.body or {}
            if t >= fruit_t:
                for lst, key in ((leans, "lean"), (hikes, "hike"), (elbows, "elbow"), (shoulders, "shoulder")):
                    if b.get(key) is not None:
                        lst.append(b[key])
                if h is not None:
                    depths.append(self.depth)

            # catch check
            if t >= fruit_t and h is not None:
                if memory:
                    if self.cur_band == band:
                        hold_since = hold_since or t
                        if t - hold_since >= HOLD_SECS:
                            caught = 1
                    else:
                        hold_since = None
                else:
                    d = math.hypot(h[0] - fpos[0], h[1] - fpos[1])
                    # inside the circle, or in the right note band and close enough
                    near_band = (not moving and self.cur_band == band
                                 and abs(h[0] - fpos[0]) < 1.25 * radius
                                 and abs(h[1] - fpos[1]) < 0.6 * self.bh)
                    if d < radius or near_band:
                        caught = 1
            if caught:
                catch_t = t
                break
            if t >= end_t:
                break

            # draw
            self.draw_scene(img, target_band=None if memory else band)
            visible = t >= fruit_t and not memory and not (brief and t > fruit_t + BRIEF_SHOW)
            if word:
                self.draw_lyrics(img, pos)
            if visible and fpos is not None:
                draw_fruit(img, *fpos)
                if word:
                    (tw, _), _ = cv2.getTextSize(word, cv2.FONT_HERSHEY_SIMPLEX, 0.8, 2)
                    put(img, word, (int(fpos[0] - tw / 2), int(fpos[1] - 48)), 0.8, (255, 255, 255), 2)
            if preview is not None:
                draw_fruit(img, *preview, faded=True)
            if cue_first and cue_t <= t < fruit_t:
                put_center(img, "Listen...", H // 2, 1.4, (255, 220, 120), 3)
            if memory and t >= fruit_t:
                if word:
                    put_center(img, f'From memory: raise your hand to the height of "{word}"',
                                250, 0.75, (255, 220, 120), 2)
                else:
                    put_center(img, f"From memory: note {pos + 1} of {length}", 200, 0.9, (255, 220, 120))
            show(img)

        # ---------- outcome
        lean_max = max(leans) if leans else None
        hike_max = max(hikes) if hikes else None
        with_lean = bool(caught and not self.good_form(lean_max, hike_max))
        if caught:
            self.audio.play(("song_" if song else "ring_") + target)
            hp = self.hand or landing
            for _ in range(14):
                a = random.uniform(0, 2 * math.pi)
                v = random.uniform(80, 240)
                self.sparks.append((hp[0], hp[1], v * math.cos(a), v * math.sin(a) - 120, catch_t))
            if with_lean:
                self.feedback = ("Caught - next time sit back and stretch the arm", (0, 200, 255), catch_t)
            else:
                self.feedback = (f"+1  {word if word else ('' if self.hide_notes else label(target))}",
                                 (80, 255, 80), catch_t)
            if counted:
                self.pher.deposit(*(fpos if not memory else (W / 2, self.band_center(band))),
                                  PHER_DEPOSIT * (0.5 if with_lean else 1.0))
        else:
            self.audio.play("miss")
            self.feedback = ("Missed", (80, 80, 255), self.now())

        end_h = self.hand
        if endpoint is None:
            endpoint = end_h
        ref_end = landing if not moving else (fpos or landing)
        endpoint_err = math.hypot(endpoint[0] - ref_end[0], endpoint[1] - ref_end[1]) if endpoint else None
        note_err = abs(self.band_of_y(endpoint[1]) - band) if endpoint else None
        straight = (math.hypot(last_pos[0] - start_pos[0], last_pos[1] - start_pos[1]) / path_len
                    if start_pos is not None and path_len > 20 else None)
        active = [s for s in speeds if s > SETTLE_SPEED]
        rt = (onset - cue_t) if onset is not None else None
        z = zone_of(*landing)

        row = {
            "session_id": self.session_id, "participant": self.pid, "group": self.group,
            "mode": self.mode, "layer": self.layer, "round": rnd,
            "trial": self.trial_no + 1 if counted else "", "round_pos": pos + 1,
            "target_note": target, "expected_note": expected, "pattern_broken": broken,
            "band": band, "n_bands": self.N, "silent": int(silent), "moving": int(moving),
            "antic_stage": stage, "path_type": path_name, "fruit_x": r3(landing[0]),
            "fruit_y": r3(landing[1]), "cell_col": c, "cell_row": r, "zone": ZONE_NAMES[z],
            "spawn_method": method, "feat_x": r3(feats["x"]), "feat_y": r3(feats["y"]),
            "feat_dist": r3(feats["dist"]), "feat_pher": r3(feats["pher"]),
            "feat_recent": r3(feats["recent"]), "pred_catch_prob": r3(p),
            "model_on": int(model_on), "radius_px": round(radius), "time_limit_s": r3(limit),
            "cue_time": r3(cue_t - self.session_t0), "fruit_time": r3(fruit_t - self.session_t0),
            "onset_time": r3(onset - self.session_t0) if onset else "",
            "intent_time": r3(intent_t - fruit_t) if intent_t else "",
            "catch_time": r3(catch_t - self.session_t0) if catch_t else "",
            "caught": caught, "caught_with_lean": int(with_lean),
            "aiming_time": r3(catch_t - fruit_t) if catch_t else "",
            "reaction_time": r3(rt),
            "anticipated": "" if onset is None else int(onset < fruit_t),
            "first_direction_correct": "" if dir_ok is None else dir_ok,
            "max_speed": r3(max(speeds)) if speeds else "",
            "avg_speed": r3(np.mean(active)) if active else "",
            "v_variation": r3(np.std(speeds)) if len(speeds) > 2 else "",
            "max_vertical_ext": r3(max_ext) if speeds else "", "in_out_count": in_out,
            "velocity_peaks": peaks, "corrections": max(0, peaks - 1),
            "path_efficiency": r3(straight), "endpoint_error_px": r3(endpoint_err),
            "note_error": "" if note_err is None else note_err,
            "pred_error_px": r3(np.mean(errs)) if errs else "",
            "interception_error_px": r3(0.0 if (moving and caught) else min_dist) if moving else "",
            "strategy": strategy, "lean_max": r3(lean_max), "hike_max": r3(hike_max),
            "elbow_min": r3(min(elbows)) if elbows else "", "elbow_max": r3(max(elbows)) if elbows else "",
            "shoulder_max": r3(max(shoulders)) if shoulders else "",
            "depth_mean": r3(np.mean(depths)) if depths else "",
            "depth_max": r3(max(depths)) if depths else "", "counted": int(counted),
        }
        append_csv(TRIALS_CSV, TRIAL_FIELDS, row)
        self.rows.append(row)

        # rep = a real reach toward this fruit (closed >= REP_MIN_DIST px of the gap);
        # moving the arm back afterwards is not counted
        if counted and d_start is not None and d_start - min_dist >= REP_MIN_DIST:
            self.reps += 1
            form = self.good_form(lean_max if self.snap else None, hike_max if self.snap else None)
            self.rep_forms.append(int(form))
            append_csv(REPS_CSV, REP_FIELDS, {
                "session_id": self.session_id, "participant": self.pid, "rep": self.reps,
                "t_start": r3(fruit_t - self.session_t0),
                "duration_s": r3((catch_t or self.now()) - fruit_t),
                "distance_px": r3(d_start - min_dist), "path_px": r3(path_len),
                "straightness": r3(straight), "peak_speed": r3(max(speeds)) if speeds else "",
                "target_note": target, "lean_max": r3(lean_max), "hike_max": r3(hike_max),
                "good_form": int(form), "elbow_min": r3(min(elbows)) if elbows else "",
                "elbow_max": r3(max(elbows)) if elbows else "",
                "shoulder_max": r3(max(shoulders)) if shoulders else ""})
        if counted:
            self.trial_no += 1
            if not moving and not memory:
                self.model.update(feats, caught)            # Idea 1 learns after every fruit
                self.spawner.record(c, r, caught)
                self.zone_hist.setdefault(z, deque(maxlen=5)).append(caught)
                zc, zn = self.record["zones"].get(zkey(z), [0, 0])
                self.record["zones"][zkey(z)] = [zc + caught, zn + 1]
            if not moving:
                key = f"L{self.layer}:{target}"
                sc, sn = self.record["stats"].get(key, [0, 0])
                self.record["stats"][key] = [sc + caught, sn + 1]
        self.last_b = band
        self.current_fruit = None
        return caught

    # ------------------------------------------------------------ rounds
    def run_jump(self, opt):
        """Sa -> higher note in pairs. 3 good pairs: bigger jump. 2 missed pairs: smaller."""
        k, good, bad = 1, 0, 0
        base = self.notes[0]
        pairs = opt["pairs"]
        for i in range(pairs):
            k = min(max(k, 1), self.N - 1)
            high = self.notes[k]
            pre = self.spawner.choose(k)
            px, py = Pheromone.center(pre[0], pre[1])
            py = min(max(py, H - (k + 1) * self.bh + 0.2 * self.bh), H - k * self.bh - 0.2 * self.bh)
            extra = f"Jump: {label(base)} -> {label(high)}"
            c1 = self.run_trial("jump", base, pos=2 * i, length=2 * pairs, preview=(px, py),
                                hud_extra=extra)
            c2 = self.run_trial("jump", high, pos=2 * i + 1, length=2 * pairs, preset=pre,
                                hud_extra=extra)
            if c1 and c2:
                good, bad = good + 1, 0
                if good >= 3 and k < self.N - 1:
                    k, good = k + 1, 0
                    self.notice(f"Bigger jump: {label(base)} -> {label(self.notes[k])}")
            else:
                bad, good = bad + 1, 0
                if bad >= 2 and k > 1:
                    k, bad = k - 1, 0
                    self.notice(f"Smaller jump: {label(base)} -> {label(self.notes[k])}")

    def unlocked_zones(self):
        out = set()
        for key, (c, n) in self.record["zones"].items():
            if n >= ANTIC_UNLOCK_MIN and (c + 1) / (n + 2) >= ANTIC_UNLOCK_RATE:
                out.add(tuple(int(v) for v in key.split(",")))
        return out

    def run_anticipation(self, opt):
        zones = self.unlocked_zones()
        if not zones:
            self.notice("Moving fruits locked: catch more still fruits first", (200, 200, 200))
            t0 = self.now()
            while self.now() - t0 < 2.0:
                img = self.step()
                self.draw_scene(img)
                show(img)
            return
        for i in range(opt["trials"]):
            self.run_trial("anticipation", pos=i, length=opt["trials"], moving=True, restrict=zones)

    def run_rounds(self):
        total = len(self.cfg["rounds"])
        for i, (rnd, opt) in enumerate(self.cfg["rounds"]):
            self.panel_help = ["Read the card. SPACE = start now."]
            self.card(f"ROUND {i + 1} of {total}: {ROUND_TITLE[rnd]}", [ROUND_HELP[rnd]], secs=5)
            self.panel_help = [f"Round {i + 1} of {total}: {ROUND_TITLE[rnd]}", ROUND_HELP[rnd]]
            if rnd.startswith("song_"):
                self.panel_help.append("The song words are shown at the top.")
            elif rnd != "song_memory":
                self.panel_help.append("Move your wrist circle onto each fruit.")
            if rnd == "jump":
                self.run_jump(opt)
            elif rnd == "anticipation":
                self.run_anticipation(opt)
            elif rnd == "sound_first":
                for i in range(opt["trials"]):
                    self.run_trial(rnd, pos=i, length=opt["trials"])
            else:
                if rnd.startswith("song_"):
                    self.song_preview(opt["song"])
                seq = fixed_sequence(rnd, opt, self.notes)
                ends = self.cfg.get("line_ends", []) if rnd.startswith("song_") else []
                line_start = 0
                for i, (tg, ex, br) in enumerate(seq):
                    self.run_trial(rnd, tg, ex, br, pos=i, length=len(seq))
                    if i + 1 in ends:                     # a line of the song is done: play it back
                        self.song_preview(opt["song"][line_start:i + 1], start=line_start,
                                          title=f"You played line {ends.index(i + 1) + 1}:")
                        line_start = i + 1

    # ------------------------------------------------------------ session
    def run(self):
        completed = False
        jumped = False
        self.session_t0 = self.now()
        try:
            self.intro()
            if self.carry:                       # parts 2-4: reuse part 1's calibration
                for k_, v in self.carry.items():
                    setattr(self, k_, v)
            else:
                self.calibrate()
                self.snapshot()
                self.free_play()
            if self.layer > 1 and "song_name" not in self.cfg:   # songs: no scale warm-up
                self.panel_help = ["Warm-up scale: catch each fruit, low to high.", "Not scored."]
                for i, n in enumerate(self.notes):
                    self.run_trial("warmup", n, pos=i, length=self.N, counted=False)
            self.run_rounds()
            completed = True
        except QuitSession:
            pass
        except JumpPart:
            jumped = True
        self.audio.set_motion("Sa", 0.5, 0.0)
        if completed:
            CURRENT["done"].add(self.part)
        last = not completed or self.part == len(SEQUENCE) - 1
        self.panel_help = []
        pain_after = ask_pain("Pain now (after the session)?") if last and not jumped else ""
        summary = self.finish(completed, pain_after)
        self.audio.close()
        carry = None
        if self.calib is not None:
            carry = {"calib": self.calib, "reach": self.reach, "depth_cal": self.depth_cal,
                     "snap": self.snap, "rest": self.rest}
        if jumped:                        # switched part: saved as "stopped early", no results screen
            return "jump", carry
        return self.end_screen(summary), carry

    def reachability(self):
        out = []
        for zr in range(3):
            for zc in range(3):
                x, y = (zc + 0.5) * W / 3, (zr + 0.5) * H / 3
                c, r = Pheromone.cell_of(x, y)
                f = self.spawner.features(c, r)
                p = self.model.predict(f) if self.model.events >= MODEL_MIN_EVENTS \
                    else f["recent"]
                out.append((ZONE_NAMES[(zr, zc)], p))
        return out

    def decide(self, completed, rate, top_c, top_n):
        """All-parts file: report the result; the order of parts is fixed."""
        if not completed:
            return "part stopped early", self.layer
        if top_n:
            return f"{self.top_name()} caught {top_c}/{top_n}  ({rate:.0%} of all fruits)", self.layer
        return f"caught {rate:.0%} of all fruits", self.layer

    def _decide_layers_unused(self, completed, rate, top_c, top_n):
        rec = self.record
        if not self.auto:
            return "manual session: saved layer unchanged", rec["layer"]
        if not completed:
            return "session stopped early: layer unchanged", rec["layer"]
        top = self.cfg["pass_note"]
        if top and top_n >= PASS_MIN and top_c / top_n >= PASS_RATE:
            rec["bad_streak"] = 0
            return f"passed: {self.top_name()} caught {top_c}/{top_n}", min(self.layer + 1, MAX_LAYER)
        if rate < FAIL_RATE:
            rec["bad_streak"] += 1
            if rec["bad_streak"] >= FAIL_STREAK and self.layer > 1:
                rec["bad_streak"] = 0
                return "two hard sessions in a row: back one layer", self.layer - 1
            return f"hard session ({rate:.0%}): stay", self.layer
        rec["bad_streak"] = 0
        if top is None:
            return "final layer: stay", self.layer
        return f"not yet: {self.top_name()} caught {top_c}/{top_n}", self.layer

    def finish(self, completed, pain_after):
        rows = [r for r in self.rows if r["counted"] == 1]
        static = [r for r in rows if r["moving"] == 0]
        moving = [r for r in rows if r["moving"] == 1]
        done = len(rows)
        catches = sum(r["caught"] for r in rows)
        rate = catches / done if done else 0.0
        top = self.cfg["pass_note"]
        top_rows = [r for r in static if r["target_note"] == top]
        top_c, top_n = sum(r["caught"] for r in top_rows), len(top_rows)
        per_note = []
        for n in self.notes:
            nr = [r for r in static if r["target_note"] == n]
            if nr:
                per_note.append(f"{label(n)}:{sum(r['caught'] for r in nr)}/{len(nr)}")
        silent = [r for r in rows if r["silent"] == 1]

        # prediction accuracy (Idea 1)
        pr = [r for r in static if r["round"] != "song_memory"]
        p = np.array([float(r["pred_catch_prob"]) for r in pr])
        y = np.array([r["caught"] for r in pr], float)
        brier = round(float(np.mean((p - y) ** 2)), 4) if len(pr) else ""
        base = round(float(np.mean((y.mean() - y) ** 2)), 4) if len(pr) else ""

        # anticipation (Idea 3)
        gaps = []
        for zn in ZONE_NAMES.values():
            s_ = [r["caught"] for r in static if r["zone"] == zn]
            m_ = [r["caught"] for r in moving if r["zone"] == zn]
            if s_ and m_:
                gaps.append(np.mean(s_) - np.mean(m_))
        strat = [r["strategy"] for r in moving if r["strategy"]]

        # patient prediction from sound / pattern
        cue_rows = [r for r in rows if r["round"] in ("sound_first", "song_cue_first")]
        surprise = [r for r in rows if r["round"] == "surprise"]
        broken = [r for r in surprise if r["pattern_broken"] == 1]
        normal = [r for r in surprise if r["pattern_broken"] == 0]

        # learning rate
        idx = list(range(len(static)))
        lr_catch = slope(idx, [r["caught"] for r in static]) if len(static) >= 8 else None
        aims = [(i, float(r["aiming_time"])) for i, r in enumerate(static) if r["aiming_time"] != ""]
        lr_aim = slope([a for a, _ in aims], [b for _, b in aims]) if len(aims) >= 8 else None
        hist = [h["catch_rate"] for h in self.record["history"]
                if h.get("layer") == self.layer and h.get("catch_rate") is not None] + ([rate] if done else [])
        lr_sess = slope(list(range(len(hist))), hist) if len(hist) >= 2 else None

        coverage, frontier_n, pher_mean = self.pher.stats()
        reach_map = self.reachability()
        decision, nxt = self.decide(completed, rate, top_c, top_n)

        aim_vals = [float(r["aiming_time"]) for r in static if r["aiming_time"] != ""]
        if self.auto:
            rec = self.record
            rec["layer"] = nxt
            rec["sessions"] = rec.get("sessions", 0) + 1
            rec["reps_by_date"][self.today] = self.reps_today_start + self.reps
            if aim_vals:
                rec["aim_median"] = float(np.median(aim_vals))
            if completed and len(moving) >= 5:
                mr = np.mean([r["caught"] for r in moving])
                if mr >= ANTIC_UNLOCK_RATE and rec["antic_stage"] < 5:
                    rec["antic_stage"] += 1
                elif mr < 0.3 and rec["antic_stage"] > 1:
                    rec["antic_stage"] -= 1
            rec["history"].append({"session_id": self.session_id, "layer": self.layer,
                                   "catch_rate": round(rate, 3) if done else None,
                                   "mean_pred": mean_of([r["pred_catch_prob"] for r in pr]),
                                   "decision": decision, "next_layer": nxt})
            save_record(rec)

        def col(key, rs=rows):
            return mean_of([r[key] for r in rs])

        summary = {
            "session_id": self.session_id, "date": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "participant": self.pid, "group": self.group, "mode": self.mode,
            "layer": self.layer, "layer_name": self.cfg["name"], "completed": int(completed),
            "trials_done": done, "catches": catches, "catch_rate": round(rate, 3) if done else "",
            "silent_catch_rate": col("caught", silent) if silent else "",
            "top_note": label(top) if top else "", "top_note_catches": top_c,
            "top_note_attempts": top_n, "per_note": "; ".join(per_note),
            "reps": self.reps, "reps_today": self.reps_today_start + self.reps,
            "daily_goal": DAILY_GOAL,
            "good_form_pct": round(100 * np.mean(self.rep_forms), 1) if self.rep_forms else "",
            "lean_mean_pct": col("lean_max"), "lean_max_pct": max(
                [float(r["lean_max"]) for r in rows if r["lean_max"] != ""], default=""),
            "hike_max_pct": max([float(r["hike_max"]) for r in rows if r["hike_max"] != ""], default=""),
            "elbow_min_deg": min([float(r["elbow_min"]) for r in rows if r["elbow_min"] != ""], default=""),
            "elbow_max_deg": max([float(r["elbow_max"]) for r in rows if r["elbow_max"] != ""], default=""),
            "shoulder_max_deg": max([float(r["shoulder_max"]) for r in rows if r["shoulder_max"] != ""], default=""),
            "aiming_time_s": col("aiming_time", static), "max_speed_px_s": col("max_speed"),
            "avg_speed_px_s": col("avg_speed"), "v_variation": col("v_variation"),
            "max_vertical_ext": col("max_vertical_ext"), "in_out_count": col("in_out_count"),
            "velocity_peaks": col("velocity_peaks"), "path_efficiency": col("path_efficiency"),
            "endpoint_error_px": col("endpoint_error_px", static), "note_error": col("note_error", static),
            "pred_error_px": col("pred_error_px"), "corrections_per_reach": col("corrections"),
            "intent_time_s": col("intent_time"),
            "model_on_pct": round(100 * np.mean([r["model_on"] for r in pr]), 1) if pr else "",
            "mean_pred_catch": mean_of([r["pred_catch_prob"] for r in pr]),
            "brier_model": brier, "brier_baseline": base,
            "reachability": "; ".join(f"{n}:{v:.0%}" for n, v in reach_map),
            "anticipation_stage": self.record["antic_stage"], "moving_trials": len(moving),
            "moving_catch_rate": col("caught", moving) if moving else "",
            "interception_error_px": col("interception_error_px", moving) if moving else "",
            "anticipating_pct": round(100 * strat.count("anticipating") / len(strat), 1) if strat else "",
            "moving_onset_s": col("reaction_time", moving) if moving else "",
            "static_moving_gap": round(float(np.mean(gaps)), 3) if gaps else "",
            "sound_first_anticipation_rate": col("anticipated", cue_rows),
            "rt_normal_s": col("reaction_time", normal), "rt_surprise_s": col("reaction_time", broken),
            "first_dir_correct_on_surprise": col("first_direction_correct", broken),
            "learning_rate_catch_per10": r3(lr_catch * 10) if lr_catch is not None else "",
            "learning_rate_aim_per10": r3(lr_aim * 10) if lr_aim is not None else "",
            "learning_rate_sessions": r3(lr_sess),
            "pheromone_coverage": round(coverage, 3), "frontier_cells": frontier_n,
            "mean_pheromone": round(pher_mean, 4), "reach_x": r3(self.reach[0]),
            "reach_y": r3(self.reach[1]),
            "depth_range": r3(np.percentile(self.depth_seen, 95) - np.percentile(self.depth_seen, 5))
            if len(self.depth_seen) > 10 else "",
            "tracking_loss_pct": round(100 * self.lost / self.frames, 1) if self.frames else "",
            "pain_before": self.pain_before, "pain_after": pain_after,
            "decision": decision, "next_layer": nxt,
        }
        append_csv(SESSIONS_CSV, SESSION_FIELDS, summary)

        own = participant_dir(self.pid)
        for fdir in (FRAMES_DIR, os.path.join(own, "frames")):          # combined + participant copy
            os.makedirs(fdir, exist_ok=True)
            with open(os.path.join(fdir, f"{self.session_id}.csv"), "w", newline="") as f:
                w = csv.writer(f)
                w.writerow(FRAME_FIELDS)
                w.writerows(self.frame_rows)
        for pdir in (PHER_DIR, os.path.join(own, "pheromone")):
            os.makedirs(pdir, exist_ok=True)
            np.savetxt(os.path.join(pdir, f"{self.session_id}.csv"), self.pher.g, delimiter=",", fmt="%.4f")
        summary["_reach_map"] = reach_map
        if self.words:                                   # results by song line, for the end screen
            per_line = {}
            for r in rows:
                if str(r["round"]).startswith("song_"):
                    a, b = self.line_of(int(r["round_pos"]) - 1)
                    c_, n_ = per_line.get(a, (0, 0))
                    per_line[a] = (c_ + r["caught"], n_ + 1)
            ends = self.cfg.get("line_ends", [])
            texts = self.cfg.get("line_text")
            summary["_per_line"] = [((texts[ends.index(self.line_of(a)[1])] if texts else
                                      " ".join(self.words[a:self.line_of(a)[1]])), c_, n_)
                                    for a, (c_, n_) in sorted(per_line.items())]
        return summary

    def end_screen(self, s):
        img = np.zeros((H, W, 3), np.uint8)
        img[:] = C_BG
        cv2.rectangle(img, (0, 0), (W, 12), C_PINK, -1)
        put_center(img, f"Part {self.part + 1} complete" if s["completed"] else "Stopped", 60, 1.2, C_YELLOW, 3)
        put_center(img, PART_NAME[self.layer], 100, 0.75, C_TEXT, 2)
        if s["trials_done"]:
            put_center(img, f"Caught {s['catches']} of {s['trials_done']} ({float(s['catch_rate']):.0%})"
                            f"    Reps today {s['reps_today']}/{DAILY_GOAL}", 145, 0.75, C_GREEN, 2)
        y = 220
        if s.get("_per_line"):
            put(img, "Song lines (caught / tries)", (40, 190), 0.6, (200, 200, 200), 2)
            for i, (txt, c_, n_) in enumerate(s["_per_line"]):
                put(img, f"{i + 1}. {txt}", (40, y), 0.5)
                put(img, f"{c_}/{n_}", (390, y), 0.5, (200, 255, 200))
                y += 26
        else:
            put(img, "Notes", (60, 190), 0.6, (200, 200, 200), 2)
            for part in s["per_note"].split("; ") if s["per_note"] else []:
                put(img, part.replace(":", "  "), (60, y), 0.55)
                y += 26
        put(img, "Reachability: chance to catch a fruit", (W // 2 + 10, 182), 0.55, (200, 200, 200), 2)
        put(img, "in each part of the screen", (W // 2 + 10, 202), 0.5, (170, 170, 170))
        for zc, nm in enumerate(("Left", "Centre", "Right")):
            put(img, nm, (W // 2 + 70 + zc * 120, 425), 0.45, (170, 170, 170))
        for zr, nm in enumerate(("Top", "Mid", "Low")):
            put(img, nm, (W // 2 - 8, 245 + zr * 70), 0.45, (170, 170, 170))
        for i, (n, v) in enumerate(s["_reach_map"]):
            zr, zc = divmod(i, 3)
            x0, y0 = W // 2 + 40 + zc * 120, 212 + zr * 70
            col = (80, 200, 80) if v >= 0.7 else ((0, 200, 255) if v >= 0.4 else (80, 80, 230))
            cv2.rectangle(img, (x0, y0), (x0 + 110, y0 + 60), col, 2)
            put(img, f"{v:.0%}", (x0 + 30, y0 + 38), 0.7, col, 2)
        put_center(img, s["decision"], H - 135, 0.7, (255, 220, 120))
        last = self.part == len(SEQUENCE) - 1
        can_go = s["completed"] and not last
        if can_go:
            nxt = PART_NAME[SEQUENCE[self.part + 1]]
            put_center(img, f"Next: Part {self.part + 2} - {nxt}", H - 95, 0.8, C_GREEN, 2)
            put_center(img, "SPACE = start next part      Q = stop here (all saved)", H - 40, 0.7, C_TEXT, 2)
        elif s["completed"]:
            put_center(img, "All four parts done - well played!", H - 95, 0.9, C_GREEN, 2)
            put_center(img, "Press any key to close", H - 40, 0.65, C_DIM, 1)
        else:
            put_center(img, "Everything played so far is saved.", H - 95, 0.75, C_TEXT, 2)
            put_center(img, "Press any key to close", H - 40, 0.65, C_DIM, 1)
        CURRENT["game"] = None
        CURRENT["help"] = (["SPACE = next part", "Q = stop here"] if can_go else ["Any key = close"]) +             ["Or click any part above (or press 1-4) to play it."]
        while True:
            show(img)
            k = getkey(100)
            if k != -1 and ord("1") <= (k & 0xFF) <= ord("4"):
                CURRENT["jump"] = (k & 0xFF) - ord("1")
            if CURRENT["jump"] is not None:
                return "jump"
            if k == -1:
                continue
            k &= 0xFF
            if not can_go:
                return False
            if k in (32, 13, ord("n"), ord("N")):
                return True
            if k in (ord("q"), ord("Q"), 27):
                return False


# ================================================================ window
def make_window():
    """Resizable window: play area + side panel (drag the corner or maximise)."""
    cv2.namedWindow(WIN, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(WIN, int(600 * (W + PANEL_W) / H), 600)
    cv2.setMouseCallback(WIN, on_mouse)


def ptext(p, text, x, y, scale=0.5, color=C_TEXT, thick=1):
    cv2.putText(p, text, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, color, thick, cv2.LINE_AA)


def wrap_text(text, width, scale=0.5, thick=1):
    lines, cur = [], ""
    for w_ in str(text).split():
        t = (cur + " " + w_).strip()
        if cur and cv2.getTextSize(t, cv2.FONT_HERSHEY_SIMPLEX, scale, thick)[0][0] > width:
            lines.append(cur)
            cur = w_
        else:
            cur = t
    if cur:
        lines.append(cur)
    return lines


def panel_base():
    """Header + the four parts as CLICKABLE buttons (done / now / still to come)."""
    p = np.full((H, PANEL_W, 3), C_BG, np.uint8)
    cv2.rectangle(p, (0, 0), (PANEL_W, 50), C_PINK, -1)
    ptext(p, "FruitCatcher", 16, 34, 0.85, C_TEXT, 2)
    cv2.line(p, (0, 0), (0, H), C_PINK, 3)
    PART_ROWS.clear()
    y = 60
    for i, L in enumerate(SEQUENCE):
        done = i in CURRENT["done"]
        now = i == CURRENT["part"] and not done
        col = C_GREEN if done else (C_YELLOW if now else C_DIM)
        y0, y1 = y, y + 28
        PART_ROWS.append((y0, y1))
        cv2.rectangle(p, (10, y0), (PANEL_W - 10, y1), C_CARD, -1)          # button
        cv2.rectangle(p, (10, y0), (PANEL_W - 10, y1), col if now else C_CARD, 1)
        c = (26, y0 + 14)
        cv2.circle(p, c, 7, col, -1 if (done or now) else 1, cv2.LINE_AA)
        ptext(p, f"{i + 1}. {PART_BTN[L]}" + ("  - done" if done else ""), 42, y0 + 19, 0.48,
              C_TEXT if (done or now) else C_DIM, 2 if now else 1)
        y += 32
    ptext(p, "Click a part (or press 1-4) to switch", 14, y + 10, 0.42, C_CYAN, 1)
    return p, y + 48


def on_mouse(event, x, y, flags, param):
    """Click on a part button in the side panel = jump to that part."""
    if event == cv2.EVENT_LBUTTONDOWN and x >= W:
        for i, (y0, y1) in enumerate(PART_ROWS):
            if y0 <= y <= y1:
                CURRENT["jump"] = i


def panel_keys(p):
    cv2.line(p, (10, H - 40), (PANEL_W - 10, H - 40), C_CARD, 2)
    ptext(p, "P pause   H map   SPACE skip   Q quit", 18, H - 16, 0.45, C_DIM, 1)


_PANEL_CACHE = {"t": 0.0, "key": None, "img": None}


def draw_panel():
    """Side panel. Redrawn about 8 times a second (not every frame): it is mostly text."""
    g = CURRENT["game"]
    key = (id(g), CURRENT["part"], len(CURRENT["done"]), tuple(CURRENT["help"]),
           g.show_map if g is not None else None)
    now = time.time()
    c = _PANEL_CACHE
    if c["img"] is not None and c["key"] == key and now - c["t"] < 0.12:
        return c["img"]
    if g is not None:
        p = g.panel()
    else:
        p, y = panel_base()
        if CURRENT["help"]:
            lines = []
            for h_ in CURRENT["help"]:
                lines += wrap_text(h_, PANEL_W - 44, 0.5)
            cv2.rectangle(p, (10, y - 20), (PANEL_W - 10, y + 18 + 21 * len(lines)), C_CARD, -1)
            cv2.rectangle(p, (10, y - 20), (14, y + 18 + 21 * len(lines)), C_GREEN, -1)
            ptext(p, "WHAT TO DO", 24, y, 0.5, C_GREEN, 2)
            for i, ln in enumerate(lines):
                ptext(p, ln, 24, y + 24 + 21 * i, 0.5, C_TEXT, 1)
        panel_keys(p)
    c["t"], c["key"], c["img"] = now, key, p
    return p


FULL = np.zeros((H, W + PANEL_W, 3), np.uint8)     # one reusable picture: play area + panel
_PENDING_KEY = [None]


def getkey(delay=1):
    """Like cv2.waitKey, but first returns a key that show() already picked up."""
    k = _PENDING_KEY[0]
    if k is not None:
        _PENDING_KEY[0] = None
        return k
    return cv2.waitKey(delay)


def show(img):
    """Show the play area with the side panel on the right. The picture is put on screen
    straight away (waitKey(1) here), not one camera-wait later, and any key pressed is kept
    for getkey()."""
    if img.shape[0] == H and img.shape[1] == W:
        FULL[:, :W] = img
        FULL[:, W:] = draw_panel()
        cv2.imshow(WIN, FULL)
    else:
        cv2.imshow(WIN, img)
    k = cv2.waitKey(1)
    if k != -1:
        _PENDING_KEY[0] = k


def camera_check(tracker):
    """Before Part 1: live view of the webcam. Is the hand seen? Does the hand-size bar
    move when the hand goes forward and back?"""
    CURRENT["help"] = ["Webcam in front of the patient, at chest / shoulder height, fixed in place.",
                       "Hold the hand up so the camera sees it, then move it forward and back.",
                       "SPACE = start    Q = quit",
                       "Or click a part above (or press 1-4) to start there."]
    lo = hi = None
    while True:
        frame, obs = tracker.read()
        img = np.full((H, W, 3), C_BG, np.uint8)
        cv2.rectangle(img, (0, 0), (W, 12), C_PINK, -1)
        put_center(img, "CAMERA CHECK", 52, 1.0, C_YELLOW, 2)
        vw, vh = 560, 420
        x0, y0 = (W - vw) // 2, 80
        if frame is not None:
            img[y0:y0 + vh, x0:x0 + vw] = cv2.resize(frame, (vw, vh))
        w_ = obs["wrist"] if obs else None
        col = C_GREEN if w_ else C_PINK
        cv2.rectangle(img, (x0 - 3, y0 - 3), (x0 + vw + 2, y0 + vh + 2), col, 3)
        if w_:
            cv2.circle(img, (x0 + int(w_[0] * vw), y0 + int(w_[1] * vh)), 11, C_CYAN, -1, cv2.LINE_AA)
        put(img, f"Camera number {tracker.cam_id}: " + ("hand seen" if w_ else "no hand"),
            (x0, y0 + vh + 30), 0.6, col, 2)
        y = 80 + vh + 75
        if w_ and obs.get("palm"):
            d = obs["palm"]
            lo = d if lo is None else min(lo, d)
            hi = d if hi is None else max(hi, d)
            frac = (d - lo) / (hi - lo) if hi - lo > 1 else 0.5
            put_center(img, "Hand size - move the hand forward and back", y, 0.6, C_TEXT, 1)
            cv2.rectangle(img, (230, y + 18), (730, y + 36), C_DIM, 1)
            cv2.rectangle(img, (230, y + 18), (230 + int(500 * frac), y + 36), C_CYAN, -1)
            put(img, "far", (190, y + 33), 0.5, C_DIM)
            put(img, "near", (740, y + 33), 0.5, C_DIM)
        else:
            put_center(img, "Show the hand to the camera", y, 0.7, C_ORANGE, 2)
        put_center(img, "SPACE = start     Q = quit", H - 28, 0.7, C_TEXT, 2)
        show(img)
        k = getkey(1) & 0xFF
        if ord("1") <= k <= ord("4"):
            CURRENT["jump"] = k - ord("1")
        if k == 32 or CURRENT["jump"] is not None:
            break
        if k in (ord("q"), ord("Q"), 27):
            tracker.close()
            cv2.destroyAllWindows()
            sys.exit(0)
    CURRENT["help"] = []


# ================================================================ start + pain screens
def screen(lines):
    img = np.full((H, W, 3), C_BG, np.uint8)
    cv2.rectangle(img, (0, 0), (W, 12), C_PINK, -1)
    put_center(img, "FruitCatcher - All Layers", 80, 1.3, C_YELLOW, 3)
    y = 170
    for text, col in lines:
        put_center(img, text, y, 0.75, col)
        y += 40
    show(img)
    return getkey(30) & 0xFF


def ask_pain(question):
    """0-9 keys, X = 10, S = skip."""
    while True:
        CURRENT["help"] = ["Press 0 (no pain) to 9, X = 10.", "S = skip."]
        k = screen([(question, C_TEXT), ("Press 0 (no pain) to 9, X = 10", C_CYAN),
                    ("S = skip", C_DIM)])
        if k == 255:
            continue
        ch = chr(k).upper()
        if ch.isdigit():
            return int(ch)
        if ch == "X":
            return 10
        if ch == "S" or k == 27:
            return ""


def start_screen(pid, group, mode):
    while not pid:
        buf = ""
        while True:
            k = screen([("Type participant ID, then press ENTER", (200, 200, 200)),
                        (buf + "_", (120, 255, 120))])
            if k in (13, 10) and buf:
                pid = buf
                break
            if k == 8:
                buf = buf[:-1]
            elif k == 27:
                sys.exit(0)
            elif 32 < k < 127 and (chr(k).isalnum() or chr(k) in "-_") and len(buf) < 12:
                buf += chr(k).upper()
    while group not in ("Y", "O", "S"):
        k = screen([(f"Participant: {pid}", (120, 255, 120)), ("Group:", (200, 200, 200)),
                    ("Y  Young (healthy)", (255, 255, 255)), ("O  Older (healthy)", (255, 255, 255)),
                    ("S  Stroke", (255, 255, 255))])
        if k == 27:
            sys.exit(0)
        if k != 255 and chr(k).upper() in "YOS":
            group = chr(k).upper()
    return pid, group, mode


# ================================================================ clinician view (reads the saved data; no webcam)
CV_W, CV_H = 1400, 780
CV_WIN = "FruitCatcher - Clinician view"
LAYER_NOTES = {1: 3, 2: 5, 3: 6, 5: 8}


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def _fmt(v, nd=2, suffix=""):
    f = _num(v)
    if f is None:
        s = "" if v is None else str(v).strip()
        return (s + suffix) if s else "-"
    if abs(f - round(f)) < 1e-9:
        return f"{int(round(f))}{suffix}"
    return f"{f:.{nd}f}{suffix}"


def _pct(v):
    f = _num(v)
    return "-" if f is None else f"{100 * f:.0f}%"


def participants_with_data():
    """IDs that have saved sessions (one folder each, else the combined file)."""
    found = set()
    root = os.path.join(DATA_DIR, "participants")
    if os.path.isdir(root):
        for name in os.listdir(root):
            if os.path.exists(os.path.join(root, name, "sessions.csv")):
                found.add(name)
    if not found and os.path.exists(SESSIONS_CSV):
        with open(SESSIONS_CSV, newline="", encoding="utf-8") as f:
            found = {r.get("participant") for r in csv.DictReader(f) if r.get("participant")}
    return sorted(found)


def load_sessions(pid):
    """Saved parts of one participant, oldest first."""
    for path in (os.path.join(participant_dir(pid), "sessions.csv"), SESSIONS_CSV):
        if os.path.exists(path):
            with open(path, newline="", encoding="utf-8") as f:
                rows = [r for r in csv.DictReader(f) if r.get("participant") == pid]
            if rows:
                return sorted(rows, key=lambda r: r.get("session_id") or "")
    return []


def load_pheromone(pid, session_id):
    for d in (os.path.join(participant_dir(pid), "pheromone"), PHER_DIR):
        path = os.path.join(d, f"{session_id}.csv")
        if os.path.exists(path):
            try:
                a = np.loadtxt(path, delimiter=",", dtype=np.float32)
                if a.shape == (GRID, GRID):
                    return a
            except Exception:
                pass
    return None


def clinician_groups(r):
    """Every saved metric of one part, in plain words, grouped for the screen."""
    g = r.get
    f = lambda k, nd=2, s="": _fmt(g(k), nd, s)
    two = lambda a, b, s="": f"{_fmt(g(a))} / {_fmt(g(b))}{s}"
    return [
        ("PERFORMANCE", [
            ("Fruits tried", f("trials_done")),
            ("Fruits caught", f"{f('catches')}  ({_pct(g('catch_rate'))})"),
            ("Catch rate, silent tries", _pct(g("silent_catch_rate"))),
            ("Top note", f"{g('top_note') or '-'}: {f('top_note_catches')} of {f('top_note_attempts')}"),
            ("Per note", g("per_note") or "-"),
        ]),
        ("REPS AND POSTURE", [
            ("Reps this part", f("reps")),
            ("Reps today / goal", two("reps_today", "daily_goal")),
            ("Good form", f("good_form_pct", 0, "%")),
            ("Lean mean / max (%)", two("lean_mean_pct", "lean_max_pct")),
            ("Shoulder lift max (%)", f("hike_max_pct")),
            ("Elbow angle min / max", two("elbow_min_deg", "elbow_max_deg", " deg")),
            ("Shoulder angle max", f("shoulder_max_deg", 0, " deg")),
        ]),
        ("MOVEMENT", [
            ("Aiming time", f("aiming_time_s", 2, " s")),
            ("Intent time", f("intent_time_s", 2, " s")),
            ("Max speed", f("max_speed_px_s", 0, " px/s")),
            ("Average speed", f("avg_speed_px_s", 0, " px/s")),
            ("Speed variation", f("v_variation", 0)),
            ("Path efficiency", f("path_efficiency")),
            ("Endpoint error", f("endpoint_error_px", 0, " px")),
            ("Note error", f("note_error")),
            ("Corrections per reach", f("corrections_per_reach")),
            ("Velocity peaks", f("velocity_peaks")),
            ("Max vertical reach", f("max_vertical_ext")),
            ("In / out of target", f("in_out_count")),
        ]),
        ("PREDICTION", [
            ("Catch model on", f("model_on_pct", 0, "% of fruits")),
            ("Mean predicted catch", _pct(g("mean_pred_catch"))),
            ("Brier model / baseline", two("brier_model", "brier_baseline")),
            ("Hand prediction error", f("pred_error_px", 1, " px")),
        ]),
        ("MOVING FRUIT", [
            ("Stage", f("anticipation_stage")),
            ("Moving fruits tried", f("moving_trials")),
            ("Moving catch rate", _pct(g("moving_catch_rate"))),
            ("Interception error", f("interception_error_px", 0, " px")),
            ("Anticipating", f("anticipating_pct", 0, "%")),
            ("Movement start", f("moving_onset_s", 2, " s")),
            ("Still vs moving gap", f("static_moving_gap")),
            ("Sound-first anticipation", _pct(g("sound_first_anticipation_rate"))),
            ("Reaction normal / surprise", two("rt_normal_s", "rt_surprise_s", " s")),
            ("First direction on surprise", _pct(g("first_dir_correct_on_surprise"))),
        ]),
        ("LEARNING AND MAP", [
            ("Catch change per 10 fruits", f("learning_rate_catch_per10")),
            ("Aim time change per 10", f("learning_rate_aim_per10")),
            ("Learning across sessions", f("learning_rate_sessions")),
            ("Map covered", _pct(g("pheromone_coverage"))),
            ("Edge cells", f("frontier_cells")),
            ("Reach x / y", two("reach_x", "reach_y")),
            ("Depth range", f("depth_range")),
            ("Tracking lost", f("tracking_loss_pct", 1, "%")),
        ]),
        ("PAIN AND RESULT", [
            ("Pain before / after", two("pain_before", "pain_after", " (0-10)")),
            ("Result", g("decision") or "-"),
        ]),
    ]


def _text_w(t, scale):
    return cv2.getTextSize(t, cv2.FONT_HERSHEY_SIMPLEX, scale, 1)[0][0]


def _layout_group(items, col_w):
    """Turn (label, value) pairs into draw steps; long values go on their own lines."""
    room = col_w - 225
    ops = []
    for label_, value in items:
        value = str(value)
        if _text_w(value, 0.45) <= room:
            ops.append(("pair", label_, value, 18))
        else:
            lines = wrap_text(value, col_w - 14, 0.45)
            ops.append(("long", label_, lines, 18 + 17 * len(lines)))
    return ops


def _draw_groups(img, groups, x0, y0, col_w, y_max, gap):
    """Two columns; each group goes in the shorter column so both stay on the screen."""
    ys = [y0, y0]
    for title, items in groups:
        ops = _layout_group(items, col_w)
        h = 22 + sum(o[3] for o in ops) + 8
        c = 0 if ys[0] <= ys[1] else 1
        x, y = x0 + c * (col_w + gap), ys[c]
        ptext(img, title, x, y + 14, 0.5, C_YELLOW, 2)
        yy = y + 36
        for kind, label_, value, hh in ops:
            ptext(img, label_, x, yy, 0.42, C_DIM, 1)
            if kind == "pair":
                ptext(img, value, x + 215, yy, 0.45, C_TEXT, 1)
            else:
                for i, ln in enumerate(value):
                    ptext(img, ln, x + 10, yy + 17 * (i + 1), 0.45, C_TEXT, 1)
            yy += hh
        ys[c] += h


def _draw_reach(img, r, x0, y0):
    """3x3 ability-zone grid (chance to catch a fruit in each part of the screen)."""
    vals = {}
    for part in str(r.get("reachability") or "").split(";"):
        if ":" in part:
            k, v = part.split(":", 1)
            f = _num(v.strip().rstrip("%"))
            if f is not None:
                vals[k.strip()] = f / 100.0
    cw, ch = 100, 54
    for zc, nm in enumerate(("Left", "Centre", "Right")):
        ptext(img, nm, x0 + 38 + zc * (cw + 6) + 24, y0 - 6, 0.42, C_DIM, 1)
    for zr, nm in enumerate(("Top", "Mid", "Low")):
        ptext(img, nm, x0, y0 + zr * (ch + 6) + 34, 0.42, C_DIM, 1)
    for zr in range(3):
        for zc in range(3):
            v = vals.get(ZONE_NAMES[(zr, zc)])
            xx, yy = x0 + 38 + zc * (cw + 6), y0 + zr * (ch + 6)
            if v is None:
                col, txt = C_DIM, "-"
            else:
                col = (80, 200, 80) if v >= 0.7 else ((0, 200, 255) if v >= 0.4 else (80, 80, 230))
                txt = f"{v:.0%}"
            cv2.rectangle(img, (xx, yy), (xx + cw, yy + ch), C_CARD, -1)
            cv2.rectangle(img, (xx, yy), (xx + cw, yy + ch), col, 2)
            ptext(img, txt, xx + 28, yy + 35, 0.75, col, 2)


def _draw_heat(img, pher, x0, y0, w, h):
    """The saved pheromone map of that part: warm = caught here often; white boxes = edge."""
    if pher is None:
        cv2.rectangle(img, (x0, y0), (x0 + w, y0 + h), C_CARD, -1)
        ptext(img, "Map file not found", x0 + 70, y0 + h // 2, 0.5, C_DIM, 1)
        return
    g = pher / (float(pher.max()) + 1e-6)
    heat = cv2.applyColorMap((g * 255).astype(np.uint8), cv2.COLORMAP_JET)
    img[y0:y0 + h, x0:x0 + w] = cv2.resize(heat, (w, h), interpolation=cv2.INTER_NEAREST)
    ph = Pheromone()
    ph.g = pher.astype(np.float32)
    _, mask = ph.frontier()
    cw, chh = w / GRID, h / GRID
    for r_, c_ in zip(*np.nonzero(mask)):
        cv2.rectangle(img, (int(x0 + c_ * cw), int(y0 + r_ * chh)),
                      (int(x0 + (c_ + 1) * cw), int(y0 + (r_ + 1) * chh)), (255, 255, 255), 1)


def _draw_trend(img, rates, sel, x0, y0, w, h):
    """Catch rate of every saved part (newest on the right); the shown one is yellow."""
    cv2.rectangle(img, (x0, y0), (x0 + w, y0 + h), C_CARD, -1)
    top, bottom = y0 + 10, y0 + h - 10
    for frac in (0.5, 1.0):
        yy = int(bottom - frac * (bottom - top))
        cv2.line(img, (x0 + 4, yy), (x0 + w - 4, yy), C_BG, 1)
    start = max(0, len(rates) - 24)
    shown = rates[start:]
    if not shown:
        return
    bw = min(26, int((w - 16) / len(shown)))
    for i, v in enumerate(shown):
        bx = x0 + 8 + i * bw
        bh = int((v or 0) * (bottom - top))
        col = C_YELLOW if start + i == sel else C_CYAN
        cv2.rectangle(img, (bx + 1, bottom - bh), (bx + bw - 2, bottom), col, -1)


def render_clinician(pid, sessions, sel, top_row):
    """One picture of the clinician screen. Returns (image, clickable rows)."""
    r = sessions[sel]
    img = np.full((CV_H, CV_W, 3), C_BG, np.uint8)
    cv2.rectangle(img, (0, 0), (CV_W, 50), C_PINK, -1)
    ptext(img, f"FruitCatcher - Clinician view      Participant {pid}      Group {r.get('group') or '-'}",
          16, 34, 0.8, C_TEXT, 2)

    # left: every saved part
    ptext(img, "SAVED PARTS", 14, 78, 0.5, C_YELLOW, 2)
    rows = []
    y = 94
    vis = (CV_H - 60 - y) // 26
    for i in range(top_row, min(len(sessions), top_row + vis)):
        s = sessions[i]
        n = LAYER_NOTES.get(int(_num(s.get("layer")) or 0), "?")
        mark = "" if str(s.get("completed")) in ("1", "1.0") else " *"
        txt = f"{str(s.get('date') or '')[:16]}  {n} notes  {_pct(s.get('catch_rate'))}{mark}"
        if i == sel:
            cv2.rectangle(img, (8, y - 4), (292, y + 20), C_CARD, -1)
            cv2.rectangle(img, (8, y - 4), (292, y + 20), C_YELLOW, 1)
        ptext(img, txt, 14, y + 14, 0.45, C_TEXT if i == sel else C_DIM, 1)
        rows.append((y - 4, y + 20, i))
        y += 26
    ptext(img, "* stopped early", 14, CV_H - 48, 0.42, C_DIM, 1)

    # middle: the chosen part, all metrics
    done = str(r.get("completed")) in ("1", "1.0")
    ptext(img, f"{r.get('date') or ''}    {r.get('layer_name') or ''}", 310, 78, 0.6, C_TEXT, 2)
    ptext(img, "completed" if done else "stopped early", 310, 100, 0.5, C_GREEN if done else C_ORANGE, 2)
    _draw_groups(img, clinician_groups(r), 310, 112, 345, CV_H - 48, 20)

    # right: ability zone, heat map, trend
    rx = 1060
    ptext(img, "ABILITY ZONE: chance to catch a fruit", rx, 78, 0.5, C_YELLOW, 2)
    _draw_reach(img, r, rx, 108)
    ptext(img, "HEAT MAP: where the patient succeeds", rx, 322, 0.5, C_YELLOW, 2)
    _draw_heat(img, load_pheromone(pid, r.get("session_id")), rx, 334, 320, 240)
    ptext(img, "Warm = caught often.  White boxes = edge.", rx, 592, 0.42, C_DIM, 1)
    ptext(img, "CATCH RATE OF EACH SAVED PART", rx, 626, 0.5, C_YELLOW, 2)
    _draw_trend(img, [_num(s.get("catch_rate")) for s in sessions], sel, rx, 638, 320, 90)

    cv2.line(img, (10, CV_H - 30), (CV_W - 10, CV_H - 30), C_CARD, 2)
    ptext(img, "N / P (or arrow keys, or click a saved part) = next / previous      Q or Esc = close",
          14, CV_H - 10, 0.5, C_DIM, 1)
    return img, rows


def clinician_view(pid=None):
    """Open the clinician screen: all saved metrics of one participant. No webcam needed."""
    names = participants_with_data()
    if not pid:
        if len(names) == 1:
            pid = names[0]
        else:
            print("Saved participants:", ", ".join(names) if names else "none found in " + DATA_DIR)
            if names:
                print("Run again with the ID, e.g.:  python fruitcatcher_1cam.py --clinician --id " + names[0])
            return
    sessions = load_sessions(pid)
    if not sessions:
        print(f"No saved sessions for {pid} in {DATA_DIR}")
        if names:
            print("Saved participants:", ", ".join(names))
        return
    print(f"Clinician view: {pid}, {len(sessions)} saved part(s).  N/P = next/previous, Q = close.")
    state = {"sel": len(sessions) - 1, "top": 0, "rows": []}

    def on_click(event, x, y, flags, param):
        if event == cv2.EVENT_LBUTTONDOWN and x < 300:
            for y0, y1, i in state["rows"]:
                if y0 <= y <= y1:
                    state["sel"] = i

    cv2.namedWindow(CV_WIN, cv2.WINDOW_NORMAL)
    cv2.resizeWindow(CV_WIN, 1260, 702)
    cv2.setMouseCallback(CV_WIN, on_click)
    while True:
        vis = (CV_H - 60 - 94) // 26
        state["top"] = min(max(state["top"], state["sel"] - vis + 1), state["sel"])
        img, state["rows"] = render_clinician(pid, sessions, state["sel"], state["top"])
        cv2.imshow(CV_WIN, img)
        k = cv2.waitKeyEx(50)
        if cv2.getWindowProperty(CV_WIN, cv2.WND_PROP_VISIBLE) < 1:
            break
        if k == -1:
            continue
        low = k & 0xFF
        if low in (ord("q"), ord("Q"), 27):
            break
        if k in (2424832, 2490368, 65361, 65362) or low in (ord("p"), ord("P"), ord("a"), ord("A")):
            state["sel"] = max(0, state["sel"] - 1)
        elif k in (2555904, 2621440, 65363, 65364) or low in (ord("n"), ord("N"), ord("d"), ord("D")):
            state["sel"] = min(len(sessions) - 1, state["sel"] + 1)
    cv2.destroyAllWindows()


# ================================================================ main
def main():
    ap = argparse.ArgumentParser(description="FruitCatcher - all four parts: 3, 5, 6, 8 notes (one webcam)")
    ap.add_argument("--id", help="participant ID, e.g. P07")
    ap.add_argument("--group", choices=["Y", "O", "S"], help="Y young, O older, S stroke")
    ap.add_argument("--cam", type=int, default=1,
                    help="number of the external webcam (default 1; use --find-cameras to see them)")
    ap.add_argument("--start", type=int, choices=[3, 5, 6, 8], default=3,
                    help="start at the 3, 5, 6 or 8 note part (default 3)")
    ap.add_argument("--find-cameras", action="store_true", help="show all cameras with their numbers")
    ap.add_argument("--clinician", action="store_true",
                    help="open the clinician view: all saved metrics on screen (use with --id)")
    args = ap.parse_args()
    if args.find_cameras:
        find_cameras()
        return
    if args.clinician:
        clinician_view(args.id.upper() if args.id else None)
        return
    for d in (DATA_DIR, PATIENT_DIR, SOUND_DIR, FRAMES_DIR, PHER_DIR):
        os.makedirs(d, exist_ok=True)
    tracker = Tracker(args.cam)
    make_window()
    pid = args.id.upper() if args.id else None
    pid, group, _ = start_screen(pid, args.group, "auto")
    camera_check(tracker)
    pain_before = ask_pain("Pain now (before the session)?")
    first = START_BY_NOTES[args.start]
    if CURRENT["jump"] is not None:               # a part was picked on the camera check screen
        first = CURRENT["jump"]
        CURRENT["jump"] = None
    carry = None
    part = first
    try:
        while part < len(SEQUENCE):
            layer = SEQUENCE[part]
            record = load_record(pid, group)
            record["layer"] = layer
            game = Game(pid, group, "auto", layer, record, tracker,
                        pain_before if part == first else "", part=part, carry=carry)
            go_on, carry = game.run()
            if go_on == "jump":                   # clicked another part (or pressed 1-4)
                part = CURRENT["jump"]
                CURRENT["jump"] = None
                continue
            if not go_on:
                break
            part += 1
    finally:
        tracker.close()
        cv2.destroyAllWindows()


if __name__ == "__main__":
    main()
