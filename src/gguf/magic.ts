import { open } from "node:fs/promises";

const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46]; // "GGUF"

/** True if and only if the file's first 4 bytes are `GGUF`, whatever its name (ISC-1). */
export async function isGguf(path: string): Promise<boolean> {
  let fh;
  try {
    fh = await open(path, "r");
    const buf = new Uint8Array(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return bytesRead === 4 && GGUF_MAGIC.every((b, i) => buf[i] === b);
  } catch {
    return false;
  } finally {
    await fh?.close();
  }
}
