// Injected-text extraction (ISC-17): every literal a template can emit that is
// not scaffolding, with its span, the strongest test it sits under, and whether
// it lands after the generation-prompt marker.

import type { InjectedText } from "../types.ts";
import type { ParseOutcome } from "../parse/parse.ts";

export interface Extraction {
  items: InjectedText[];
  /** False when a budget stopped the walk before every emission was seen. */
  complete: boolean;
}

export function extract(_outcome: ParseOutcome, _text: string, _scaffolding: ReadonlySet<string>): Extraction {
  return { items: [], complete: true };
}
