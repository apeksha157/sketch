import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { webhookSourceBindingSchema } from "@sketch/shared";
import { z } from "zod";
import { decrypt } from "../auth/encryption";

const SAFE_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/u;
const SAFE_HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/u;
const ENCRYPTION_KEY = /^[0-9a-f]{64}$/iu;
const SIGNATURE = /^[0-9a-f]{64}$/iu;
const ENCRYPTED_SECRET_PREFIX = "enc:";

const fieldNameSchema = z.string().regex(SAFE_FIELD_NAME);
export const webhookVerificationSchema = z
  .object({
    type: z.literal("hmac_sha256"),
    signatureHeader: z.string().regex(SAFE_HEADER_NAME),
    resourceIdField: fieldNameSchema,
    dedupe: z
      .object({
        eventField: fieldNameSchema,
        itemsField: fieldNameSchema,
        itemIdField: fieldNameSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export type WebhookVerification = z.infer<typeof webhookVerificationSchema>;
export type WebhookSourceBinding = z.infer<typeof webhookSourceBindingSchema>;

export type WebhookVerificationResult =
  | { readonly kind: "invalid_configuration" }
  | { readonly kind: "invalid_signature" }
  | {
      readonly kind: "verified";
      readonly verification: WebhookVerification;
      readonly sourceBinding: WebhookSourceBinding & { readonly resourceId: string };
    };

export interface WebhookEventIdentity {
  readonly eventId: string;
  readonly payloadHash: string;
}

export function parseWebhookVerification(value: string | null | undefined): WebhookVerification | null {
  if (value == null) return null;
  try {
    return webhookVerificationSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

export function parseWebhookSourceBinding(value: string | null | undefined): WebhookSourceBinding | null {
  if (value == null) return null;
  try {
    return webhookSourceBindingSchema.parse(JSON.parse(value));
  } catch {
    return null;
  }
}

interface WebhookVerificationParameters {
  readonly verificationJson: string | null;
  readonly signingSecretEncrypted: string | null;
  readonly sourceBinding: string | null;
  readonly encryptionKey: string | undefined;
}

function loadWebhookVerification(params: WebhookVerificationParameters) {
  if (
    !params.encryptionKey ||
    !ENCRYPTION_KEY.test(params.encryptionKey) ||
    !params.signingSecretEncrypted?.startsWith(ENCRYPTED_SECRET_PREFIX)
  ) {
    return null;
  }

  const verification = parseWebhookVerification(params.verificationJson);
  const sourceBinding = parseWebhookSourceBinding(params.sourceBinding);
  if (!verification || !sourceBinding || sourceBinding.resourceId === null) {
    return null;
  }

  let secret: string;
  try {
    secret = decrypt(params.signingSecretEncrypted, params.encryptionKey);
  } catch {
    return null;
  }
  if (secret.length === 0 || Buffer.byteLength(secret, "utf8") > 4096) {
    return null;
  }

  return { verification, sourceBinding: { ...sourceBinding, resourceId: sourceBinding.resourceId }, secret };
}

export function isWebhookVerificationReady(params: WebhookVerificationParameters): boolean {
  return loadWebhookVerification(params) !== null;
}

export function verifyWebhookRequest(
  params: WebhookVerificationParameters & { readonly rawBody: Buffer; readonly signature: string | undefined },
): WebhookVerificationResult {
  const configured = loadWebhookVerification(params);
  if (!configured) return { kind: "invalid_configuration" };
  const { verification, sourceBinding, secret } = configured;

  if (!params.signature || !SIGNATURE.test(params.signature)) return { kind: "invalid_signature" };
  const expected = createHmac("sha256", secret).update(params.rawBody).digest();
  const actual = Buffer.from(params.signature, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { kind: "invalid_signature" };
  }

  return { kind: "verified", verification, sourceBinding };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint > 0x1f && codePoint !== 0x7f;
  });
}

function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function webhookEventIdentity(
  rawBody: Buffer,
  payload: unknown,
  verification: WebhookVerification,
  resourceId: string,
): WebhookEventIdentity {
  const fallback = (): WebhookEventIdentity => {
    const payloadHash = hash(rawBody);
    return { eventId: payloadHash, payloadHash };
  };

  if (!isRecord(payload) || !verification.dedupe) return fallback();
  const event = payload[verification.dedupe.eventField];
  const items = payload[verification.dedupe.itemsField];
  if (!boundedString(event) || !Array.isArray(items) || items.length === 0) return fallback();

  const itemIds: string[] = [];
  for (const item of items) {
    if (!isRecord(item)) return fallback();
    const itemId = item[verification.dedupe.itemIdField];
    if (!boundedString(itemId)) return fallback();
    itemIds.push(itemId);
  }
  if (itemIds.length === 0) return fallback();

  const identity = ["sketch-webhook-identity-v1", event, resourceId, ...[...new Set(itemIds)].sort()].join("\u0000");
  return { eventId: hash(identity), payloadHash: hash(rawBody) };
}
