import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ENCRYPTION_VERSION = 1;

export function encryptText(plaintext: string, secret: string): string {
  if (!secret) {
    throw new Error("secret must not be empty");
  }

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(secret, salt, 32);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return JSON.stringify({
    version: ENCRYPTION_VERSION,
    cipher: "aes-256-gcm",
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64"),
  });
}

export function decryptText(encrypted: string, secret: string): string {
  if (!secret) {
    throw new Error("secret must not be empty");
  }

  const payload = JSON.parse(encrypted) as {
    version?: number;
    cipher?: string;
    kdf?: string;
    salt?: string;
    iv?: string;
    tag?: string;
    data?: string;
  };

  if (
    payload.version !== ENCRYPTION_VERSION ||
    payload.cipher !== "aes-256-gcm" ||
    payload.kdf !== "scrypt" ||
    !payload.salt ||
    !payload.iv ||
    !payload.tag ||
    !payload.data
  ) {
    throw new Error("encrypted Redis value has an unsupported format");
  }

  const salt = Buffer.from(payload.salt, "base64");
  const iv = Buffer.from(payload.iv, "base64");
  const tag = Buffer.from(payload.tag, "base64");
  const ciphertext = Buffer.from(payload.data, "base64");
  const key = scryptSync(secret, salt, 32);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
