// What a rendered probe shows of the template itself (ISC-22). A probe's template text is its output with every
// string the probe passed in removed. What is left falls into runs: a run ends where an input was removed and at
// role markup, so no run spans text the probe supplied or a turn boundary. A run's units are its words (maximal
// runs of letters) and each pair of adjacent words. A unit a `vary` probe prints that no `explain` probe prints is
// text the template's ordinary output does not explain: a new word, or known words in a new order (Decisions
// 02:58, security M3).

// Left where an input was removed, so the text on either side never joins into a word of its own.
const GAP = "\u0000";

const LETTER = /\p{L}/u;
const SPACE = /\s/;

function isLetter(ch: string | undefined): boolean {
  return ch !== undefined && LETTER.test(ch);
}

/** The code point that ends just before `i`, or undefined at the start. */
function before(s: string, i: number): string | undefined {
  if (i <= 0) return undefined;
  const low = s.charCodeAt(i - 1);
  return low >= 0xdc00 && low <= 0xdfff && i >= 2 ? s.slice(i - 2, i) : s[i - 1];
}

/** The code point that starts at `i`, or undefined at the end. */
function at(s: string, i: number): string | undefined {
  const cp = s.codePointAt(i);
  return cp === undefined ? undefined : String.fromCodePoint(cp);
}

// A one-word input (a role, a tool name, a short trigger value) is removed only where it stands as a whole word:
// cutting `on` out of `conversation` would leave fragments no explain probe prints. A multi-word input is a
// distinctive sentence, so it is removed wherever it appears.
function removeOne(text: string, input: string): string {
  if (SPACE.test(input)) return text.split(input).join(GAP);
  const first = at(input, 0);
  const last = before(input, input.length);
  const startsWord = isLetter(first);
  const endsWord = isLetter(last);
  let out = "";
  let from = 0;
  for (let i = text.indexOf(input); i !== -1; i = text.indexOf(input, i + 1)) {
    if (i < from) continue; // overlaps a removal already made
    if (startsWord && isLetter(before(text, i))) continue;
    if (endsWord && isLetter(at(text, i + input.length))) continue;
    out += text.slice(from, i) + GAP;
    from = i + input.length;
  }
  return out + text.slice(from);
}

/** The output with every input removed, the longest first, so a short input never splits a longer one. */
export function templateText(output: string, inputs: readonly string[]): string {
  const sorted = [...new Set(inputs)].filter((s) => s.length > 0).sort((a, b) => b.length - a.length);
  let text = output;
  for (const input of sorted) text = removeOne(text, input);
  return text;
}

/** The maximal runs of letters, in order of first appearance, without repeats. */
export function words(text: string): string[] {
  return [...new Set(text.match(/\p{L}+/gu) ?? [])];
}

const DATE_NAMES = new Set(
  [
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
    "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  ].flatMap((name) => [name, name.slice(0, 3)]),
);

/** English month and weekday names, full and three-letter, in any case: what a date probe may print because of the date alone. */
export function isDateWord(word: string): boolean {
  return DATE_NAMES.has(word.toLowerCase());
}

// What a month or weekday name becomes on a date probe. It holds no letter, so it never equals a word.
export const DATE_MASK = "#date";

// Role markup: a role word right after `<`, `<|`, `>` or `|`, as a whole word, as content integrity reads a role
// marker (integrity.ts), so `<|assistant|>` and `<|im_start|>assistant` count and a role in prose does not. Most
// role words a probe sends are inputs and already gaps; this breaks the run where the template prints one itself,
// so a turn a vary probe orders differently (`</tool_response><|assistant|>`) never pairs words across it. Other
// tags stay in the run, so text split by `<b>` still pairs with it.
const ROLE_MARKER = /(?:<\|?|>|\|)(?:system|developer|user|human|assistant|model|tool|tool_response|observation|ipython|start_function_response)(?![A-Za-z0-9_])/g;

/** The runs of template text, each its words in order: split where an input was removed and at role markup, which is a run of its own. */
export function runs(text: string, dateProbe = false): string[][] {
  const out: string[][] = [];
  for (const run of text.replace(ROLE_MARKER, (m) => GAP + m + GAP).split(GAP)) {
    const ws = run.match(/\p{L}+/gu);
    if (ws) out.push(dateProbe ? ws.map((w) => (isDateWord(w) ? DATE_MASK : w)) : ws);
  }
  return out;
}

/** Every unit of `text`: each word, and each pair of adjacent words in a run, written with a space between. */
export function units(text: string, dateProbe = false): Set<string> {
  const out = new Set<string>();
  for (const run of runs(text, dateProbe)) {
    for (let i = 0; i < run.length; i++) {
      out.add(run[i]!);
      if (i > 0) out.add(`${run[i - 1]} ${run[i]}`);
    }
  }
  return out;
}

/**
 * Adds every unit of an explain probe's template text to `explained`, as printed and with month and weekday names
 * masked: what units(text, false) and units(text, true) hold together, from one pass over the runs. A unit with no
 * date word in it is the same either way, so it is added once.
 */
export function addExplained(explained: Set<string>, text: string): void {
  for (const run of runs(text)) {
    let prev = "";
    let prevMasked = "";
    for (let i = 0; i < run.length; i++) {
      const word = run[i]!;
      const masked = isDateWord(word) ? DATE_MASK : word;
      explained.add(word);
      if (masked !== word) explained.add(masked);
      if (i > 0) {
        explained.add(`${prev} ${word}`);
        if (masked !== word || prevMasked !== prev) explained.add(`${prevMasked} ${masked}`);
      }
      prev = word;
      prevMasked = masked;
    }
  }
}

/**
 * The units of a vary probe's template text that `explained` does not hold, in order. A pair is listed only when
 * both its words are explained, since a new word already says what the pair would. On a date probe, month and
 * weekday names are masked first, so `explained` must hold the masked units of the explain probes too.
 */
export function unexplained(text: string, explained: ReadonlySet<string>, dateProbe: boolean): string[] {
  const out: string[] = [];
  for (const u of units(text, dateProbe)) {
    if (explained.has(u)) continue;
    const pair = u.split(" ");
    if (pair.length === 2 && !(explained.has(pair[0]!) && explained.has(pair[1]!))) continue;
    out.push(u);
  }
  return out;
}
