// Canvas drawing helpers for the play area.
import { GRID, H, W } from "./config";

export type Ctx = CanvasRenderingContext2D;
const FONT = "Inter, system-ui, sans-serif";

export const C = {
  card: "rgba(15, 23, 42, 0.92)",
  accent: "#14b8a6",
  cyan: "#00e6ff",
  yellow: "#ffd700",
  green: "#32eb6e",
  orange: "#ff8c00",
  pink: "#f05a1e",
  text: "#fff8ee",
  dim: "#cbd5e1",
};

export function text(ctx: Ctx, s: string, x: number, y: number, size = 20, color = "#fff", weight = 600, align: CanvasTextAlign = "left") {
  ctx.font = `${weight} ${size}px ${FONT}`;
  ctx.textAlign = align;
  ctx.textBaseline = "alphabetic";
  ctx.lineWidth = Math.max(3, size / 6);
  ctx.strokeStyle = "rgba(0,0,0,0.75)";
  ctx.lineJoin = "round";
  ctx.strokeText(s, x, y);
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

export const textCenter = (ctx: Ctx, s: string, y: number, size = 28, color = "#fff", weight = 700) =>
  text(ctx, s, W / 2, y, size, color, weight, "center");

export function textWidth(ctx: Ctx, s: string, size: number, weight = 600) {
  ctx.font = `${weight} ${size}px ${FONT}`;
  return ctx.measureText(s).width;
}

/** Splits s into lines no wider than maxW (breaks at spaces; a single long word keeps its own line). */
export function wrapText(ctx: Ctx, s: string, maxW: number, size: number, weight = 600): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of s.split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && textWidth(ctx, next, size, weight) > maxW) {
      out.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur || !out.length) out.push(cur);
  return out;
}

/** Blend a solid colour over rows y0..y1. */
export function tint(ctx: Ctx, y0: number, y1: number, color: string, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(0, y0, W, y1 - y0);
  ctx.restore();
}

export function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, fill: string, stroke?: string, lw = 2) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = stroke;
    ctx.stroke();
  }
}

export function drawFruit(ctx: Ctx, x: number, y: number, faded = false) {
  ctx.save();
  if (faded) {
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = C.orange;
    ctx.beginPath();
    ctx.arc(x, y, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    return;
  }
  ctx.globalAlpha = 0.35; // soft yellow glow
  ctx.fillStyle = C.yellow;
  ctx.beginPath();
  ctx.arc(x, y, 46, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  const grad = ctx.createRadialGradient(x - 10, y - 12, 4, x, y, 34);
  grad.addColorStop(0, "#ff8a5c");
  grad.addColorStop(1, "#ff4628");
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.arc(x, y, 33, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#ffd200";
  ctx.stroke();
  ctx.fillStyle = "#fff5dc";
  ctx.beginPath();
  ctx.arc(x - 11, y - 12, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#28c83c";
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x, y - 33);
  ctx.lineTo(x + 6, y - 46);
  ctx.stroke();
  ctx.fillStyle = "#3ce650";
  ctx.beginPath();
  ctx.ellipse(x + 14, y - 42, 11, 5, (-20 * Math.PI) / 180, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

export function dashedCircle(ctx: Ctx, x: number, y: number, r: number, color: string, lw = 2) {
  ctx.save();
  ctx.setLineDash([10, 10]);
  ctx.lineWidth = lw;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** Jet colour map (as cv2.COLORMAP_JET), v in 0..1 -> [r, g, b]. */
export function jet(v: number): [number, number, number] {
  const c = (x: number) => Math.round(255 * Math.min(Math.max(x, 0), 1));
  return [c(1.5 - Math.abs(4 * v - 3)), c(1.5 - Math.abs(4 * v - 2)), c(1.5 - Math.abs(4 * v - 1))];
}

/** LIVE HEAT MAP: warm = caught here often, blue = not yet; white boxes = the edge (frontier). */
export function drawHeat(ctx: Ctx, g: Float32Array, mask: Uint8Array) {
  let mx = 1e-6;
  for (const v of g) mx = Math.max(mx, v);
  const cw = W / GRID, ch = H / GRID;
  ctx.save();
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const v = g[r * GRID + c] / mx;
      const [R, G, B] = jet(v);
      ctx.globalAlpha = 0.15 + 0.55 * v;
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.fillRect(c * cw, r * ch, cw + 1, ch + 1);
    }
  }
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) ctx.strokeRect((i % GRID) * cw, Math.floor(i / GRID) * ch, cw, ch);
  }
  ctx.fillStyle = "rgba(0,0,0,0.6)";
  ctx.fillRect(0, 0, W, 66);
  ctx.restore();
  text(ctx, "LIVE HEAT MAP   (press H to hide)", 14, 28, 20, C.yellow, 700);
  text(ctx, "Red = caught here often    Blue = not yet    White boxes = edge, where new fruits go", 14, 54, 15, C.text, 500);
}
