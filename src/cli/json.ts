// --json: the ScanReport as it is, which schema/report.schema.json describes (ISC-27).

import type { ScanReport } from "../types.ts";
import { escapeJson } from "./escape.ts";

// A 64-bit integer that slipped past the readers prints as a decimal string, the seam's own
// convention for ggufGeneral, rather than making JSON.stringify throw and the report vanish.
const bigints = (_key: string, value: unknown) => (typeof value === "bigint" ? value.toString() : value);

/** The report as JSON text with a trailing newline, every terminal-hostile character escaped (ISC-44). */
export function renderJson(report: ScanReport): string {
  return `${escapeJson(JSON.stringify(report, bigints, 2))}\n`;
}
