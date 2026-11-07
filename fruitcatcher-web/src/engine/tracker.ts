// Camera + MediaPipe hand and pose tracking, all inside the browser (the video never leaves the laptop).
import { FilesetResolver, HandLandmarker, PoseLandmarker } from "@mediapipe/tasks-vision";

export const POSE_IDX = [11, 12, 13, 14, 15, 16, 23, 24] as const;
export const CAM_W = 640; // reference picture size: palm size is measured in these pixels
export const CAM_H = 480;

export type Pose = Record<number, [number, number, number]>; // x, y (mirrored, 0..1), visibility

/** A pose point is usable when the model is fairly sure of it and it is not at the picture edge. */
export const poseOk = (pose: Pose, i: number) => {
  const [x, y, v] = pose[i];
  return v > 0.5 && x > 0.02 && x < 0.98 && y > 0.02 && y < 0.98;
};
/** Posture needs both shoulders. */
export const shouldersOk = (pose: Pose | null): pose is Pose => !!pose && poseOk(pose, 11) && poseOk(pose, 12);

export interface Obs {
  wrist: [number, number] | null; // mirrored, normalised 0..1
  palm: number | null; // wrist -> middle-finger knuckle, in 640x480 pixels (depth proxy)
  hand: string | null;
  pose: Pose | null;
}

export async function listCameras(): Promise<MediaDeviceInfo[]> {
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === "videoinput");
}

export class Tracker {
  video: HTMLVideoElement;
  private stream: MediaStream | null = null;
  private hands: HandLandmarker | null = null;
  private poseLm: PoseLandmarker | null = null;
  private running = false;
  private obs: Obs = { wrist: null, palm: null, hand: null, pose: null };
  private lastPose: Pose | null = null;
  private poseT = 0;
  private lastTs = -1;
  private pubT = 0;
  private seq = 0;
  private readSeq = 0;
  private waiters: (() => void)[] = [];
  poseOn = false;
  fps = 0;
  private fpsCount = 0;
  private fpsT = 0;

  constructor() {
    this.video = document.createElement("video");
    this.video.playsInline = true;
    this.video.muted = true;
  }

