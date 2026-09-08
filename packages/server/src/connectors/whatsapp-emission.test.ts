import { describe, expect, it } from "vitest";
import { type WhatsAppRosterSnapshot, stableWhatsAppParticipantJidRef } from "../whatsapp/identity-resolution";
import { assertNoRawWhatsAppIdentifiers, renderWhatsAppTranscript } from "./whatsapp-emission";

function rosterSnapshot(): WhatsAppRosterSnapshot {
  const teammateJid = "15550000001@s.whatsapp.net";
  const externalJid = "15550000002@s.whatsapp.net";
  return {
    participants: [
      {
        participantJidRef: stableWhatsAppParticipantJidRef(teammateJid),
        senderJidRefs: [stableWhatsAppParticipantJidRef(teammateJid)],
        displayName: "Tara Teammate",
        resolutionKind: "teammate",
        adminRole: null,
        userId: "user-tara",
      },
      {
        participantJidRef: stableWhatsAppParticipantJidRef(externalJid),
        senderJidRefs: [stableWhatsAppParticipantJidRef(externalJid)],
        displayName: "External (**02)",
        resolutionKind: "unresolved",
        adminRole: null,
      },
    ],
    resolutionCounts: { totalParticipants: 2, teammate: 1, entity: 0, labeled: 0, unresolved: 1 },
  };
}

describe("renderWhatsAppTranscript", () => {
  it("attributes transcript lines through roster refs and strips raw identifiers", () => {
    const transcript = renderWhatsAppTranscript(rosterSnapshot(), [
      {
        id: 1,
        senderJid: "15550000001@s.whatsapp.net",
        senderName: "raw teammate",
        text: "We decided Project Atlas starts Monday.",
      },
      {
        id: 2,
        senderJid: "15550000002@s.whatsapp.net",
        senderName: "External +15550000002",
        text: "Please do not use 15550000002@s.whatsapp.net in the deck.",
      },
    ]);

    expect(transcript).toContain("Tara Teammate: We decided Project Atlas starts Monday.");
    expect(transcript).toContain("External (**02): Please do not use [whatsapp-id] in the deck.");
    expect(transcript).not.toMatch(/\+?1555000000[12]/u);
    expect(transcript).not.toMatch(/@s\.whatsapp\.net|@lid/u);
    assertNoRawWhatsAppIdentifiers(transcript);
  });
});
