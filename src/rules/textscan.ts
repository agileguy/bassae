// Text rules that need no AST: URLs, emails and domains in injected text
// (ISC-19), encoded blobs (ISC-20) and invisible or deceptive characters
// (ISC-21), plus their raw-text forms for a template the library could not
// parse (ISC-12). Every scan is linear in the text and bounded in findings.
// Phase 2 seam: signatures are fixed; bodies belong to the text-scan engineer.
// Until they land each returns no findings, so the injection rules can call them.

import type { Finding, FindingBase, InjectedText } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";

/** HIGH url_in_text for each URL, email address or known-TLD domain in injected text, spanned at the literal it sits in (ISC-19). */
export function findUrls(items: readonly InjectedText[], base: FindingBase): Finding[] {
  return [];
}

/** MEDIUM encoded_blob for each base64-like or hex-like run of 32+ characters in a template literal: text between tags and string literals inside them (ISC-20). */
export function findEncodedBlobs(outcome: ParseOutcome, text: string, base: FindingBase): Finding[] {
  return [];
}

/** HIGH invisible_char for each run of invisible or deceptive characters anywhere in the template, tags and comments included (ISC-21). Works with or without a line map, so it covers over-cap templates too. */
export function findInvisibleChars(text: string, base: FindingBase, outcome?: ParseOutcome): Finding[] {
  return [];
}

/** The raw-text form of ISC-19 for a template with no AST (ISC-12): URLs, emails and domains in text between tags and in string literals, streamed when the template is over the size cap. */
export function findUrlsRaw(outcome: ParseOutcome, text: string, base: FindingBase): Finding[] {
  return [];
}
