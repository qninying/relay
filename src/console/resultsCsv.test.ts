// STORY-105: the results CSV and spreadsheet formula neutralisation.

import { describe, it, expect } from "vitest";
import { csvCell, neutralise, resultLine, statusLabel } from "./resultsCsv.js";
import { parseCsv } from "./csv.js";

describe("neutralise: formula-leading cells become text", () => {
  it.each(["=1+1", "+1 corp", "-2", "@SUM(A1)", "\tx", "\rx", "＝1+1", "＋1", "－1", "＠SUM(A1)"])("prefixes %j", (cell) => {
    expect(neutralise(cell)).toBe(`'${cell}`);
  });

  it.each(["Acme builds software", "1+1=2", " =1", "0.42", "", "'already text"])("leaves %j alone", (cell) => {
    expect(neutralise(cell)).toBe(cell);
  });
});

describe("csvCell / resultLine", () => {
  it("quotes commas, quotes and newlines, after neutralising", () => {
    expect(csvCell('=HYPERLINK("http://x","click")')).toBe(`"'=HYPERLINK(""http://x"",""click"")"`);
    expect(csvCell("Acme, Inc.")).toBe('"Acme, Inc."');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell(undefined)).toBe("");
    expect(csvCell(0.91)).toBe("0.91");
  });

  it("writes one row per item in header order, and reads back with the upload parser", () => {
    const done = resultLine({ jobId: "b-1", row: 1, text: "=cmd|' /C calc'!A0", ref: "a-1" }, { status: "done", label: "software", confidence: 0.91, taxonomyVersion: "industry.v1", at: "2026-10-22T00:00:00Z" });
    const waiting = resultLine({ jobId: "b-2", row: 2, text: "Riverside Clinic" }, null);
    const failed = resultLine({ jobId: "b-3", row: 3, text: "x" }, { status: "failed", reason: "classifier unavailable", at: "2026-10-22T00:00:00Z" });
    expect(parseCsv(done + waiting + failed)).toEqual([
      ["1", "a-1", "'=cmd|' /C calc'!A0", "done", "software", "0.91", "industry.v1", "", "", "", "", ""],
      ["2", "", "Riverside Clinic", "waiting", "", "", "", "", "", "", "", ""],
      ["3", "", "x", "failed", "", "", "", "classifier unavailable", "", "", "", ""],
    ]);
  });

  it("labels statuses the way the batch page does", () => {
    expect(statusLabel(null)).toBe("waiting");
    expect(statusLabel({ status: "review", at: "" })).toBe("waiting for review");
  });
});
