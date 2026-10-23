// What a rendered probe shows of the template itself (ISC-22). A probe's template text is its output with every
// string the probe passed in removed; its words are the maximal runs of letters left. A word a `vary` probe prints
// that no `explain` probe prints is text the template's ordinary output does not explain.

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

/** The words of a vary probe's template text that `explained` does not hold, in order. On a date probe, month and weekday names are explained. */
export function unexplainedWords(text: string, explained: ReadonlySet<string>, dateProbe: boolean): string[] {
  return words(text).filter((w) => !explained.has(w) && !(dateProbe && isDateWord(w)));
}
