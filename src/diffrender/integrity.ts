// Content integrity (ISC-22.3): every system, user and tool content a probe passes reaches the output verbatim,
// in order, under its own role, unless a transform on the allowlist explains the difference.
//
// Contents are placed left to right. Each must appear at or after the end of the one before it, under its own role:
// the role of the last role marker between the two, read only from the output between them and never from a
// content itself. With no marker between them the role in effect is still the one the content before it sat
// under, as when two text parts of one message print side by side. A distinctive content (several words, long enough not to recur by chance) counts
// at the first place it appears, so a template that echoes user text into the system prompt ahead of the user turn
// fails here rather than passing on the copy that follows. A short or one-word content may equal the template's
// own text (a trigger probe passes a template literal such as `<|im_start|>` or `system`), so it takes the first
// place it appears under its own role.

import type { Transform } from "../registry/index.ts";
import type { IntegrityIssue, Probe, ProbeContent } from "../types.ts";
import { CONTENT_MATCHERS, type ContentMatch, type ContentScan, type Role, type ScanInput } from "./transforms.ts";

// The role each marker word names. A role passes as itself; the aliases are the words the pinned templates print
// in its place, each with the lines that print it.
const ROLE_WORDS: ReadonlyMap<string, Role> = new Map(Object.entries({
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
  // Qwen2.5 line 44, Qwen3 line 72, GLM-4.5 line 86; gemma-4 (36e3a42e) line 161 prints <|tool_response>.
  tool_response: "tool",
  // GLM-4.5 line 84.
  observation: "tool",
  // The Llama 3.x tool role, named in the phase brief. No pinned template prints it.
  ipython: "tool",
  // functiongemma line 202.
  start_function_response: "tool",
}) as [string, Role][]);

// A marker is a role word right after `<`, `>` or `|`, as a whole word: so `<|im_start|>user` and `<|observation|>`
// count, but a role in prose, a closing tag (`</tool_response>`, or gemma-4's `<tool_response|>`) or a JSON value
// (`"user"`) does not. gpt-oss line 321 marks a tool result with the tool's own name, `<|start|>functions.<name>`.
const MARKER = /(<\|?|>|\|)(functions\.[A-Za-z0-9_.-]+|[A-Za-z][A-Za-z0-9_]*)(?=(\|>)?)/g;

/** The role a marker match names, or undefined for another word or a closer. */
function roleOf(m: RegExpMatchArray): Role | undefined {
  if (m[1] === "<" && m[3]) return undefined; // <name|> closes a gemma-4 block
  return m[2]!.startsWith("functions.") ? "tool" : ROLE_WORDS.get(m[2]!);
}

/**
 * markerRole(output, a, b) for each b in turn, b never decreasing, reading the output from `a` once: a content
 * that recurs a thousand times costs one pass, not a thousand. `initial` is the role in effect at `a`.
 */
function markerScan(output: string, a: number, initial?: Role): (b: number) => Role | undefined {
  const re = new RegExp(MARKER.source, "g");
  re.lastIndex = a;
  let role = initial;
  let next = re.exec(output);
  return (b) => {
    // A match is settled once b is past it and the two characters its closer test looks at.
    while (next && next.index + next[0].length + 2 <= b) {
      role = roleOf(next) ?? role;
      next = re.exec(output);
    }
    if (!next || next.index >= b) return role;
    // b cuts the next match or its closer test: read it as a scan of output[a, b) would.
    let cut = role;
    for (const m of output.slice(next.index, b).matchAll(MARKER)) cut = roleOf(m) ?? cut;
    return cut;
  };
}

/** The role the last role marker in output[a, b) names, or undefined when there is none. */
export function markerRole(output: string, a: number, b: number): Role | undefined {
  return markerScan(output, a)(b);
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

/**
 * Where `text` takes its place at or after `from` under `role`, or -1: its first place when it is distinctive,
 * otherwise its first place under that role that ends by `limit`. A place that ends in a marker is markup, not a
 * place. `carried` is the role in effect at `from`, which holds until a marker after it names another.
 */
export function placeOf(output: string, text: string, role: Role, from: number, limit = output.length, carried?: Role): number {
  if (text === "") return -1;
  const roleBefore = markerScan(output, from, carried);
  const first = distinctive(text);
  for (let at = output.indexOf(text, from); at >= 0; at = output.indexOf(text, at + 1)) {
    if (!first && at + text.length > limit) return -1;
    if (endsInMarker(output, at, at + text.length)) continue;
    if (roleBefore(at) === role) return at;
    if (first) return -1;
  }
  return -1;
}

// Below this many characters a matching prefix says nothing: short runs of common words recur anywhere.
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

/** The content_integrity issues in one rendered probe's output. Empty when every content arrived intact. */
// `scaffolding` is the template's scaffolding set: the turn-opening tokens its model declares are among it.
export function checkContent(probe: Probe, output: string, transforms: readonly Transform[], _scaffolding: ReadonlySet<string> = new Set()): IntegrityIssue[] {
  const allowed = transforms.flatMap((t) => (CONTENT_MATCHERS[t.id] ? [CONTENT_MATCHERS[t.id]!] : []));
  const context = (probe.request.context ?? {}) as Record<string, unknown>;
  const inputs: ScanInput[] = probe.contents.map((c) => ({ role: c.role, message: c.message, field: "content", text: c.text }));
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
  const flag = (i: number, what: string) => issues.push({ ruleId: "content_integrity", index: i, message: `${label(probe.contents[i]!, i)} ${what}` });
  let cursor = 0;
  // The role in effect at the cursor: the role the last content placed sat under.
  let carried: Role | undefined;
  for (let i = 0; i < inputs.length; i++) {
    const { role, text } = inputs[i]!;
    // Whitespace alone has no place to find, and a template that drops or trims it loses nothing.
    if (text.trim() === "") continue;

    const limit = distinctive(text) ? output.length : limitAfter(i, cursor);
    const place = (t: string, r: Role, from: number) => placeOf(output, t, r, from, limit, from === cursor ? carried : undefined);
    const at = place(text, role, cursor);
    if (at >= 0) {
      cursor = at + text.length;
      carried = role;
      continue;
    }
    const scan: ContentScan = { output, from: cursor, inputs, index: i, context, markerRole: roleAt, place, renderings };
    let explained: ContentMatch | undefined;
    for (const m of allowed) if ((explained = m.match(scan))) break;
    if (explained) {
      // A drop places nothing, so the role in effect stays; anything placed sat under its last input's role.
      if (explained.end > explained.start) carried = inputs[i + explained.covers - 1]!.role;
      cursor = explained.end;
      i += explained.covers - 1;
      continue;
    }

    // Unexplained: say what happened, as nearly as the output shows it.
    const shown = renderings(i)
      .map((r) => ({ r, at: output.indexOf(r, cursor) }))
      .find((x) => x.at >= 0);
    if (shown) {
      const under = roleAt(cursor, shown.at) ?? carried;
      flag(i, `sits under ${under ? `a ${under} role marker` : "no role marker"}, not a ${role} one`);
      // Where a short content shows may be the template's own text, so the next content is sought from here.
      if (distinctive(text)) {
        cursor = shown.at + shown.r.length;
        carried = under;
      }
    } else if (output.includes(text)) {
      flag(i, "arrives out of order, before content that precedes it in the conversation");
    } else {
      const kept = longestPrefix(output, text, cursor);
      if (kept >= TRUNCATION_MIN) flag(i, `is cut short: only its first ${kept} of ${text.length} characters arrive verbatim`);
      else flag(i, "is missing: it was dropped or rewritten");
    }
  }
  return issues;
}
