// Content integrity (ISC-22.3): every system, user and tool content a probe passes reaches the output verbatim,
// once, in order, inside a turn of its own role, unless a transform on the allowlist explains the difference.
//
// Turns (Decisions 02:58). A turn opens where a role word follows a turn-opening token the model declares, as in
// `<|im_start|>user` or `<|start|>developer`, or at a declared token that names its role itself, as GLM-4.5's
// `<|user|>`. The model's tokens come in the template's scaffolding. When it declares an opener the tables below
// list, only the declared ones open turns. When it declares none, as with a bare template, which has no model and
// so no tokens, every opener in the tables counts, and so does any other token the model declares: a template then
// cannot hide a content behind an inner tag, but it can open a turn with an opener its real model lacks, or with a
// token of an unlisted family that is not an opener there. Inner tags and aliases (`<tool_response>`,
// `<|observation|>`, `functions.<name>`, `<tool>`) never open a turn. They narrow the turn they sit in, to its own
// role or, in a user or model turn, to tool: Qwen prints a tool result in a user turn, and gemma-4, functiongemma,
// gpt-oss and GLM-4.5 in a model turn. Nothing narrows a system turn. A content's role is its turn's role, narrowed,
// and must be the content's own, so a content in a turn more privileged than its role fails whatever tag wraps it
// (system and developer, then user, then tool; assistant stands apart). Text before the first turn has no role. An
// output in which no turn opens at all is read by its markers alone, each naming the role until the next.
//
// Placement. Contents are placed left to right. Each must appear at or after the end of the one before it, inside
// a turn of its own role, read only from the output between them and never from a content itself. With no marker
// between them the turn the content before it sat in still holds, as when two text parts of one message print side
// by side. A distinctive content (several words, long enough not to recur by chance) counts at the first place it
// appears, so a template that echoes user text into the system prompt ahead of the user turn fails here rather than
// passing on the copy that follows. A short or one-word content may equal the template's own text (a trigger probe
// passes a template literal such as `<|im_start|>` or `system`), so it takes the first place it appears under its
// own role.
//
// Copies (Decisions 02:58). Once every content is placed, a distinctive one that appears again outside every placed
// content, whole or as a slice of at least TRUNCATION_MIN characters, fails: no transform on the allowlist copies a
// content, and a copy is how a template lifts one into a more privileged turn after its own, as a tool result or the
// last message echoed into a system turn. A slice the content shares with another input the probe passes, such as a
// phrase two turns repeat, says nothing and is not counted. A short content is not checked for copies, since the
// template's own text may hold it. A distinctive slice that is also the template's own text, as when a trigger
// probe's sentence holds a long literal the template prints, still counts: integrity fails closed (Decisions 02:28).

import type { Transform } from "../registry/index.ts";
import type { IntegrityIssue, Probe, ProbeContent } from "../types.ts";
import { CONTENT_MATCHERS, type ContentMatch, type ContentScan, type Role, type ScanInput } from "./transforms.ts";

// The role each turn word opens. A role passes as itself; the others are the words the pinned templates print in
// its place, each with the lines that print it.
const TURN_WORDS: ReadonlyMap<string, Role> = new Map(Object.entries({
  system: "system",
  // gpt-oss lines 234-244 put the system message in a developer message; functiongemma line 130 likewise.
  developer: "system",
  user: "user",
  // The phase brief's user alias. No pinned template prints it.
  human: "user",
  assistant: "assistant",
  // gemma-3 and gemma-3n line 22, gemma-4 (36e3a42e) line 219, functiongemma line 156.
  model: "assistant",
  // LFM2 line 4 and xLAM-2 line 29 print the message's own role.
  tool: "tool",
  // The Llama 3.x tool role, named in the phase brief. No pinned template prints it.
  ipython: "tool",
}) as [string, Role][]);

// The words a pinned template prints for a tool result inside another turn. They narrow a turn and never open one.
const ALIASES: ReadonlyMap<string, Role> = new Map(Object.entries({
  // Qwen2.5 line 44, Qwen3 line 72, GLM-4.5 line 86; gemma-4 (36e3a42e) line 161 prints <|tool_response>.
  tool_response: "tool",
  // GLM-4.5 line 84.
  observation: "tool",
  // functiongemma line 202.
  start_function_response: "tool",
}) as [string, Role][]);

