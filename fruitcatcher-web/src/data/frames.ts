// Per-frame data is large, so it is stored as gzip-compressed CSV split into chunks
// (Firestore documents are limited to 1 MB).
import { FRAME_FIELDS, type FrameRow } from "../engine/types";

export const CHUNK_BYTES = 900_000;

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream) {
  const out = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export async function encodeFrames(rows: FrameRow[]): Promise<Uint8Array[]> {
  const csv = [FRAME_FIELDS.join(","), ...rows.map((r) => r.map((v) => (v === null ? "" : v)).join(","))].join("\n");
  const gz = await pipe(new TextEncoder().encode(csv), new CompressionStream("gzip"));
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < gz.length; i += CHUNK_BYTES) chunks.push(gz.slice(i, i + CHUNK_BYTES));
  return chunks;
}

export async function decodeFrames(chunks: Uint8Array[]): Promise<FrameRow[]> {
  if (!chunks.length) return [];
  const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
  let o = 0;
  for (const c of chunks) {
    all.set(c, o);
    o += c.length;
  }
  const csv = new TextDecoder().decode(await pipe(all, new DecompressionStream("gzip")));
  return csv.split("\n").slice(1).filter(Boolean).map((line) => line.split(",").map((v) => (v === "" ? null : Number(v))));
}

export function framesToCsv(rows: FrameRow[]) {
  return [FRAME_FIELDS.join(","), ...rows.map((r) => r.map((v) => (v === null ? "" : v)).join(","))].join("\n");
}
