import {
  createCipheriv,
  createDecipheriv,
  randomBytes as cryptographicRandomBytes
} from "node:crypto";

import { deriveOAuthPurposeKey } from "./oauth-secret.js";

const PREFIX = "hcn1";
const PURPOSE = "hcn-console-state:v1";
const AAD = Buffer.from("hcn-console-state-envelope:v1", "utf8");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 4096;
const MAX_ENVELOPE_BYTES = 8192;

export function createHcnConsoleStateCodec({
  secret,
  randomBytes = cryptographicRandomBytes
} = {}) {
  if (typeof randomBytes !== "function") {
    throw new TypeError("randomBytes must be a function");
  }
  const key = deriveOAuthPurposeKey(secret, PURPOSE);

  function seal(payload) {
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      throw stateError();
    }
    let plaintext;
    try {
      plaintext = Buffer.from(JSON.stringify(payload), "utf8");
    } catch {
      throw stateError();
    }
    if (
      plaintext.length === 0 ||
      plaintext.length > MAX_PLAINTEXT_BYTES
    ) {
      throw stateError();
    }
    let iv;
    try {
      iv = Buffer.from(randomBytes(IV_BYTES));
    } catch {
      throw stateError();
    }
    if (iv.length !== IV_BYTES) throw stateError();

    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(AAD);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final()
      ]);
      const tag = cipher.getAuthTag();
      return [
        PREFIX,
        canonicalBase64url(iv),
        canonicalBase64url(tag),
        canonicalBase64url(ciphertext)
      ].join(".");
    } catch {
      throw stateError();
    }
  }

  function open(value) {
    const encoded = String(value || "");
    if (
      encoded.length === 0 ||
      Buffer.byteLength(encoded, "utf8") > MAX_ENVELOPE_BYTES
    ) {
      throw stateError();
    }
    const parts = encoded.split(".");
    if (parts.length !== 4 || parts[0] !== PREFIX) {
      throw stateError();
    }
    const iv = decodeCanonicalBase64url(parts[1]);
    const tag = decodeCanonicalBase64url(parts[2]);
    const ciphertext = decodeCanonicalBase64url(parts[3]);
    if (
      iv.length !== IV_BYTES ||
      tag.length !== TAG_BYTES ||
      ciphertext.length === 0 ||
      ciphertext.length > MAX_PLAINTEXT_BYTES
    ) {
      throw stateError();
    }

    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(AAD);
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final()
      ]);
      if (
        plaintext.length === 0 ||
        plaintext.length > MAX_PLAINTEXT_BYTES
      ) {
        throw stateError();
      }
      const parsed = JSON.parse(plaintext.toString("utf8"));
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        Array.isArray(parsed)
      ) {
        throw stateError();
      }
      return parsed;
    } catch {
      throw stateError();
    }
  }

  return Object.freeze({ seal, open });
}

export function isHcnConsoleStateEnvelope(value) {
  return (
    typeof value === "string" &&
    value.startsWith(`${PREFIX}.`) &&
    Buffer.byteLength(value, "utf8") <= MAX_ENVELOPE_BYTES
  );
}

export class HcnConsoleStateError extends Error {
  constructor() {
    super("HCN console state is invalid or expired");
    this.name = "HcnConsoleStateError";
  }
}

function canonicalBase64url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeCanonicalBase64url(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw stateError();
  }
  let decoded;
  try {
    decoded = Buffer.from(value, "base64url");
  } catch {
    throw stateError();
  }
  if (canonicalBase64url(decoded) !== value) throw stateError();
  return decoded;
}

function stateError() {
  return new HcnConsoleStateError();
}
