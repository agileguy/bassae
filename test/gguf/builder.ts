// A synthetic GGUF writer. Tests build valid files with buildGguf and hand-craft hostile ones with Writer.

export const T = {
  U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12,
} as const;

/** GGUF token types the reader treats as special (CONTROL, USER_DEFINED). */
export const TOKEN = { NORMAL: 1, UNKNOWN: 2, CONTROL: 3, USER_DEFINED: 4, UNUSED: 5, BYTE: 6 } as const;

type Scalar = number | bigint | boolean;
type Element = Scalar | string | Uint8Array;

export type Value =
  | { type: number; value: Scalar }
  | { type: typeof T.STRING; value: string | Uint8Array }
  | { type: typeof T.ARRAY; elemType: number; values: Element[] };

export const str = (value: string | Uint8Array): Value => ({ type: T.STRING, value });
export const u32 = (value: number): Value => ({ type: T.U32, value });
export const i32 = (value: number): Value => ({ type: T.I32, value });
export const u64 = (value: bigint): Value => ({ type: T.U64, value });
export const f32 = (value: number): Value => ({ type: T.F32, value });
export const bool = (value: boolean): Value => ({ type: T.BOOL, value });
export const arr = (elemType: number, values: Element[]): Value => ({ type: T.ARRAY, elemType, values });

const utf8 = new TextEncoder();

/** Little-endian byte writer, grown as needed. */
export class Writer {
  private buf = new Uint8Array(4096);
  private view = new DataView(this.buf.buffer);
  length = 0;

