import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { Severity } from "../types.ts";
import { MAX_ARRAY_LENGTH, MAX_KEY_BYTES, MAX_KV_COUNT, MAX_KV_SECTION_BYTES, MAX_STRING_BYTES } from "./limits.ts";
import { CHAT_TEMPLATE_KEY, TEMPLATE_LIST_KEY } from "./templates.ts";

/** Random-access bytes. Every read the parser makes goes through one, so tests can watch the offsets (ISC-38). */
export interface ByteSource {
  readonly size: number;
  /** Up to `length` bytes at `offset`; fewer only at end of file. */
  read(offset: number, length: number): Uint8Array;
}

/** A structural problem: the bytes are not valid GGUF, or they break a cap. Parsing stops here. */
export class GgufError extends Error {
  constructor(message: string, readonly key?: string) {
    super(message);
  }
}

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

/** Opens a file read-only. The caller closes it. */
export function openFileSource(path: string): ByteSource & { close(): void } {
  const fd = openSync(path, "r");
  let size: number;
  try {
    size = fstatSync(fd).size;
  } catch (e) {
    closeSync(fd);
    throw e;
  }
  return {
    size,
    read(offset, length) {
      const buf = new Uint8Array(length);
      let got = 0;
      while (got < length) {
        const n = readSync(fd, buf, got, length - got, offset + got);
        if (n === 0) break;
        got += n;
      }
      return got === length ? buf : buf.subarray(0, got);
    },
    close: () => closeSync(fd),
  };
}

const MAGIC = [0x47, 0x47, 0x55, 0x46]; // "GGUF"
const U32 = 4;
const STRING = 8;
const ARRAY = 9;
const U64 = 10;
/** Byte size of each scalar value type. Strings and arrays have none. */
const SCALAR_SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
/** The smallest possible KV: an empty key's u64 length, a u32 type, a one-byte value. */
const MIN_KV_BYTES = 13;
const CONTROL = 3;
const USER_DEFINED = 4;
const READ_AHEAD = 1 << 20;

const utf8 = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });
const q = (key: string) => JSON.stringify(key);

function scalarAt(v: DataView, at: number, type: number): number | bigint | boolean {
  switch (type) {
    case 0: return v.getUint8(at);
    case 1: return v.getInt8(at);
    case 2: return v.getUint16(at, true);
    case 3: return v.getInt16(at, true);
    case 4: return v.getUint32(at, true);
    case 5: return v.getInt32(at, true);
    case 6: return v.getFloat32(at, true);
    case 7: return v.getUint8(at) !== 0;
    case 10: return v.getBigUint64(at, true);
    case 11: return v.getBigInt64(at, true);
    default: return v.getFloat64(at, true);
  }
}

/** A forward reader over a ByteSource that batches small reads without straying past the KV section. */
class Cursor {
  pos = 0;
  /** Bytes the parser knows must follow the current read. Read-ahead stops there, so it never crosses the end of the KV section (ISC-38). */
  floor = 0;
  private buf: Uint8Array = new Uint8Array(0);
  private view: DataView = new DataView(this.buf.buffer);
  private bufStart = 0;
  private readonly end: number;

  constructor(private readonly src: ByteSource) {
    this.end = Math.min(src.size, MAX_KV_SECTION_BYTES);
  }

  /** Throws unless n more bytes exist in the file and under the KV section cap. */
  need(n: number) {
    if (this.pos + n <= this.end) return;
    if (this.pos + n > MAX_KV_SECTION_BYTES) throw new GgufError(`the KV section runs past ${MAX_KV_SECTION_BYTES} bytes, the cap`);
    throw new GgufError(`truncated: ${n} bytes needed at offset ${this.pos}, but the file ends at ${this.src.size}`);
  }

  /** Index into buf of the n bytes at pos, reading them if they aren't buffered. */
  private fill(n: number): number {
    const at = this.pos - this.bufStart;
    if (at >= 0 && at + n <= this.buf.length) return at;
    this.need(n);
    const want = Math.min(Math.max(n, Math.min(READ_AHEAD, n + this.floor)), this.end - this.pos);
    const got = this.src.read(this.pos, want);
    if (got.length < n) throw new GgufError(`short read at offset ${this.pos}: wanted ${n} bytes, got ${got.length}`);
    this.buf = got;
    this.view = new DataView(got.buffer, got.byteOffset, got.byteLength);
    this.bufStart = this.pos;
    return 0;
  }

  skip(n: number) {
    this.need(n);
    this.pos += n;
  }

  /** A copy of the next n bytes. */
  bytes(n: number): Uint8Array {
    const at = this.fill(n);
    this.pos += n;
    return this.buf.slice(at, at + n);
  }

