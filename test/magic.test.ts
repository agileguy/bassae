import { afterAll, expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { checkGguf } from "../src/gguf/magic.ts";
import { GGUF_BYTES, link, makeTree, removeTrees } from "./helpers/tree.ts";

afterAll(removeTrees);

test("checkGguf reads the magic, not the extension", async () => {
  const dir = makeTree({ "sha256-abc": GGUF_BYTES, "fake.gguf": "GGML....", short: "GG", sub: {} });
  expect(await checkGguf(join(dir, "sha256-abc"))).toEqual({ gguf: true });
  expect(await checkGguf(join(dir, "fake.gguf"))).toEqual({ gguf: false });
  expect(await checkGguf(join(dir, "short"))).toEqual({ gguf: false });
  expect(await checkGguf(join(dir, "sub"))).toEqual({ gguf: false });
});

test("a file that cannot be read is an error, not a no", async () => {
  const dir = makeTree({ "locked.gguf": GGUF_BYTES });
  expect(await checkGguf(join(dir, "missing"))).toHaveProperty("error");
  chmodSync(join(dir, "locked.gguf"), 0);
  // Root reads through mode 0, so the locked case only holds for other users.
  if (process.getuid?.() !== 0) expect(await checkGguf(join(dir, "locked.gguf"))).toHaveProperty("error");
});

test("a FIFO or device named like a GGUF is a no, and never blocks", async () => {
  const dir = makeTree({ "null.gguf": link("/dev/null") });
  expect(Bun.spawnSync(["mkfifo", join(dir, "x.gguf")]).exitCode).toBe(0);
  for (const name of ["x.gguf", "null.gguf"]) {
    const got = await Promise.race([checkGguf(join(dir, name)), Bun.sleep(2000).then(() => "hung")]);
    expect(got).toEqual({ gguf: false });
  }
});
