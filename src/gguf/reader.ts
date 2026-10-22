import type { Severity } from "../types.ts";

/** Random-access bytes. Every read the parser makes goes through one, so tests can watch the offsets (ISC-38). */
export interface ByteSource {
  readonly size: number;
  /** Up to `length` bytes at `offset`; fewer only at end of file. */
  read(offset: number, length: number): Uint8Array;
}

/** A structural problem: the bytes are not valid GGUF, or they break a cap. */
export class GgufError extends Error {}

export interface RawTemplate {
  key: string;
  bytes: Uint8Array;
}

export interface Problem {
  ruleId: "parse_error";
  severity: Severity;
  message: string;
  key?: string;
}

export interface GgufParse {
  version?: number;
  tensorCount?: bigint;
  kvCount?: bigint;
  /** Exclusive end offset of the KV section. Set only when every KV parsed. */
  kvEnd?: number;
  templates: RawTemplate[];
  /** tokenizer.chat_templates, when it is a string array. */
  templateList?: string[];
  general: Record<string, string | number | boolean | bigint>;
  specialTokens: string[];
  problems: Problem[];
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) };
}

export function openFileSource(_path: string): ByteSource & { close(): void } {
  throw new Error("not implemented");
}

export function parseGguf(_src: ByteSource): GgufParse {
  return { templates: [], general: {}, specialTokens: [], problems: [] };
}
