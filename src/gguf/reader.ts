import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import type { Severity } from "../types.ts";
import { MAX_ARRAY_LENGTH, MAX_KEY_BYTES, MAX_KV_COUNT, MAX_KV_SECTION_BYTES, MAX_STRING_BYTES } from "./limits.ts";
import { CHAT_TEMPLATE_KEY, cKey, TEMPLATE_LIST_KEY } from "./templates.ts";

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
  /** File offset of the value's first byte. */
  offset: number;
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
  /** Every KV parsed and every template key held a string, so no template went unread. */
  complete: boolean;
  templates: RawTemplate[];
  /** tokenizer.chat_templates, when it is a string array. */
  templateList?: string[];
  /** 64-bit integers outside the safe range are decimal strings, so the record survives JSON.stringify. */
  general: Record<string, string | number | boolean>;
  specialTokens: string[];
  problems: Problem[];
}

export function bytesSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: (offset, length) => bytes.subarray(offset, offset + length) };
}

/** Opens a regular file read-only. The caller closes it. */
export function openFileSource(path: string): ByteSource & { close(): void } {
  // O_NONBLOCK keeps a FIFO from blocking the open. The type check runs on the descriptor, so nothing can be swapped in after it.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let size: number;
  try {
    const stat = fstatSync(fd);
    // A FIFO or device would block a read or lie about its size.
    if (!stat.isFile()) throw new Error("not a regular file");
    size = stat.size;
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
const I32 = 5;
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
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A number when it converts exactly, else its decimal string. JSON.stringify throws on a bigint. */
const jsonSafe = (v: bigint): number | string => (v >= -SAFE && v <= SAFE ? Number(v) : String(v));

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

  /** A declared byte count as a number, once the file and the KV section cap both hold that many bytes from here. */
  fits(n: bigint, what: () => string): number {
    if (n <= BigInt(this.end - this.pos)) return Number(n);
    const where = BigInt(this.pos) + n > BigInt(MAX_KV_SECTION_BYTES) ? `past the KV section cap of ${MAX_KV_SECTION_BYTES}` : `but the file ends at ${this.src.size}`;
    throw new GgufError(`${what()} at offset ${this.pos} declares ${n} bytes, ${where}`);
  }

  /** The u64 at buf[at] as a number: exact below 2^53, and larger than any file above it. Byte reads run several times faster than DataView here. */
  private lengthAt(at: number): number {
    const b = this.buf;
    const lo = (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
    const hi = (b[at + 4]! | (b[at + 5]! << 8) | (b[at + 6]! << 16) | (b[at + 7]! << 24)) >>> 0;
    return hi * 2 ** 32 + lo;
  }

  /** Reads a u64 byte count the file must hold, so skipping by it can't overflow or overrun. */
  sized(what: () => string): number {
    const at = this.fill(8);
    const n = this.lengthAt(at);
    this.pos += 8;
    if (this.pos + n <= this.end) return n;
    return this.fits(this.view.getBigUint64(at, true), what);
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

  /** Skips `count` length-prefixed strings. A hostile array can hold 32 Mi of them, so this loop stays on the buffer. */
  skipStrings(count: number, what: (i: number) => string) {
    const base = this.floor;
    for (let i = 0; i < count; i++) {
      let at = this.pos - this.bufStart;
      if (at < 0 || at + 8 > this.buf.length) {
        this.floor = base + (count - i - 1) * 8;
        at = this.fill(8);
      }
      const n = this.lengthAt(at);
      this.pos += 8;
      if (this.pos + n > this.end) this.fits(this.view.getBigUint64(at, true), () => what(i));
      this.pos += n;
    }
    this.floor = base;
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

/** No length cap here: only arrays the reader keeps are capped, and their readers check MAX_ARRAY_LENGTH. */
function arrayHeader(cur: Cursor, key: string): { elemType: number; count: number } {
  const elemType = cur.u32();
  const declared = cur.u64();
  if (elemType === ARRAY) throw new GgufError(`${q(key)} is an array of arrays, which GGUF readers reject`, key);
  const size = elemType === STRING ? 8 : SCALAR_SIZE[elemType];
  if (size === undefined) throw new GgufError(`${q(key)} has unknown array element type ${elemType}`, key);
  // The smallest the array can be. A count the file can't hold fails here, before any loop.
  cur.fits(declared * BigInt(size), () => `array ${q(key)} of ${declared} elements`);
  return { elemType, count: Number(declared) };
}

/** Steps through a string array without keeping it. `visit` sees each element at its start; the bytes are then skipped. */
function walkStrings(cur: Cursor, count: number, key: string, visit?: (i: number, n: number) => void) {
  if (!visit) return cur.skipStrings(count, (i) => `element ${i} of ${q(key)}`);
  const base = cur.floor;
  for (let i = 0; i < count; i++) {
    cur.floor = base + (count - i - 1) * 8;
    const n = cur.sized(() => `element ${i} of ${q(key)}`);
    visit?.(i, n);
    cur.skip(n);
  }
  cur.floor = base;
}

function skipArray(cur: Cursor, elemType: number, count: number, key: string) {
  if (elemType === STRING) walkStrings(cur, count, key);
  else cur.skip(count * SCALAR_SIZE[elemType]!);
}

/** Skips a value by its checked size, however large, so an oversized value can't hide the KVs after it. */
function skipValue(cur: Cursor, type: number, key: string) {
  if (type === STRING) return cur.skip(cur.sized(() => `value of ${q(key)}`));
  if (type === ARRAY) {
    const { elemType, count } = arrayHeader(cur, key);
    return skipArray(cur, elemType, count, key);
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
  const out: GgufParse = { complete: false, templates: [], general: {}, specialTokens: [], problems: [] };
  const cur = new Cursor(src);
  let tokens: TokenSpans | undefined;
  let special: Uint8Array | undefined;
  // The key whose value is being read, so a stop inside it can be pinned on it.
  let current: string | undefined;
  let unread = false;
  const problem = (severity: Severity, message: string, key?: string) => {
    out.problems.push({ ruleId: "parse_error", severity, message, key });
  };

  const readKv = (seen: Set<string>) => {
    // `key` is the stored key, used in messages. `name` is what llama.cpp looks up, used for matching.
    const key = utf8.decode(cur.bytes(length(cur, MAX_KEY_BYTES, "key")));
    current = key;
    const name = cKey(key);
    const type = cur.u32();
    const isTemplate = CHAT_TEMPLATE_KEY.test(name);
    if (name !== key) {
      // No real file has one. On a template key it hides the template from gguf-py and HF tooling while llama.cpp still renders it.
      problem(isTemplate ? "HIGH" : "MEDIUM", `key ${q(key)} contains a NUL byte; llama.cpp reads it as ${q(name)}`, key);
    }
    if (seen.has(name)) {
      // Readers disagree on which copy wins. llama.cpp refuses exact duplicates but takes the first NUL alias.
      problem(isTemplate ? "HIGH" : "MEDIUM", `key ${q(name)} appears more than once`, key);
    }
    seen.add(name);

    if (isTemplate) {
      if (type === STRING) {
        const n = cur.sized(() => `value of ${q(key)}`);
        if (n <= MAX_STRING_BYTES) {
          out.templates.push({ key, offset: cur.pos, bytes: cur.bytes(n) });
          return;
        }
        // Skipped rather than stopped on, so the templates after it still get read.
        unread = true;
        problem("HIGH", `${q(key)} holds ${n} bytes; the cap is ${MAX_STRING_BYTES}, so it was not extracted`, key);
        return cur.skip(n);
      }
      // llama.cpp renders a scalar as its text and has no template when it finds an array. Either way the record is incomplete.
      if (type === ARRAY) {
        unread = true;
        problem("MEDIUM", `${q(key)} holds an array, so llama.cpp has no template here and none was extracted`, key);
      } else if (type in SCALAR_SIZE) {
        unread = true;
        problem("MEDIUM", `${q(key)} holds a value of type ${type}, which llama.cpp renders as its text; it was not extracted`, key);
      }
    } else if (name === TEMPLATE_LIST_KEY) {
      const names = type === ARRAY ? readNames(key) : undefined;
      if (names) {
        out.templateList = names;
        return;
      }
      problem("MEDIUM", `${q(key)} is not a string array of names within the caps, so it was not checked`, key);
      if (type === ARRAY) return;
    } else if (name === "tokenizer.ggml.tokens" && type === ARRAY) {
      const { elemType, count } = arrayHeader(cur, key);
      if (elemType !== STRING || count > MAX_ARRAY_LENGTH) {
        if (elemType === STRING) problem("MEDIUM", `${q(key)} has ${count} entries; the cap is ${MAX_ARRAY_LENGTH}, so special tokens were not read`, key);
        return skipArray(cur, elemType, count, key);
      }
      // Only offsets are kept; the few special tokens are decoded once token_type is known.
      const spans = { starts: new Float64Array(count), lengths: new Uint32Array(count) };
      let long = -1;
      walkStrings(cur, count, key, (i, n) => {
        if (n > MAX_STRING_BYTES && long < 0) long = i;
        spans.starts[i] = cur.pos;
        spans.lengths[i] = n;
      });
      if (long < 0) tokens = spans;
      else problem("MEDIUM", `entry ${long} of ${q(key)} is over ${MAX_STRING_BYTES} bytes, the cap, so special tokens were not read`, key);
      return;
    } else if (name === "tokenizer.ggml.token_type") {
      // llama.cpp reads this as int32 whatever type it declares, so under any other type its special tokens aren't ours to guess.
      const array = type === ARRAY ? arrayHeader(cur, key) : undefined;
      if (array?.elemType === I32 && array.count <= MAX_ARRAY_LENGTH) {
        const raw = cur.bytes(array.count * 4);
        const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
        special = new Uint8Array(array.count);
        for (let i = 0; i < array.count; i++) {
          const t = view.getInt32(i * 4, true);
          special[i] = t === CONTROL || t === USER_DEFINED ? 1 : 0;
        }
        return;
      }
      const why = !array ? "is not an array" : array.elemType !== I32 ? `has element type ${array.elemType}, not int32` : `has ${array.count} entries; the cap is ${MAX_ARRAY_LENGTH}`;
      problem("MEDIUM", `${q(key)} ${why}, so special tokens were not read`, key);
      if (array) return skipArray(cur, array.elemType, array.count, key);
    } else if (name.startsWith("general.") && (type === STRING || type in SCALAR_SIZE)) {
      if (type === STRING) {
        const n = cur.sized(() => `value of ${q(key)}`);
        // Provenance hints only. One past the cap is skipped, not kept.
        if (n <= MAX_STRING_BYTES) out.general[name] = utf8.decode(cur.bytes(n));
        else cur.skip(n);
        return;
      }
      const v = cur.scalar(type);
      out.general[name] = typeof v === "bigint" ? jsonSafe(v) : v;
      return;
    }
    skipValue(cur, type, key);
  };

  /** tokenizer.chat_templates as names, or undefined once it is skipped for not being a string array within the caps. */
  const readNames = (key: string): string[] | undefined => {
    const { elemType, count } = arrayHeader(cur, key);
    if (elemType !== STRING || count > MAX_ARRAY_LENGTH) {
      skipArray(cur, elemType, count, key);
      return undefined;
    }
    const names: string[] = [];
    let fits = true;
    walkStrings(cur, count, key, (_, n) => {
      // A name longer than any key the reader accepts can't name a template.
      if (n > MAX_KEY_BYTES) fits = false;
      else names.push(utf8.decode(cur.peek(n)));
    });
    return fits ? names : undefined;
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
      current = undefined;
      readKv(seen);
    }
    out.kvEnd = cur.pos;
    out.complete = !unread;
  } catch (e) {
    if (!(e instanceof GgufError)) throw e;
    const key = e.key ?? current;
    const message = e.key === undefined && key !== undefined ? `${e.message}, reading ${q(key)}` : e.message;
    // Past a good magic and version, any KV after the stop could be a template nobody checked. Before them, no engine loads the file.
    problem(out.version === undefined ? "MEDIUM" : "HIGH", message, key);
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
    const token = utf8.decode(region.subarray(at, at + tokens.lengths[i]!));
    // An empty token would make every gap in a template look like scaffolding.
    if (token !== "") found.add(token);
  }
  return [...found];
}
