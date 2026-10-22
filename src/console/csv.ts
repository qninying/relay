// STORY-104 (REQ-106): CSV parsing and validation for batch upload, without
// a new dependency. RFC 4180: comma-separated, fields may be quoted, "" is
// a literal quote inside a quoted field, CRLF or LF line ends, and a UTF-8
// byte-order mark is ignored.
//
// Validation happens before anything is queued: the file as a whole (size,
// encoding, header, row count) and then each row (empty text, too long).
// Cells that start with = + - @ are accepted as input data; they are only
// dangerous when a results CSV is opened in a spreadsheet, which STORY-105's
// export neutralises.

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 5000;
export const MAX_TEXT_CHARS = 2000;
export const MAX_REF_CHARS = 100;

export interface CsvRow {
  row: number; // 1-based data row number, as an analyst would count it
  text: string;
  ref?: string;
}

export interface RowError {
  row: number;
  reason: string;
}

export type CsvCheck =
  | { ok: true; rows: CsvRow[]; errors: RowError[]; totalRows: number }
  | { ok: false; error: string };

export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
    } else if (c === ",") {
      record.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (c === "\r" && text[i + 1] === "\n") i += 1;
    } else {
      field += c;
    }
    i += 1;
  }
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

export function checkCsv(content: string): CsvCheck {
  if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) return { ok: false, error: "The file is larger than 2 MB. Split it into smaller batches." };
  // The browser decodes the file as UTF-8; bytes that aren't valid UTF-8
  // (e.g. a Windows-1252 export from Excel) become U+FFFD. Refuse those
  // rather than queue mangled text.
  if (content.includes("\uFFFD")) return { ok: false, error: "The file isn't saved as UTF-8. In Excel use Save As > CSV UTF-8, then upload again." };
  const records = parseCsv(content);
  if (records.length === 0) return { ok: false, error: "The file is empty." };

  const header = records[0].map((h) => h.trim().toLowerCase());
  const textCol = header.indexOf("text");
  if (textCol === -1) return { ok: false, error: 'The first row must be a header with a column named "text" (optionally also "id").' };
  const refCol = header.indexOf("id");

  const data = records.slice(1);
  if (data.length === 0) return { ok: false, error: "The file has a header but no rows." };
  if (data.length > MAX_ROWS) return { ok: false, error: `The file has ${data.length.toLocaleString("en-US")} rows; the limit is ${MAX_ROWS.toLocaleString("en-US")}. Split it into smaller batches.` };

  const rows: CsvRow[] = [];
  const errors: RowError[] = [];
  data.forEach((record, index) => {
    const row = index + 1;
    if (record.length !== header.length) {
      errors.push({ row, reason: `has ${record.length} column${record.length === 1 ? "" : "s"}, the header has ${header.length}` });
      return;
    }
    const text = record[textCol].trim();
    const ref = refCol === -1 ? undefined : record[refCol].trim() || undefined;
    if (!text) errors.push({ row, reason: "the text is empty" });
    else if (text.length > MAX_TEXT_CHARS) errors.push({ row, reason: `the text is ${text.length.toLocaleString("en-US")} characters; the limit is ${MAX_TEXT_CHARS.toLocaleString("en-US")}` });
    else if (ref && ref.length > MAX_REF_CHARS) errors.push({ row, reason: `the id is longer than ${MAX_REF_CHARS} characters` });
    else rows.push({ row, text, ...(ref ? { ref } : {}) });
  });
  return { ok: true, rows, errors, totalRows: data.length };
}
