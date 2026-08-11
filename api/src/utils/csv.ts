/**
 * Minimal RFC 4180 escaping — quote a field only when it contains a comma, quote, or newline,
 * doubling any embedded quotes. Good enough for the fixed, known-shape rows this app exports;
 * a general-purpose CSV writer would handle more (BOM, alternate delimiters) that nothing here
 * needs.
 */
function escapeCsvField(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** CRLF line endings — the RFC 4180 default, and what Excel expects without a BOM dance. */
export function toCsv(headers: string[], rows: string[][]): string {
  return [headers, ...rows].map((row) => row.map(escapeCsvField).join(',')).join('\r\n') + '\r\n';
}
