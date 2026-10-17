/** A bounded view, not a saved-report limit. Offsets address UTF-8 bytes at code-point boundaries. */
export type TextPage = { text: string; offset: number; totalBytes: number; nextOffset?: number };
export function textPage(text: string, offset = 0, maxBytes = 24000, maxLines = 800): TextPage {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid report byte offset.");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4 || maxBytes > 32000) throw new Error("Expected maxBytes between 4 and 32000.");
  const bytes = Buffer.from(text);
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) throw new Error("Report offset must be a UTF-8 code-point boundary within the report.");
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--;
  let lines = 0;
  for (let index = offset; index < end; index++) if (bytes[index] === 10 && ++lines === maxLines) { end = index + 1; break; }
  return { text: bytes.subarray(offset, end).toString("utf8"), offset, totalBytes: bytes.length,
    ...(end < bytes.length ? { nextOffset: end } : {}) };
}