// Tokens a role word right after opens a turn, each with the lines that print it before one.
const PREFIX_OPENERS = [
  // Qwen2.5 (d5495a1e) lines 2 and 42, Qwen3 (87a2728c) lines 2 and 70, LFM2 line 4, xLAM-2 lines 2, 29 and 60.
  "<|im_start|>",
  // gemma-3 lines 26 and 45, gemma-3n lines 26 and 47, functiongemma lines 130, 162 and 277.
  "<start_of_turn>",
  // gemma-4 (36e3a42e) lines 180, 220 and 234.
  "<|turn>",
  // gpt-oss lines 229, 244, 292 and 324.
  "<|start|>",
  // Llama 3.x, named in the phase brief. No pinned template prints it.
  "<|start_header_id|>",
];
// Tokens that open a turn of the role they name: GLM-4.5 lines 3, 45 and 49. A role word after one is its text.
const WHOLE_OPENERS = ["<|system|>", "<|user|>", "<|assistant|>"];

// A marker is a role word right after `<`, `>` or `|`, as a whole word: so `<|im_start|>user` and `<|observation|>`
// count, but a role in prose, a closing tag (`</tool_response>`, or gemma-4's `<tool_response|>`) or a JSON value
// (`"user"`) does not. gpt-oss line 321 marks a tool result with the tool's own name, `<|start|>functions.<name>`.
const MARKER = /(<\|?|>|\|)(functions\.[A-Za-z0-9_.-]+|[A-Za-z][A-Za-z0-9_]*)(?=(\|>)?)/g;

/** The role a marker match names, or undefined for another word or a closer. */
function roleOf(m: RegExpMatchArray): Role | undefined {
  if (m[1] === "<" && m[3]) return undefined; // <name|> closes a gemma-4 block
  const word = m[2]!;
  return word.startsWith("functions.") ? "tool" : (TURN_WORDS.get(word) ?? ALIASES.get(word));
}

/** The tokens that open turns, and whether one opens anywhere in the output at hand. */
interface Turns {
  prefix: readonly string[];
  whole: readonly string[];
  /** False when no turn opens anywhere: each marker then names the role until the next, as before turns. */
  structured: boolean;
}
type Openers = Omit<Turns, "structured">;

/** The turn in effect at a point: the role its opener named, narrowed by the inner markers after it. */
interface Turn {
  turn?: Role;
  role?: Role;
}

// A declared token an unlisted family may open turns with: markup at both ends and a word inside, but not a tag
// that names a role or an alias, which never opens one.
const TOKEN = /^[^\sA-Za-z0-9]\S{0,62}[^\sA-Za-z0-9]$/;
const TAG = /^<\/?\|?([A-Za-z][A-Za-z0-9_]*)\|?>$/;
const namesRole = (t: string) => {
  const word = TAG.exec(t)?.[1];
  return word !== undefined && (TURN_WORDS.has(word) || ALIASES.has(word));
};

const OPENERS = new WeakMap<ReadonlySet<string>, Openers>();

/** The openers a template's scaffolding gives: the listed ones its model declares, else every listed and declared one. */
function openersOf(scaffolding: ReadonlySet<string>): Openers {
  let o = OPENERS.get(scaffolding);
  if (!o) {
    const prefix = PREFIX_OPENERS.filter((t) => scaffolding.has(t));
    const whole = WHOLE_OPENERS.filter((t) => scaffolding.has(t));
    const declared = [...scaffolding].filter((t) => TOKEN.test(t) && /[A-Za-z]/.test(t) && !namesRole(t));
    o = prefix.length + whole.length > 0 ? { prefix, whole } : { prefix: [...PREFIX_OPENERS, ...declared], whole: WHOLE_OPENERS };
    OPENERS.set(scaffolding, o);
  }
  return o;
}

const FALLBACK = openersOf(new Set());
// No openers: every marker names the role, as markerRole reads them.
const RAW: Turns = { prefix: [], whole: [], structured: false };

