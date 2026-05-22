import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96 bits recommended for GCM
const TAG_LENGTH = 16; // 128 bits

/**
 * Retrieves the encryption key from environment variable.
 * Key must be 32 bytes, base64 encoded.
 */
function getEncryptionKey(): Buffer {
  const keyBase64 = process.env.INSTANCE_ENCRYPTION_KEY;
  if (!keyBase64) {
    throw new EncryptionKeyMissingError();
  }
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      "INSTANCE_ENCRYPTION_KEY must be exactly 32 bytes (256 bits) when decoded from base64"
    );
  }
  return key;
}

/**
 * Error thrown when INSTANCE_ENCRYPTION_KEY is not configured.
 * API routes should catch this and return HTTP 503.
 */
export class EncryptionKeyMissingError extends Error {
  constructor() {
    super("INSTANCE_ENCRYPTION_KEY is not configured");
    this.name = "EncryptionKeyMissingError";
  }
}

/**
 * Throws EncryptionKeyMissingError if the encryption key is not configured.
 * Use in API routes to return HTTP 503 early.
 */
export function ensureEncryptionKey(): void {
  const keyBase64 = process.env.INSTANCE_ENCRYPTION_KEY;
  if (!keyBase64) {
    throw new EncryptionKeyMissingError();
  }
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error(
      "INSTANCE_ENCRYPTION_KEY must be exactly 32 bytes (256 bits) when decoded from base64"
    );
  }
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * @param plaintext - The string to encrypt
 * @returns Encrypted string in format `iv:ciphertext:tag` (all base64 encoded)
 */
export function encrypt(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  const tag = cipher.getAuthTag();

  return [
    iv.toString("base64"),
    encrypted.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

/**
 * Decrypts a string encrypted with the encrypt() function.
 * @param encrypted - Encrypted string in format `iv:ciphertext:tag` (all base64 encoded)
 * @returns Decrypted plaintext string
 */
export function decrypt(encrypted: string): string {
  const key = getEncryptionKey();

  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted format: expected iv:ciphertext:tag");
  }

  const [ivBase64, ciphertextBase64, tagBase64] = parts;
  const iv = Buffer.from(ivBase64, "base64");
  const ciphertext = Buffer.from(ciphertextBase64, "base64");
  const tag = Buffer.from(tagBase64, "base64");

  if (iv.length !== IV_LENGTH) {
    throw new Error(`Invalid IV length: expected ${IV_LENGTH} bytes`);
  }
  if (tag.length !== TAG_LENGTH) {
    throw new Error(`Invalid auth tag length: expected ${TAG_LENGTH} bytes`);
  }

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}
