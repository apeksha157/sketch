import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encrypt } from "../auth/encryption";
import { parseWebhookVerification, verifyWebhookRequest, webhookEventIdentity } from "./webhook-verification";

const ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET = "clickup-signing-secret";
const VERIFICATION = {
  type: "hmac_sha256" as const,
  signatureHeader: "x-signature",
  resourceIdField: "webhook_id",
  dedupe: { eventField: "event", itemsField: "history_items", itemIdField: "id" },
};
const BINDING = JSON.stringify({
  integration: "clickup",
  accountId: "account-1",
  collectionPath: "list/123",
  callbackUrl: "https://sketch.example/api/webhooks/v1/endpoint-1",
  resourceId: "resource-1",
});

describe("webhook verification", () => {
  it("parses the bounded top-level descriptor and rejects code-like field paths", () => {
    expect(parseWebhookVerification(JSON.stringify(VERIFICATION))).toEqual(VERIFICATION);
    expect(
      parseWebhookVerification(JSON.stringify({ ...VERIFICATION, resourceIdField: "history_items[0].id" })),
    ).toBeNull();
    expect(parseWebhookVerification(JSON.stringify({ ...VERIFICATION, unexpected: true }))).toBeNull();
  });

  it("verifies the exact raw body with an encrypted secret and constant-time hex comparison", () => {
    const rawBody = Buffer.from('{ "webhook_id":"resource-1", "event":"taskUpdated" }', "utf8");
    const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
    const result = verifyWebhookRequest({
      rawBody,
      signature,
      verificationJson: JSON.stringify(VERIFICATION),
      signingSecretEncrypted: encrypt(SECRET, ENCRYPTION_KEY),
      sourceBinding: BINDING,
      encryptionKey: ENCRYPTION_KEY,
    });

    expect(result).toMatchObject({ kind: "verified", verification: VERIFICATION });
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("fails closed for plaintext secrets, malformed metadata, and invalid encryption keys", () => {
    const rawBody = Buffer.from("{}", "utf8");
    const signature = createHmac("sha256", SECRET).update(rawBody).digest("hex");
    const base = {
      rawBody,
      signature,
      verificationJson: JSON.stringify(VERIFICATION),
      signingSecretEncrypted: encrypt(SECRET, ENCRYPTION_KEY),
      sourceBinding: BINDING,
      encryptionKey: ENCRYPTION_KEY,
    };

    expect(verifyWebhookRequest({ ...base, signingSecretEncrypted: SECRET })).toEqual({
      kind: "invalid_configuration",
    });
    expect(verifyWebhookRequest({ ...base, verificationJson: "not-json" })).toEqual({ kind: "invalid_configuration" });
    expect(verifyWebhookRequest({ ...base, encryptionKey: "not-a-key" })).toEqual({ kind: "invalid_configuration" });
    expect(verifyWebhookRequest({ ...base, signature: "0".repeat(64) })).toEqual({ kind: "invalid_signature" });
  });

  it("accepts a 4096-byte secret and rejects a larger decrypted secret", () => {
    const rawBody = Buffer.from("{}", "utf8");
    const acceptedSecret = "x".repeat(4096);
    const acceptedSignature = createHmac("sha256", acceptedSecret).update(rawBody).digest("hex");
    const accepted = verifyWebhookRequest({
      rawBody,
      signature: acceptedSignature,
      verificationJson: JSON.stringify(VERIFICATION),
      signingSecretEncrypted: encrypt(acceptedSecret, ENCRYPTION_KEY),
      sourceBinding: BINDING,
      encryptionKey: ENCRYPTION_KEY,
    });
    const rejected = verifyWebhookRequest({
      rawBody,
      signature: acceptedSignature,
      verificationJson: JSON.stringify(VERIFICATION),
      signingSecretEncrypted: encrypt(`${acceptedSecret}x`, ENCRYPTION_KEY),
      sourceBinding: BINDING,
      encryptionKey: ENCRYPTION_KEY,
    });

    expect(accepted.kind).toBe("verified");
    expect(rejected).toEqual({ kind: "invalid_configuration" });
  });

  it("uses a stable hashed provider identity and separates event kinds", () => {
    const first = webhookEventIdentity(
      Buffer.from('{"event":"taskUpdated"}', "utf8"),
      { webhook_id: "resource-1", event: "taskUpdated", history_items: [{ id: "history-2" }, { id: "history-1" }] },
      VERIFICATION,
      "resource-1",
    );
    const whitespaceRetry = webhookEventIdentity(
      Buffer.from(
        '{ "webhook_id": "resource-1", "history_items": [{ "id": "history-1" }, { "id": "history-2" }], "event": "taskUpdated" }',
        "utf8",
      ),
      { webhook_id: "resource-1", event: "taskUpdated", history_items: [{ id: "history-1" }, { id: "history-2" }] },
      VERIFICATION,
      "resource-1",
    );
    const otherEvent = webhookEventIdentity(
      Buffer.from("{}", "utf8"),
      {
        webhook_id: "resource-1",
        event: "taskStatusUpdated",
        history_items: [{ id: "history-1" }, { id: "history-2" }],
      },
      VERIFICATION,
      "resource-1",
    );

    expect(whitespaceRetry.eventId).toEqual(first.eventId);
    expect(whitespaceRetry.payloadHash).not.toEqual(first.payloadHash);
    expect(otherEvent.eventId).not.toBe(first.eventId);
    expect(first.eventId).toMatch(/^[0-9a-f]{64}$/u);
  });
});
