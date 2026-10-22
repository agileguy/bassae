import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A fixture tree: a string or bytes is a file, a nested object is a directory, link() is a symlink.
export interface Tree {
  [name: string]: string | Uint8Array | Tree | Link;
}

export interface Link {
  readonly linkTo: string;
}

export const link = (target: string): Link => ({ linkTo: target });

/** Minimal bytes that pass the GGUF magic check. */
export const GGUF_BYTES = new Uint8Array([0x47, 0x47, 0x55, 0x46, 3, 0, 0, 0]);

/** Builds the tree under a fresh temp dir and returns the dir's realpath, so ids compare equal. */
export function makeTree(tree: Tree): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "bassae-"));
  write(root, tree);
  return root;
}

function write(dir: string, tree: Tree): void {
  mkdirSync(dir, { recursive: true });
  for (const [name, value] of Object.entries(tree)) {
    const path = join(dir, name);
    if (typeof value === "string" || value instanceof Uint8Array) writeFileSync(path, value);
    else if ("linkTo" in value && typeof value.linkTo === "string") symlinkSync(value.linkTo, path);
    else write(path, value as Tree);
  }
}
