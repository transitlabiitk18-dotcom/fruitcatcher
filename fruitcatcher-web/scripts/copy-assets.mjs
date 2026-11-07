// Copies the MediaPipe WebAssembly files and the two .task models into public/,
// so the app works offline and never loads tracking code from the internet.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wasmSrc = join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const wasmDst = join(root, "public/mediapipe/wasm");
mkdirSync(wasmDst, { recursive: true });
cpSync(wasmSrc, wasmDst, { recursive: true });

const modelsDst = join(root, "public/models");
mkdirSync(modelsDst, { recursive: true });
for (const name of ["hand_landmarker.task", "pose_landmarker_lite.task"]) {
  const dst = join(modelsDst, name);
  if (existsSync(dst)) continue;
  const src = join(root, "..", name);          // the copies next to fruitcatcher_1cam.py
  if (!existsSync(src)) {
    console.warn(`Missing ${name}: put it in public/models/`);
    continue;
  }
  cpSync(src, dst);
}
console.log("MediaPipe files ready in public/");
