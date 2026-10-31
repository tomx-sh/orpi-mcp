import { NeotimmError } from "./neotimm";
import type { Row } from "./consultation";

// Semicolon CSV for French spreadsheets. Preserve accents, zeroes and typed numbers.
export function toCsv(records: Row[], columns = [...new Set(records.flatMap((row) => Object.keys(row)))]) {
  const cell = (value: unknown) => {
    if (value === null || value === undefined) return '""';
    let text = typeof value === "object" ? JSON.stringify(value) : String(value);
    // Neutralize formulas in textual data; negative numeric amounts stay numeric.
    if (typeof value === "string" && /^[\s\uFEFF]*[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const text = "\uFEFF" + [columns.map(cell).join(";"), ...records.map((row) => columns.map((key) => cell(row[key])).join(";"))].join("\r\n") + "\r\n";
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) throw new NeotimmError("CSV exceeds 1 MiB. Reduce limit and paginate with offset, or export a shorter ledger date range.");
  return { text, rowCount: records.length, columns };
}