/** The role of the turn a marker match opens, or undefined when it opens none. Openers before `a` are not read. */
function opens(output: string, m: RegExpMatchArray, at: number, a: number, o: Openers): Role | undefined {
  const open = m[1]!;
  const name = m[2]!;
  const close = m[3];
  const role = TURN_WORDS.get(name);
  if (!role || (open === "<" && close)) return undefined;
  if (o.whole.includes(open + name + (close ?? ""))) return role;
  const word = at + open.length;
  return o.prefix.some((t) => word - t.length >= a && output.startsWith(t, word - t.length)) ? role : undefined;
}

/** `openers` for one output: whether a turn opens anywhere in it. */
function turnsIn(output: string, openers: Openers): Turns {
  for (const m of output.matchAll(MARKER)) if (opens(output, m, m.index!, 0, openers)) return { ...openers, structured: true };
  return { ...openers, structured: false };
}

/** The turn after the marker match at `at`, for a scan from `a`. */
function step(output: string, turns: Turns, a: number, t: Turn, m: RegExpMatchArray, at: number): Turn {
  const opened = opens(output, m, at, a, turns);
  if (opened) return { turn: opened, role: opened };
  const role = roleOf(m);
  if (!role) return t;
  if (t.turn) return role === t.turn || (role === "tool" && t.turn !== "system") ? { turn: t.turn, role } : t;
  return turns.structured ? t : { role };
}

/**
 * The turn in effect at each b in turn, b never decreasing, reading the output from `a` once: a content that recurs
 * a thousand times costs one pass, not a thousand. `initial` is the turn in effect at `a`.
 */
function turnScan(output: string, a: number, initial: Turn, turns: Turns): (b: number) => Turn {
  const re = new RegExp(MARKER.source, "g");
  re.lastIndex = a;
  let turn = initial;
  let next = re.exec(output);
  return (b) => {
    // A match is settled once b is past it and the two characters its closer test looks at.
    while (next && next.index + next[0].length + 2 <= b) {
      turn = step(output, turns, a, turn, next, next.index);
      next = re.exec(output);
    }
    if (!next || next.index >= b) return turn;
    // b cuts the next match or its closer test: read it as a scan of output[a, b) would.
    let cut = turn;
    for (const m of output.slice(next.index, b).matchAll(MARKER)) cut = step(output, turns, a, cut, m, next.index + m.index!);
    return cut;
  };
}

/** The role the last role marker in output[a, b) names, or undefined when there is none. Turns play no part. */
export function markerRole(output: string, a: number, b: number): Role | undefined {
  return turnScan(output, a, {}, RAW)(b).role;
}

// A content this long with a space inside is distinctive: the template's own text does not hold it by chance.
const DISTINCTIVE_MIN = 16;
const distinctive = (text: string) => text.length >= DISTINCTIVE_MIN && /\S\s+\S/.test(text);

/**
 * True when a role marker starts inside output[at, end) and runs on past it: the text there ends in the template's
 * own markup (`<|im_start|>` before `assistant`), so it is not a content.
 */
function endsInMarker(output: string, at: number, end: number): boolean {
  let word = end;
  while (word > at && /[A-Za-z0-9_.-]/.test(output[word - 1]!)) word--;
  const sticky = new RegExp(MARKER.source, "y");
  // The marker's `<|`, `<`, `>` or `|` sits just before the word it ends with.
  for (const start of [word - 2, word - 1]) {
    if (start < at) continue;
    sticky.lastIndex = start;
    const m = sticky.exec(output);
    if (m && m.index + m[0].length > end && roleOf(m)) return true;
  }
  return false;
}

/** Where `text` takes its place at or after `from` under `role`, with the turn it sits in, as placeOf decides. */
function placement(output: string, text: string, role: Role, from: number, limit: number, carried: Turn, turns: Turns): { at: number; turn: Turn } | undefined {
  if (text === "") return undefined;
  const turnBefore = turnScan(output, from, carried, turns);
  const first = distinctive(text);
  for (let at = output.indexOf(text, from); at >= 0; at = output.indexOf(text, at + 1)) {
    if (!first && at + text.length > limit) return undefined;
    if (endsInMarker(output, at, at + text.length)) continue;
    const turn = turnBefore(at);
    if (turn.role === role) return { at, turn };
    if (first) return undefined;
  }
  return undefined;
}

