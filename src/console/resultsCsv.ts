// STORY-105 (REQ-107): the results CSV, one row per batch item: the input,
// its outcome, and where it came from.
//
// Spreadsheet formula injection: an input like =HYPERLINK(...) or
// @SUM(...) would run as a formula when the file is opened in Excel or
// Sheets. Every cell that starts with a formula character (= + - @, tab,
// carriage return, or their full-width forms) is prefixed with an
// apostrophe, which spreadsheets show as plain text. Inputs are accepted as
// data on upload (csv.ts); this is where they're made safe.

import type { ItemOutcome } from "../batchResults.js";
import type { BatchInput } from "./batches.js";

export const RESULTS_HEADER = ["row", "id", "input", "status", "label", "confidence", "taxonomy_version", "reason"];

const FORMULA_START = /^[=+\-@\t\r＝＋－＠]/;

export function neutralise(cell: string): string {
  return FORMULA_START.test(cell) ? `'${cell}` : cell;
}

export function csvCell(value: string | number | undefined): string {
  if (value === undefined) return "";
  const text = neutralise(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvLine(cells: Array<string | number | undefined>): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}

// What an analyst sees for an item, on the page and in the export.
export function statusLabel(outcome: ItemOutcome | null): string {
  if (!outcome) return "waiting";
  return outcome.status === "review" ? "waiting for review" : outcome.status;
}

export function resultLine(input: BatchInput, outcome: ItemOutcome | null): string {
  return csvLine([input.row, input.ref, input.text, statusLabel(outcome), outcome?.label, outcome?.confidence, outcome?.taxonomyVersion, outcome?.reason]);
}