  /** The next n bytes, without moving. */
  peek(n: number): Uint8Array {
    const at = this.fill(n);
    return this.buf.subarray(at, at + n);
  }

  scalar(type: number): number | bigint | boolean {
    const size = SCALAR_SIZE[type];
    if (size === undefined) throw new GgufError(`unknown value type ${type} at offset ${this.pos}`);
    const at = this.fill(size);
    this.pos += size;
    return scalarAt(this.view, at, type);
  }

  u32 = () => this.scalar(U32) as number;
  u64 = () => this.scalar(U64) as bigint;
}

/** Reads a u64 length and checks it against the cap before anything is allocated. */
function length(cur: Cursor, cap: number, what: string, key?: string): number {
  const at = cur.pos;
  const n = cur.u64();
  if (n > BigInt(cap)) throw new GgufError(`${what} at offset ${at} declares ${n} bytes; the cap is ${cap}`, key);
  return Number(n);
}

function arrayHeader(cur: Cursor, key: string): { elemType: number; count: number } {
  const elemType = cur.u32();
  const declared = cur.u64();
  if (elemType === ARRAY) throw new GgufError(`${q(key)} is an array of arrays, which GGUF readers reject`, key);
  const size = elemType === STRING ? 8 : SCALAR_SIZE[elemType];
  if (size === undefined) throw new GgufError(`${q(key)} has unknown array element type ${elemType}`, key);
  if (declared > BigInt(MAX_ARRAY_LENGTH)) throw new GgufError(`${q(key)} declares ${declared} elements; the cap is ${MAX_ARRAY_LENGTH}`, key);
  const count = Number(declared);
  // The smallest the array can be. A count the file can't hold fails here, before any loop.
  cur.need(count * size);
  return { elemType, count };
}

/** Steps through a string array. `visit` sees each element at its start; the bytes are then skipped. */
function walkStrings(cur: Cursor, count: number, key: string, visit?: (i: number, n: number) => void) {
  const base = cur.floor;
  for (let i = 0; i < count; i++) {
    cur.floor = base + (count - i - 1) * 8;
    const n = length(cur, MAX_STRING_BYTES, `element ${i} of ${q(key)}`, key);
    visit?.(i, n);
    cur.skip(n);
  }
  cur.floor = base;
}

function skipValue(cur: Cursor, type: number, key: string) {
  if (type === STRING) return cur.skip(length(cur, MAX_STRING_BYTES, `value of ${q(key)}`, key));
  if (type === ARRAY) {
    const { elemType, count } = arrayHeader(cur, key);
    if (elemType === STRING) return walkStrings(cur, count, key);
    return cur.skip(count * SCALAR_SIZE[elemType]!);
  }
  const size = SCALAR_SIZE[type];
  if (size === undefined) throw new GgufError(`${q(key)} has unknown value type ${type}`, key);
  cur.skip(size);
}

function unsupportedVersion(v: number): string {
  if (v === 0x02000000 || v === 0x03000000) return `big-endian GGUF (version ${v >>> 24}) is not supported`;
  return `unsupported GGUF version ${v}; only 2 and 3 are read`;
}

interface TokenSpans {
  starts: Float64Array;
  lengths: Uint32Array;
}