  /** Loads the models (from /public, so it works offline) and opens the camera. */
  async open(deviceId?: string, withPose = true) {
    const fileset = await FilesetResolver.forVisionTasks("/mediapipe/wasm");
    const make = async (delegate: "GPU" | "CPU") =>
      HandLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: "/models/hand_landmarker.task", delegate },
        runningMode: "VIDEO", numHands: 1,
        minHandDetectionConfidence: 0.5, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
      });
    this.hands = await make("GPU").catch(() => make("CPU"));
    if (withPose) {
      const makePose = async (delegate: "GPU" | "CPU") =>
        PoseLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: "/models/pose_landmarker_lite.task", delegate },
          runningMode: "VIDEO", numPoses: 1,
        });
      this.poseLm = await makePose("GPU").catch(() => makePose("CPU")).catch(() => null);
      this.poseOn = this.poseLm !== null;
    }
    await this.setCamera(deviceId);
    this.running = true;
    this.loop();
  }

  async setCamera(deviceId?: string) {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        width: { ideal: CAM_W }, height: { ideal: CAM_H }, frameRate: { ideal: 30 },
      },
    });
    this.video.srcObject = this.stream;
    await this.video.play();
  }

  get deviceId(): string | undefined {
    return this.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  }

  private loop() {
    if (!this.running) return;
    const v = this.video as HTMLVideoElement & {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };
    if (v.requestVideoFrameCallback) v.requestVideoFrameCallback(() => this.frame());
    else requestAnimationFrame(() => this.frame());
  }

  private frame() {
    if (!this.running) return;
    try {
      if (this.video.readyState >= 2 && this.hands) {
        const now = performance.now();
        const ts = Math.max(Math.round(now), this.lastTs + 1);
        this.lastTs = ts;
        const res = this.hands.detectForVideo(this.video, ts);
        const obs: Obs = { wrist: null, palm: null, hand: null, pose: null };
        if (res.landmarks.length) {
          const lm = res.landmarks[0];
          obs.wrist = [1 - lm[0].x, lm[0].y]; // mirror, like cv2.flip in the Python version
          obs.palm = Math.hypot((lm[9].x - lm[0].x) * CAM_W, (lm[9].y - lm[0].y) * CAM_H);
          obs.hand = res.handedness[0]?.[0]?.categoryName ?? null;
        }
        // pose at its own pace, about 10 per second
        if (this.poseLm && now - this.poseT >= 100) {
          this.poseT = now;
          const pr = this.poseLm.detectForVideo(this.video, ts);
          if (pr.landmarks.length) {
            const l = pr.landmarks[0];
            const p: Pose = {};
            for (const i of POSE_IDX) p[i] = [1 - l[i].x, l[i].y, l[i].visibility ?? 1];
            this.lastPose = p;
          } else this.lastPose = null;
        }
        this.obs = obs;
        this.seq += 1;
        this.pubT = now;
        this.fpsCount += 1;
        if (now - this.fpsT > 1000) {
          this.fps = Math.round((this.fpsCount * 1000) / (now - this.fpsT));
          this.fpsCount = 0;
          this.fpsT = now;
        }
        const w = this.waiters;
        this.waiters = [];
        w.forEach((f) => f());
      }
    } catch (e) {
      console.warn("tracking frame failed", e);
    }
    this.loop();
  }

  /** Newest observation. Waits briefly (up to 0.15 s) for a NEW frame, so the game runs at camera speed. */
  async read(): Promise<Obs> {
    if (this.seq === this.readSeq) {
      await new Promise<void>((res) => {
        const timer = setTimeout(res, 150);
        this.waiters.push(() => {
          clearTimeout(timer);
          res();
        });
      });
    }
    this.readSeq = this.seq;
    const o = { ...this.obs, pose: this.lastPose };
    if (performance.now() - this.pubT > 500) {
      o.wrist = null; // camera stopped giving pictures
      o.palm = null;
    }
    return o;
  }

  close() {
    this.running = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.hands?.close();
    this.poseLm?.close();
    this.waiters.forEach((f) => f());
    this.waiters = [];
  }
}

/** A simulated hand for demos and testing without a camera (?sim=1 on the play page).
 *  It moves the wrist towards `aim()` (normalised camera coordinates) like a calm reach. */
export class SimTracker extends Tracker {
  private p: [number, number] = [0.5, 0.75];
  private t0 = performance.now();
  private last = performance.now();
  aim: () => [number, number] | null = () => null;

  override async open() {
    this.poseOn = true;
    this.fps = 30;
  }
  override async setCamera() {}
  override get deviceId() {
    return "sim";
  }

  override async read(): Promise<Obs> {
    await new Promise((r) => setTimeout(r, 33));
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    const t = (now - this.t0) / 1000;
    // no target: sweep the arm around (calibration / free play)
    const target = this.aim() ?? [0.5 + 0.3 * Math.sin(t * 0.9), 0.5 + 0.3 * Math.sin(t * 1.3)];
    const dx = target[0] - this.p[0], dy = target[1] - this.p[1];
    const d = Math.hypot(dx, dy);
    const step = Math.min(d, 0.9 * dt); // about 0.9 frame-widths per second
    if (d > 1e-6) this.p = [this.p[0] + (dx / d) * step, this.p[1] + (dy / d) * step];
    const [x, y] = this.p;
    const pose: Pose = {
      11: [0.42, 0.42, 1], 12: [0.58, 0.42, 1], 13: [0.4, 0.58, 1], 14: [(0.58 + x) / 2, (0.42 + y) / 2, 1],
      15: [0.39, 0.72, 1], 16: [x, y, 1], 23: [0.44, 0.85, 1], 24: [0.56, 0.85, 1],
    };
    return { wrist: [x, y], palm: 60 + 25 * Math.sin(t * 0.7), hand: "Right", pose };
  }

  override close() {}
}
