import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";

const GGUF_MAGIC = [0x47, 0x47, 0x55, 0x46]; // "GGUF"

// A FIFO opens at once instead of waiting for a writer, and a terminal cannot become the
// scanner's controlling tty. The descriptor is then checked, so nothing is swapped in before the read.
const OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOCTTY;

/** Whether a file is GGUF, or why that could not be told. A file that cannot be read is not a no. */
export type GgufCheck = { gguf: boolean } | { error: string };

/** GGUF if and only if it is a regular file whose first 4 bytes are `GGUF`, whatever its name (ISC-1). */
export async function checkGguf(path: string): Promise<GgufCheck> {
  let fh: FileHandle | undefined;
  try {
    fh = await open(path, OPEN_FLAGS);
    if (!(await fh.stat()).isFile()) return { gguf: false };
    const buf = new Uint8Array(4);
    const { bytesRead } = await fh.read(buf, 0, 4, 0);
    return { gguf: bytesRead === 4 && GGUF_MAGIC.every((b, i) => buf[i] === b) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  } finally {
    await fh?.close();
  }
}
