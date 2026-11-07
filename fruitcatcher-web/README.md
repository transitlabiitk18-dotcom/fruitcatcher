# FruitCatcher Web

The browser version of `../fruitcatcher_1cam.py` (left untouched): a webcam reaching game for upper-limb
rehabilitation, with clinician accounts, patients, dashboards, a performance score and Fugl-Meyer tracking.

- **Game** runs fully in the browser: MediaPipe hand + pose tracking (the same two `.task` files),
  canvas drawing and Web Audio. The camera video never leaves the computer.
- **Backend** is Firebase: Auth (email + password), Firestore (all data), Hosting. No server code.
- **Without Firebase settings** the app runs in *local demo mode*: accounts and data stay in that browser.

## Run it

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # engine + storage tests
npm run build        # production build in dist/
```

`npm run dev` / `npm run build` copy the MediaPipe WebAssembly files and the two `.task` models
(from the folder above) into `public/`, so tracking works offline.

The models are not in the git repository: put `hand_landmarker.task` and `pose_landmarker_lite.task`
in the folder above (next to `fruitcatcher_1cam.py`) before running. Also copy `.env.example` to `.env`
and fill in the Firebase settings (or leave it empty for local demo mode).

Open `/patients/<id>/play?sim=1` to play with a **simulated hand** (no camera), for demos and testing.

Keys while playing: `SPACE` skip waiting · `P` pause · `H` live heat map · `1`-`4` jump to a part ·
`Q` / `Esc` stop and save. Use Chrome or Edge, and wired speakers for the shortest sound delay.

## Connect Firebase

1. Firebase console → your project → **Build → Authentication → Sign-in method** → enable **Email/Password**.
2. **Build → Firestore Database** → create the database (choose `asia-south1 (Mumbai)` for Indian patient
   data; the location cannot be changed later).
3. **Project settings → Your apps → Web app** → copy the config into a new `.env` file
   (copy `.env.example` and fill it in). Also set `VITE_ADMIN_CONTACT` (shown when a trial ends).
4. Deploy the security rules and the site:
   ```bash
   npm install -g firebase-tools
   firebase login
   cp .firebaserc.example .firebaserc     # put your project ID in it
   npm run build
   firebase deploy --only firestore:rules,hosting
   ```
   The app is then live at `https://<project-id>.web.app` (https is required for the camera).

Works on the free Spark plan (no Cloud Functions or Cloud Storage are used).

## Managing trials (no admin dashboard needed)

Every clinician gets `users/{uid}` in Firestore:

| field         | meaning                                                                 |
|---------------|-------------------------------------------------------------------------|
| `name`, `email`, `phone` | from sign-up (`phone` = `{ countryCode, number }`)            |
| `createdAt`   | sign-up time                                                            |
| `accessUntil` | **access ends at this timestamp** (sign-up + 30 days)                   |
| `status`      | `trial`, `active` or `blocked`                                          |
| `settings`    | the clinician's game settings                                           |

- **Extend a trial / give access:** Firestore → `users` → the clinician → edit `accessUntil`
  (and set `status` to `active` if they now pay).
- **Block someone:** set `status` to `blocked`, or `accessUntil` to a past date.
- When access ends the clinician sees *"Your free trial has ended - please contact the admin"*.
  Their data is kept; the security rules simply stop reads and writes until access is extended.
- Clinicians cannot change `accessUntil`, `status`, `email` or `createdAt` themselves (enforced by
  `firebase/firestore.rules`), and sign-up can grant at most 31 days.

## Data structure

```
users/{uid}                                        clinician profile, accessUntil, status, settings
users/{uid}/patients/{pid}                          code (P01), group, side, birth year, notes,
                                                    latestScore, lastSessionAt, progress (level,
                                                    zone stats, heat map, model training rows, ...)
users/{uid}/patients/{pid}/sessions/{sid}            one played part: ~80 summary measures, score,
                                                    trials[] (one per fruit), repRows[]
users/{uid}/patients/{pid}/sessions/{sid}/frames/{n} every camera frame, gzip-compressed CSV chunks
users/{uid}/patients/{pid}/assessments/{aid}         therapist-entered Fugl-Meyer (FMA-UE) scores
```

Session IDs look like `20261102_194457_p1` (visit date-time + part number). Every measure in the
Python CSVs is kept (field names in camelCase), so the data can be exported for research or model
training (Trials / Reps / Frames / Summary CSV buttons on each session page).

## Changes from the Python version

The game logic is a direct port (`src/engine/`), with these agreed fixes:

- The ability (pheromone) heat map **carries over** between parts and sessions (setting, default 80%).
- **Automatic level changes are on**: pass the top note ≥80% (≥4 tries) → next level; two hard
  sessions (<50%) in a row → back one level. The next session starts at the patient's level.
- The catch model's **Brier score** is computed only over fruits where the model was switched on.
- Target catch chance (65%), posture limits (15% / 10%), daily goal (200) and the stroke assist
  are **settings** per clinician.
- Pain-after is also asked when the clinician stops after a completed part.

## Performance score (0-100)

An **estimate** from game measures, clearly labelled as not a clinical score (`src/engine/score.ts`):
reach 25%, smoothness 20%, speed 20%, accuracy 15%, posture 20%. Therapist-entered Fugl-Meyer scores
are stored next to it, to train and validate a real recovery-prediction model later.

## Project layout

```
src/engine/   game logic (config, Kalman, heat map + Sobel + UCB1 + catch model, audio, tracker, game, score)
src/data/     DataStore interface, Firebase store, local demo store, frame compression
src/pages/    sign-in/up, patients, patient dashboard, session detail, play, settings
firebase/     Firestore security rules and indexes
```