/** Parses the header and KV section, stopping before tensor info. Throws only on I/O failure, never on content. */
export function parseGguf(src: ByteSource): GgufParse {
  const out: GgufParse = { templates: [], general: {}, specialTokens: [], problems: [] };
  const cur = new Cursor(src);
  let tokens: TokenSpans | undefined;
  let special: Uint8Array | undefined;

  const readKv = (seen: Set<string>) => {
    const key = utf8.decode(cur.bytes(length(cur, MAX_KEY_BYTES, "key")));
    const type = cur.u32();
    const isTemplate = CHAT_TEMPLATE_KEY.test(key);
    if (seen.has(key)) {
      // An engine keeps one of the copies, and which one differs between readers.
      out.problems.push({ ruleId: "parse_error", severity: isTemplate ? "HIGH" : "MEDIUM", message: `key ${q(key)} appears more than once`, key });
    }
    seen.add(key);

    if (isTemplate) {
      if (type === STRING) {
        out.templates.push({ key, bytes: cur.bytes(length(cur, MAX_STRING_BYTES, `value of ${q(key)}`, key)) });
        return;
      }
      out.problems.push({ ruleId: "parse_error", severity: "MEDIUM", message: `${q(key)} has value type ${type}, not string, so it was not extracted`, key });
    } else if (key === TEMPLATE_LIST_KEY) {
      if (type === ARRAY) {
        const { elemType, count } = arrayHeader(cur, key);
        if (elemType === STRING) {
          const names: string[] = [];
          walkStrings(cur, count, key, (_, n) => names.push(utf8.decode(cur.peek(n))));
          out.templateList = names;
          return;
        }
        cur.skip(count * SCALAR_SIZE[elemType]!);
      } else {
        skipValue(cur, type, key);
      }
      out.problems.push({ ruleId: "parse_error", severity: "MEDIUM", message: `${q(key)} is not a string array`, key });
      return;
    } else if (key === "tokenizer.ggml.tokens" && type === ARRAY) {
      const { elemType, count } = arrayHeader(cur, key);
      if (elemType !== STRING) return cur.skip(count * SCALAR_SIZE[elemType]!);
      // Only offsets are kept; the few special tokens are decoded once token_type is known.
      const spans = { starts: new Float64Array(count), lengths: new Uint32Array(count) };
      walkStrings(cur, count, key, (i, n) => {
        spans.starts[i] = cur.pos;
        spans.lengths[i] = n;
      });
      tokens = spans;
      return;
    } else if (key === "tokenizer.ggml.token_type" && type === ARRAY) {
      const { elemType, count } = arrayHeader(cur, key);
      if (elemType === STRING) return walkStrings(cur, count, key);
      const size = SCALAR_SIZE[elemType]!;
      const raw = cur.bytes(count * size);
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      special = new Uint8Array(count);
      for (let i = 0; i < count; i++) {
        const t = Number(scalarAt(view, i * size, elemType));
        special[i] = t === CONTROL || t === USER_DEFINED ? 1 : 0;
      }
      return;
    } else if (key.startsWith("general.") && type !== ARRAY) {
      out.general[key] =
        type === STRING ? utf8.decode(cur.bytes(length(cur, MAX_STRING_BYTES, `value of ${q(key)}`, key))) : cur.scalar(type);
      return;
    }
    skipValue(cur, type, key);
  };

  try {
    cur.floor = 20; // the rest of the fixed header
    const magic = cur.bytes(4);
    if (!MAGIC.every((b, i) => magic[i] === b)) throw new GgufError("not a GGUF file: the first 4 bytes are not GGUF");
    const version = cur.u32();
    if (version !== 2 && version !== 3) throw new GgufError(unsupportedVersion(version));
    out.version = version;
    out.tensorCount = cur.u64();
    out.kvCount = cur.u64();
    if (out.kvCount > BigInt(MAX_KV_COUNT)) throw new GgufError(`declares ${out.kvCount} KVs; the cap is ${MAX_KV_COUNT}`);

    const kvCount = Number(out.kvCount);
    const seen = new Set<string>();
    for (let i = 0; i < kvCount; i++) {
      cur.floor = (kvCount - i - 1) * MIN_KV_BYTES;
      readKv(seen);
    }
    out.kvEnd = cur.pos;
  } catch (e) {
    if (!(e instanceof GgufError)) throw e;
    out.problems.push({ ruleId: "parse_error", severity: "MEDIUM", message: e.message, key: e.key });
  }

  if (tokens && special) out.specialTokens = specialTokens(src, tokens, special, out.problems);
  return out;
}

/** Decodes the tokens marked CONTROL or USER_DEFINED, with one read over the span that holds them. */
function specialTokens(src: ByteSource, tokens: TokenSpans, special: Uint8Array, problems: Problem[]): string[] {
  const count = tokens.starts.length;
  if (count !== special.length) {
    problems.push({
      ruleId: "parse_error",
      severity: "MEDIUM",
      message: `tokenizer.ggml.token_type has ${special.length} entries but tokenizer.ggml.tokens has ${count}`,
      key: "tokenizer.ggml.token_type",
    });
  }
  const n = Math.min(count, special.length);
  const first = special.subarray(0, n).indexOf(1);
  if (first < 0) return [];
  const last = special.subarray(0, n).lastIndexOf(1);
  const from = tokens.starts[first]!;
  const to = tokens.starts[last]! + tokens.lengths[last]!;
  const region = src.read(from, to - from);
  if (region.length < to - from) {
    problems.push({ ruleId: "parse_error", severity: "MEDIUM", message: `short read of special tokens at offset ${from}` });
    return [];
  }
  const found = new Set<string>();
  for (let i = first; i <= last; i++) {
    if (!special[i]) continue;
    const at = tokens.starts[i]! - from;
    found.add(utf8.decode(region.subarray(at, at + tokens.lengths[i]!)));
  }
  return [...found];
}
