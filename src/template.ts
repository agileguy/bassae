import { createHash } from "node:crypto";
import type { ExtractedTemplate, TemplateSource } from "./types.ts";

const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const lenient = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true });

/** Builds an ExtractedTemplate from the exact stored bytes. Every reader goes through here. */
export function makeTemplate(source: TemplateSource, bytes: Uint8Array): ExtractedTemplate {
  let validUtf8 = true;
  try {
    strict.decode(bytes);
  } catch {
    validUtf8 = false;
  }
  return {
    source,
    bytes,
    text: lenient.decode(bytes),
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validUtf8,
  };
}

/** For templates that arrive as JSON strings: the UTF-8 encoding of the decoded value. */
export function makeTemplateFromString(source: TemplateSource, value: string): ExtractedTemplate {
  const template = makeTemplate(source, new TextEncoder().encode(value));
  // A lone surrogate (a JSON "\ud800" escape) has no UTF-8 encoding; the encoder writes U+FFFD in its place.
  return value.isWellFormed() ? template : { ...template, validUtf8: false };
}
