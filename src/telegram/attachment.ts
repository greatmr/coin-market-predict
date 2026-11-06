/**
 * A Telegram report part that is a file (the batch's Excel workbook) instead of a text message.
 * It is stored in TelegramDelivery.text like any other part, so it inherits ordering (sent only
 * after the text parts), per-recipient retries, duplicate suppression and manual resends.
 */
export const DOCUMENT_MARKER = "[[telegram-document]]";
/** Bot API upload limit for sendDocument. */
export const TELEGRAM_DOCUMENT_LIMIT_BYTES = 50 * 1024 * 1024;
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface DocumentPart {
  /** Absolute path of the file on this machine (an export under TIER1_EXPORT_DIR). */
  path: string;
  /** File name the recipient sees. */
  filename: string;
  /** HTML caption (≤ 1024 characters). */
  caption: string;
  mimeType: string;
}

export function documentPart(d: DocumentPart): string {
  return `${DOCUMENT_MARKER}${JSON.stringify(d)}`;
}

export function parseDocumentPart(text: string): DocumentPart | null {
  if (!text.startsWith(DOCUMENT_MARKER)) return null;
  try {
    const d = JSON.parse(text.slice(DOCUMENT_MARKER.length)) as Partial<DocumentPart>;
    if (typeof d.path !== "string" || typeof d.filename !== "string") return null;
    return { path: d.path, filename: d.filename, caption: typeof d.caption === "string" ? d.caption.slice(0, 1024) : "", mimeType: typeof d.mimeType === "string" ? d.mimeType : "application/octet-stream" };
  } catch {
    return null;
  }
}
