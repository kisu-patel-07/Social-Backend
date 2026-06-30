/**
 * Minimal, dependency-free CSV generator. Handles escaping of quotes,
 * commas, and newlines per RFC 4180. Sufficient for lead exports.
 */

/** Escape a single CSV cell value. */
function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export interface CsvColumn<T> {
  header: string;
  /** Extract the cell value for a given row. */
  value: (row: T) => unknown;
}

/** Convert an array of objects into a CSV string using the given columns. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const headerLine = columns.map((c) => escapeCell(c.header)).join(',');
  const dataLines = rows.map((row) => columns.map((c) => escapeCell(c.value(row))).join(','));
  return [headerLine, ...dataLines].join('\r\n');
}