  private room(n: number): number {
    if (this.length + n > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.length + n) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.length));
      this.buf = next;
      this.view = new DataView(next.buffer);
    }
    const at = this.length;
    this.length += n;
    return at;
  }

  // room() may swap the buffer, so it runs before this.view or this.buf is read.
  u8(v: number) { const at = this.room(1); this.view.setUint8(at, v); return this; }
  i8(v: number) { const at = this.room(1); this.view.setInt8(at, v); return this; }
  u16(v: number) { const at = this.room(2); this.view.setUint16(at, v, true); return this; }
  i16(v: number) { const at = this.room(2); this.view.setInt16(at, v, true); return this; }
  u32(v: number) { const at = this.room(4); this.view.setUint32(at, v, true); return this; }
  i32(v: number) { const at = this.room(4); this.view.setInt32(at, v, true); return this; }
  f32(v: number) { const at = this.room(4); this.view.setFloat32(at, v, true); return this; }
  f64(v: number) { const at = this.room(8); this.view.setFloat64(at, v, true); return this; }
  u64(v: bigint | number) { const at = this.room(8); this.view.setBigUint64(at, BigInt(v), true); return this; }
  i64(v: bigint | number) { const at = this.room(8); this.view.setBigInt64(at, BigInt(v), true); return this; }
  bytes(b: Uint8Array) { const at = this.room(b.length); this.buf.set(b, at); return this; }

  /** u64 length, then the bytes. */
  str(s: string | Uint8Array) {
    const b = typeof s === "string" ? utf8.encode(s) : s;
    return this.u64(b.length).bytes(b);
  }

  scalar(type: number, v: Element) {
    switch (type) {
      case T.U8: return this.u8(Number(v));
      case T.I8: return this.i8(Number(v));
      case T.U16: return this.u16(Number(v));
      case T.I16: return this.i16(Number(v));
      case T.U32: return this.u32(Number(v));
      case T.I32: return this.i32(Number(v));
      case T.F32: return this.f32(Number(v));
      case T.BOOL: return this.u8(v ? 1 : 0);
      case T.STRING: return this.str(v as string | Uint8Array);
      case T.U64: return this.u64(v as bigint);
      case T.I64: return this.i64(v as bigint);
      case T.F64: return this.f64(Number(v));
      default: throw new Error(`builder: no writer for type ${type}`);
    }
  }

  /** u32 type, then the value. */
  value(v: Value) {
    this.u32(v.type);
    if ("values" in v) {
      this.u32(v.elemType).u64(v.values.length);
      for (const e of v.values) this.scalar(v.elemType, e);
      return this;
    }
    return this.scalar(v.type, v.value);
  }

  kv(key: string | Uint8Array, v: Value) {
    return this.str(key).value(v);
  }

  /** GGUF magic, version, tensor count, KV count. */
  header(kvCount: bigint | number, version = 3, tensorCount: bigint | number = 0) {
    return this.bytes(utf8.encode("GGUF")).u32(version).u64(tensorCount).u64(kvCount);
  }

  pad(alignment: number) {
    while (this.length % alignment !== 0) this.u8(0);
    return this;
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

export interface Tensor {
  name: string;
  dims: number[];
  /** ggml type; 0 is F32. */
  type: number;
  data: Uint8Array;
}

export interface BuildOptions {
  version?: number;
  tensors?: Tensor[];
  alignment?: number;
}

/** A well-formed GGUF. `kvEnd` is the exclusive end of the KV section, computed independently of the reader. */
export function buildGguf(kvs: [string | Uint8Array, Value][], opts: BuildOptions = {}): { bytes: Uint8Array; kvEnd: number } {
  const tensors = opts.tensors ?? [];
  const alignment = opts.alignment ?? 32;
  const w = new Writer().header(kvs.length, opts.version ?? 3, tensors.length);
  for (const [k, v] of kvs) w.kv(k, v);
  const kvEnd = w.length;

  let offset = 0;
  const offsets = tensors.map((t) => {
    const at = offset;
    offset += Math.ceil(t.data.length / alignment) * alignment;
    return at;
  });
  tensors.forEach((t, i) => {
    w.str(t.name).u32(t.dims.length);
    for (const d of t.dims) w.u64(d);
    w.u32(t.type).u64(offsets[i]!);
  });
  w.pad(alignment);
  for (const t of tensors) w.bytes(t.data).pad(alignment);
  return { bytes: w.finish(), kvEnd };
}

/** A small, realistic KV set: architecture, a default and a named template, the list, tokens with types. */
export function typicalKvs(template = "{% for m in messages %}<|im_start|>{{ m.role }}\n{{ m.content }}<|im_end|>\n{% endfor %}"): [string, Value][] {
  return [
    ["general.architecture", str("llama")],
    ["general.name", str("Synthetic 1B")],
    ["general.file_type", u32(7)],
    ["general.quantization_version", u32(2)],
    ["general.size_label", str("1B")],
    ["llama.context_length", u32(4096)],
    ["tokenizer.ggml.model", str("gpt2")],
    ["tokenizer.ggml.tokens", arr(T.STRING, ["<unk>", "<|im_start|>", "<|im_end|>", "hello", "<tool_call>", "world"])],
    ["tokenizer.ggml.token_type", arr(T.I32, [TOKEN.UNKNOWN, TOKEN.CONTROL, TOKEN.CONTROL, TOKEN.NORMAL, TOKEN.USER_DEFINED, TOKEN.NORMAL])],
    ["tokenizer.ggml.merges", arr(T.STRING, ["h e", "l l", "o w"])],
    ["tokenizer.ggml.bos_token_id", u32(1)],
    ["tokenizer.chat_template", str(template)],
    ["tokenizer.chat_template.tool_use", str("{{ tools | tojson }}")],
    ["tokenizer.chat_templates", arr(T.STRING, ["tool_use"])],
  ];
}

/** A vocabulary the size of Gemma's, so read-ahead and timing are exercised at real scale. */
export function bigVocabKvs(n = 262_144): [string, Value][] {
  const tokens: string[] = [];
  const types: number[] = [];
  const merges: string[] = [];
  for (let i = 0; i < n; i++) {
    const special = i < 300;
    tokens.push(special ? `<ctrl${i}>` : `tok${i.toString(36)}`);
    types.push(special ? TOKEN.CONTROL : TOKEN.NORMAL);
    merges.push(`${(i % 97).toString(36)} ${(i % 89).toString(36)}`);
  }
  return [
    ["general.architecture", str("gemma3")],
    ["tokenizer.ggml.tokens", arr(T.STRING, tokens)],
    ["tokenizer.ggml.scores", arr(T.F32, tokens.map((_, i) => -i))],
    ["tokenizer.ggml.token_type", arr(T.I32, types)],
    ["tokenizer.ggml.merges", arr(T.STRING, merges)],
    ["tokenizer.chat_template", str("{{ bos_token }}{% for m in messages %}<start_of_turn>{{ m.role }}\n{{ m.content }}<end_of_turn>\n{% endfor %}")],
  ];
}
