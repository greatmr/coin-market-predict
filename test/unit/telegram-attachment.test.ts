import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { documentPart, parseDocumentPart, XLSX_MIME } from "../../src/telegram/attachment.js";
import { TelegramService } from "../../src/telegram/telegram.service.js";

const BOT = "123456789:AAAbbbCCCdddEEEfffGGGhhhIII";
const dir = mkdtempSync(join(tmpdir(), "tg-attach-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function service(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }) as unknown as typeof fetch;
  const tg = new TelegramService(null as never, { TELEGRAM_BOT_TOKEN: BOT, TELEGRAM_CHAT_ID: "42", TELEGRAM_MODE: "live" } as never, fetchImpl, null as never);
  tg.sleep = async () => undefined;
  return { tg, calls };
}

describe("Telegram report attachment (the batch's Excel workbook)", () => {
  it("round-trips a document part and rejects anything else", () => {
    const part = documentPart({ path: "/x/workbook.xlsx", filename: "coins-tier1.xlsx", caption: "c", mimeType: XLSX_MIME });
    expect(parseDocumentPart(part)).toEqual({ path: "/x/workbook.xlsx", filename: "coins-tier1.xlsx", caption: "c", mimeType: XLSX_MIME });
    expect(parseDocumentPart("<b>plain message</b>")).toBeNull();
    expect(parseDocumentPart("[[telegram-document]]{not json")).toBeNull();
  });

  it("uploads the file with sendDocument: multipart body, file name, caption in HTML mode", async () => {
    const path = join(dir, "workbook.xlsx");
    writeFileSync(path, Buffer.from("PK\u0003\u0004 fake workbook bytes"));
    const { tg, calls } = service(() => new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 }));
    const r = await tg.reply("42", documentPart({ path, filename: "coins-tier1_2026-11-05T13-00Z.xlsx", caption: "📎 <b>Tier 1 export</b>", mimeType: XLSX_MIME }));
    expect(r).toEqual({ ok: true, messageId: "7" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toMatch(/\/sendDocument$/);
    const form = calls[0]!.init.body as FormData;
    expect([form.get("chat_id"), form.get("caption"), form.get("parse_mode")]).toEqual(["42", "📎 <b>Tier 1 export</b>", "HTML"]);
    const file = form.get("document") as File;
    expect([file.name, file.type, await file.text()]).toEqual(["coins-tier1_2026-11-05T13-00Z.xlsx", XLSX_MIME, "PK\u0003\u0004 fake workbook bytes"]);
  });

  it("a pruned export is a permanent failure without calling Telegram; text parts still use sendMessage", async () => {
    const { tg, calls } = service(() => new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }));
    const missing = await tg.reply("42", documentPart({ path: join(dir, "gone.xlsx"), filename: "x.xlsx", caption: "", mimeType: XLSX_MIME }));
    expect(missing).toMatchObject({ ok: false, permanent: true });
    expect(calls).toHaveLength(0);
    await tg.reply("42", "<b>summary</b>");
    expect(calls[0]!.url).toMatch(/\/sendMessage$/);
  });
});
