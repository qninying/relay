// STORY-104: CSV parsing and validation for batch upload.

import { describe, it, expect } from "vitest";
import { checkCsv, parseCsv, MAX_ROWS } from "./csv.js";

describe("parseCsv (RFC 4180)", () => {
  it("handles quoted fields with commas, newlines and escaped quotes", () => {
    expect(parseCsv('text,id\n"Acme, Inc.",1\n"Line one\nline two",2\n"She said ""hi""",3\n')).toEqual([
      ["text", "id"],
      ["Acme, Inc.", "1"],
      ["Line one\nline two", "2"],
      ['She said "hi"', "3"],
    ]);
  });

  it("handles CRLF, a UTF-8 byte-order mark, a missing final newline and blank lines", () => {
    expect(parseCsv("﻿text,id\r\nA,1\r\n\r\nB,2")).toEqual([
      ["text", "id"],
      ["A", "1"],
      ["B", "2"],
    ]);
  });
});

describe("checkCsv: whole-file checks", () => {
  it.each([
    ["", "The file is empty."],
    ["name,id\nA,1", 'column named "text"'],
    ["text,id\n", "has a header but no rows"],
    ["text\nCaf�", "isn't saved as UTF-8"],
  ])("refuses %j", (content, message) => {
    const r = checkCsv(content);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  it("refuses more than the row limit and more than 2 MB", () => {
    const tooMany = checkCsv(`text\n${"x\n".repeat(MAX_ROWS + 1)}`);
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.error).toContain("5,001 rows; the limit is 5,000");
    const tooBig = checkCsv(`text\n${"y".repeat(1000)}\n`.repeat(2200));
    expect(tooBig.ok).toBe(false);
    if (!tooBig.ok) expect(tooBig.error).toContain("larger than 2 MB");
  });

  it("accepts exactly the row limit", () => {
    const r = checkCsv(`text\n${"x\n".repeat(MAX_ROWS)}`);
    expect(r.ok && r.rows.length).toBe(MAX_ROWS);
  });
});

describe("checkCsv: row checks", () => {
  it("keeps good rows, lists bad ones by row number, and keeps the optional id", () => {
    const r = checkCsv(`TEXT,Id\nAcme builds software,a-1\n   ,a-2\n${"z".repeat(2001)},a-3\nOnly one column\nRiverside Clinic,\n`);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.totalRows).toBe(5);
    expect(r.rows).toEqual([
      { row: 1, text: "Acme builds software", ref: "a-1" },
      { row: 5, text: "Riverside Clinic" },
    ]);
    expect(r.errors).toEqual([
      { row: 2, reason: "the text is empty" },
      { row: 3, reason: "the text is 2,001 characters; the limit is 2,000" },
      { row: 4, reason: "has 1 column, the header has 2" },
    ]);
  });

  it("accepts spreadsheet-formula-looking text as data (it's neutralised on export, never executed)", () => {
    const r = checkCsv('text\n"=HYPERLINK(""http://x"")"\n+1 corp\n');
    expect(r.ok && r.rows.map((x) => x.text)).toEqual(['=HYPERLINK("http://x")', "+1 corp"]);
  });
});