/**
 * Where `text` takes its place at or after `from` under `role`, or -1: its first place when it is distinctive,
 * otherwise its first place under that role that ends by `limit`. A place that ends in a marker is markup, not a
 * place. `carried` is the turn in effect at `from`, which holds until a marker after it changes it. `turns` defaults
 * to every listed opener, as for a template whose model declares none.
 */
export function placeOf(output: string, text: string, role: Role, from: number, limit = output.length, carried: Turn = {}, turns = turnsIn(output, FALLBACK)): number {
  return placement(output, text, role, from, limit, carried, turns)?.at ?? -1;
}

// Below this many characters a matching prefix, or a copied slice, says nothing: short runs of common words recur anywhere.
const TRUNCATION_MIN = 16;

/** The longest prefix of `text` found at or after `from`. A prefix found implies every shorter one is, so it bisects. */
function longestPrefix(output: string, text: string, from: number): number {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (output.includes(text.slice(0, mid), from)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const label = (c: ProbeContent, i: number) => `${c.role} content ${i} (message ${c.message})`;
const an = (r: Role) => (r === "assistant" ? `an ${r}` : `a ${r}`);
const RANK: Readonly<Record<Role, number>> = { system: 3, user: 2, tool: 1, assistant: 0 };

/** What is wrong with a content of `role` found in turn `t`. */
function misplaced(t: Turn, role: Role): string {
  if (t.turn && t.turn !== "assistant" && RANK[t.turn] > RANK[role]) return `sits in a ${t.turn} turn, more privileged than its own ${role} role`;
  return `sits under ${t.role ? `${an(t.role)} role marker` : "no role marker"}, not ${an(role)} one`;
}

/** Where the output shows one or more inputs, and the turn in effect at its start. */
interface Span {
  start: number;
  end: number;
  turn: Turn;
  inputs: number[];
}

// A window's hash is Σ c[j]·B^(W-1-j) mod 2^32 over its W = TRUNCATION_MIN UTF-16 code units, the units slice
// counts, so the next position's hash takes out the first unit and brings in the next one in a few steps.
const B = 0x01000193;
const TOP = (() => {
  let t = 1;
  for (let j = 1; j < TRUNCATION_MIN; j++) t = Math.imul(t, B);
  return t;
})();

function windowHash(s: string, k: number): number {
  let h = 0;
  for (let j = k; j < k + TRUNCATION_MIN; j++) h = (Math.imul(h, B) + s.charCodeAt(j)) | 0;
  return h;
}

/** The first p in [from, stop) whose window's hash has its bit set in `live`, or `stop` when there is none. */
function nextLive(output: string, from: number, stop: number, live: Int32Array, shift: number): number {
  let p = from;
  for (let h = windowHash(output, p); ; ) {
    const x = h >>> shift;
    if (live[x >>> 5]! & (1 << (x & 31))) return p;
    if (++p >= stop) return stop;
    h = (Math.imul(h - Math.imul(output.charCodeAt(p - 1), TOP), B) + output.charCodeAt(p + TRUNCATION_MIN - 1)) | 0;
  }
}

/** A content's first copy: `length` of its characters at output[at, at + length), found past the first `prior` spans. */
export interface Copy {
  i: number;
  at: number;
  length: number;
  prior: number;
}

/**
 * The first copy of each distinctive content in `spans`, outside `skip`, that appears again outside every span,
 * whole or as a slice of at least TRUNCATION_MIN characters. `texts` are the contents, `held` every input the probe
 * passes. Spans are in output order and do not overlap. `bits` sizes the hash filter below: a test passes a small one,
 * which lets most windows through, to show the filter decides nothing.
 */
export function firstCopies(output: string, texts: readonly string[], held: readonly string[], spans: readonly Pick<Span, "start" | "end" | "inputs">[], skip: ReadonlySet<number>, bits?: number): Copy[] {
  const W = TRUNCATION_MIN;
  // Each distinctive window of a checked content, with the content and where in it the window starts.
  const owner = new Map<string, [number, number]>();
  for (const i of spans.flatMap((s) => s.inputs)) {
    const text = texts[i]!;
    if (skip.has(i) || !distinctive(text)) continue;
    for (let k = 0; k + W <= text.length; k++) {
      const w = text.slice(k, k + W);
      if (!owner.has(w) && distinctive(w)) owner.set(w, [i, k]);
    }
  }
  if (owner.size === 0) return [];
  // A window two of the probe's inputs hold is theirs to repeat.
  const holders = new Map<string, number>();
  for (const s of new Set([...held, ...texts])) {
    const seen = new Set<string>();
    for (let k = 0; k + W <= s.length; k++) {
      const w = s.slice(k, k + W);
      if (owner.has(w) && !seen.has(w)) {
        seen.add(w);
        holders.set(w, (holders.get(w) ?? 0) + 1);
      }
    }
  }
  for (const [w, n] of holders) if (n > 1) owner.delete(w);

  // The output's windows are not sliced one by one: a window is sliced and looked up only when its hash may be a
  // live window's, one whose content is not yet reported. `live` has a bit per hash prefix, set for each live window:
  // 256 to 512 bits a window, so one that is not live seldom passes, and from 2^16 to 2^24 bits in all.
  const hashes = [...owner].map(([w, [i]]) => [windowHash(w, 0), i] as const);
  const size = bits ?? Math.min(24, Math.max(16, 40 - Math.clz32(owner.size)));
  const shift = 32 - size;
  const live = new Int32Array(1 << (size - 5));
  const set = (h: number, on: boolean) => {
    const x = h >>> shift;
    live[x >>> 5] = on ? live[x >>> 5]! | (1 << (x & 31)) : live[x >>> 5]! & ~(1 << (x & 31));
  };
  for (const [h] of hashes) set(h, true);
  // The contents still to report. Once there are none, nothing more can be found.
  let left = new Set(hashes.map(([, i]) => i)).size;

  const found: Copy[] = [];
  const reported = new Set<number>();
  let s = 0; // the first span that ends after p
  for (let p = 0; p + W <= output.length && left > 0; ) {
    while (s < spans.length && spans[s]!.end <= p) s++;
    if (s < spans.length && spans[s]!.start <= p) {
      p = spans[s]!.end;
      continue;
    }
    // Up to the next span, the hash rolls on a character at a time.
    const stop = Math.min(s < spans.length ? spans[s]!.start : output.length, output.length - W + 1);
    p = nextLive(output, p, stop, live, shift);
    if (p === stop) continue;
    const hit = owner.get(output.slice(p, p + W));
    if (!hit || reported.has(hit[0])) {
      p++;
      continue;
    }
    const [i, k] = hit;
    const text = texts[i]!;
    let before = 0;
    while (before < k && output[p - before - 1] === text[k - before - 1]) before++;
    let after = W;
    while (k + after < text.length && output[p + after] === text[k + after]) after++;
    reported.add(i);
    found.push({ i, at: p - before, length: before + after, prior: s });
    p += after;
    // Its windows no longer pass, but a live window whose hash shares a prefix with one of them still does.
    for (const [h, j] of hashes) if (j === i) set(h, false);
    for (const [h, j] of hashes) if (!reported.has(j)) set(h, true);
    left--;
  }
  return found;
}

/** Each content firstCopies finds copied, with what to say about it. */
function copies(probe: Probe, output: string, inputs: readonly ScanInput[], spans: readonly Span[], skip: ReadonlySet<number>, turns: Turns): [number, string][] {
  return firstCopies(output, inputs.map((x) => x.text), probe.inputs, spans, skip).map(({ i, at, length: n, prior }) => {
    const all = inputs[i]!.text.length;
    // The turn the copy sits in, read on from the span before it.
    const prev = spans[prior - 1];
    const t = turnScan(output, prev?.end ?? 0, prev?.turn ?? {}, turns)(at);
    return [i, `is copied: ${n === all ? `all ${n} of its` : `${n} of its ${all}`} characters appear a second time, ${t.turn ? `in a ${t.turn} turn` : "outside any turn"}`];
  });
}

/** The content_integrity issues in one rendered probe's output. Empty when every content arrived intact. */
// `scaffolding` is the template's scaffolding set: the turn-opening tokens its model declares are among it.
export function checkContent(probe: Probe, output: string, transforms: readonly Transform[], scaffolding: ReadonlySet<string> = new Set()): IntegrityIssue[] {
  const allowed = transforms.flatMap((t) => (CONTENT_MATCHERS[t.id] ? [CONTENT_MATCHERS[t.id]!] : []));
  const context = (probe.request.context ?? {}) as Record<string, unknown>;
  const inputs: ScanInput[] = probe.contents.map((c) => ({ role: c.role, message: c.message, field: "content", text: c.text }));
  const turns = turnsIn(output, openersOf(scaffolding));
  const roleAt = (a: number, b: number) => markerRole(output, a, b);
  // What each input may render as: verbatim, then each allowlisted rewrite of it.
  const renderings = (i: number) => [
    inputs[i]!.text,
    ...allowed.flatMap((m) => {
      const text = m.rewrite?.(inputs[i]!, context);
      return text === undefined ? [] : [text];
    }),
  ];
  // A short content's place ends before the next distinctive content that arrives starts, so it never skips past
  // a later turn to template text that happens to sit under its role.
  const limitAfter = (i: number, from: number) => {
    for (let j = i + 1; j < inputs.length; j++) {
      if (!distinctive(inputs[j]!.text)) continue;
      const starts = renderings(j).map((r) => output.indexOf(r, from)).filter((at) => at >= 0);
      if (starts.length > 0) return Math.min(...starts);
    }
    return output.length;
  };

  const issues: IntegrityIssue[] = [];
  const flagged = new Set<number>();
  const flag = (i: number, what: string) => {
    flagged.add(i);
    issues.push({ ruleId: "content_integrity", index: i, message: `${label(probe.contents[i]!, i)} ${what}` });
  };
  let cursor = 0;
  // The turn in effect at the cursor: the one the last content placed sat in.
  let carried: Turn = {};
  // Where the output shows each content, for the copy check.
  const spans: Span[] = [];
  for (let i = 0; i < inputs.length; i++) {
    const { role, text } = inputs[i]!;
    // Whitespace alone has no place to find, and a template that drops or trims it loses nothing.
    if (text.trim() === "") continue;

    const limit = distinctive(text) ? output.length : limitAfter(i, cursor);
    const place = (t: string, r: Role, from: number) => placeOf(output, t, r, from, limit, from === cursor ? carried : {}, turns);
    const found = placement(output, text, role, cursor, limit, carried, turns);
    if (found) {
      spans.push({ start: found.at, end: found.at + text.length, turn: found.turn, inputs: [i] });
      cursor = found.at + text.length;
      carried = found.turn;
      continue;
    }
    const scan: ContentScan = { output, from: cursor, inputs, index: i, context, markerRole: roleAt, place, renderings };
    let explained: ContentMatch | undefined;
    for (const m of allowed) if ((explained = m.match(scan))) break;
    if (explained) {
      // A drop places nothing, so the turn in effect stays; anything placed sits in the turn at its start.
      if (explained.end > explained.start) {
        carried = turnScan(output, cursor, carried, turns)(explained.start);
        spans.push({ start: explained.start, end: explained.end, turn: carried, inputs: Array.from({ length: explained.covers }, (_, j) => i + j) });
      }
      cursor = explained.end;
      i += explained.covers - 1;
      continue;
    }

    // Unexplained: say what happened, as nearly as the output shows it.
    const shown = renderings(i)
      .map((r) => ({ r, at: output.indexOf(r, cursor) }))
      .find((x) => x.at >= 0);
    if (shown) {
      const turn = turnScan(output, cursor, carried, turns)(shown.at);
      flag(i, misplaced(turn, role));
      // Where a short content shows may be the template's own text, so the next content is sought from here.
      if (distinctive(text)) {
        spans.push({ start: shown.at, end: shown.at + shown.r.length, turn, inputs: [i] });
        cursor = shown.at + shown.r.length;
        carried = turn;
      }
    } else if (output.includes(text)) {
      flag(i, "arrives out of order, before content that precedes it in the conversation");
    } else {
      const kept = longestPrefix(output, text, cursor);
      if (kept >= TRUNCATION_MIN) flag(i, `is cut short: only its first ${kept} of ${text.length} characters arrive verbatim`);
      else flag(i, "is missing: it was dropped or rewritten");
    }
  }
  for (const [i, what] of copies(probe, output, inputs, spans, flagged, turns)) flag(i, what);
  return issues;
}
