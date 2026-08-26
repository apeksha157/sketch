import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../test-utils";
import { resolveMentionDisplayNames, resolveWhatsAppMentionTokens } from "./mention-resolution";

describe("WhatsApp mention resolution", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    db = await createTestDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it("falls back to phone display for unmapped mentions and leaves fully unknown tokens untouched", async () => {
    const mentions = [
      { jid: "971509374319@s.whatsapp.net", lid: null, phoneE164: "+971509374319" },
      { jid: "254052281622575@lid", lid: "254052281622575@lid", phoneE164: null },
    ];
    const displayByJid = await resolveMentionDisplayNames(db, "group@g.us", mentions);

    expect(resolveWhatsAppMentionTokens("ask @971509374319 and @254052281622575", mentions, displayByJid)).toBe(
      "ask @+971509374319 and @254052281622575",
    );
  });

  it("uses longest observed mention token first when digit prefixes collide", () => {
    const mentions = [
      { jid: "123@lid", lid: "123@lid", phoneE164: null },
      { jid: "1234@lid", lid: "1234@lid", phoneE164: null },
    ];
    const displayByJid = new Map([
      ["123@lid", "Short"],
      ["1234@lid", "Long"],
    ]);

    expect(resolveWhatsAppMentionTokens("ask @1234 then @123", mentions, displayByJid)).toBe("ask @Long then @Short");
  });
});
