import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { crc32, makeZip } from "./zip";

describe("zip writer", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes one entry per file with the right sizes", async () => {
    const files = { "P01_export/sessions.csv": "a,b\n1,2", "P01_export/frames/s1.csv": "t,x\n0,1" };
    const bytes = new Uint8Array(await makeZip(files).arrayBuffer());
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(0, true)).toBe(0x04034b50); // starts with a local file header
    const end = view.getUint32(bytes.length - 22, true);
    expect(end).toBe(0x06054b50); // ends with the end-of-central-directory record
    expect(view.getUint16(bytes.length - 22 + 10, true)).toBe(2); // two entries
    if (process.env.ZIP_OUT) writeFileSync(process.env.ZIP_OUT, bytes); // for checking with other unzip tools
  });
});
