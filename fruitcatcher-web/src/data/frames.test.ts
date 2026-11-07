import { describe, expect, it } from "vitest";
import { CHUNK_BYTES, decodeFrames, encodeFrames } from "./frames";

describe("frame storage", () => {
  it("round-trips per-frame data through gzip chunks", async () => {
    const rows = Array.from({ length: 20000 }, (_, i) => [i / 30, 1, Math.random(), Math.random(), i, null, 3.25, -1,
      null, 120.5, 2, 0.4, null, null, 12, 90, null, 400]);
    const chunks = await encodeFrames(rows);
    expect(chunks.every((c) => c.length <= CHUNK_BYTES)).toBe(true);
    const back = await decodeFrames(chunks);
    expect(back.length).toBe(rows.length);
    expect(back[123]).toEqual(rows[123]);
  });
});
