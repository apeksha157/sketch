/**
 * Password hashing using Node's built-in crypto.scrypt.
 * Format: salt:hash (both hex-encoded). No external dependencies.
 */
import type { ScryptOptions } from "node:crypto";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const SALT_LENGTH = 32;
const KEY_LENGTH = 64;

/** When set, overrides Node's default scrypt cost (used by tests for fast hashing). */
let scryptOverrides: ScryptOptions | undefined;

export function setScryptOptions(options: ScryptOptions) {
  scryptOverrides = options;
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | null, key: Buffer) => (err ? reject(err) : resolve(key));
    if (scryptOverrides) {
      scrypt(password, salt, KEY_LENGTH, scryptOverrides, cb);
    } else {
      scrypt(password, salt, KEY_LENGTH, cb);
    }
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await deriveKey(password, salt);
  return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(":");
  if (!saltHex || !hashHex) return false;

  const salt = Buffer.from(saltHex, "hex");
  const storedHash = Buffer.from(hashHex, "hex");
  const hash = await deriveKey(password, salt);

  return timingSafeEqual(hash, storedHash);
}
