// PIN gate for the full demo deployment (demo.zencub.com).
//
// The cookie is an HMAC-signed expiry stamp, so the server holds no session
// state and a forged or expired cookie cannot be minted without DEMO_SECRET.
// Uses Web Crypto only, so this module is safe to import from middleware.

export const DEMO_COOKIE = "zencub_demo";

const SESSION_MS = 12 * 60 * 60 * 1000; // 12 hours

function encoder() {
  return new TextEncoder();
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// Constant-time comparison so a signature cannot be recovered byte by byte.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sign(payload: string, secret: string): Promise<string> {
  const key = await hmacKey(secret);
  return toHex(await crypto.subtle.sign("HMAC", key, encoder().encode(payload)));
}

export async function issueDemoCookie(secret: string): Promise<string> {
  const expiresAt = String(Date.now() + SESSION_MS);
  return `${expiresAt}.${await sign(expiresAt, secret)}`;
}

export async function verifyDemoCookie(
  value: string | undefined,
  secret: string,
): Promise<boolean> {
  if (!value) return false;

  const separator = value.indexOf(".");
  if (separator <= 0) return false;

  const expiresAt = value.slice(0, separator);
  const signature = value.slice(separator + 1);

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;

  return timingSafeEqual(signature, await sign(expiresAt, secret));
}

export const DEMO_COOKIE_MAX_AGE = Math.floor(SESSION_MS / 1000);

// Both are required before the full deployment will unlock. Missing values fail
// closed in the middleware rather than defaulting to an open site.
export function demoCredentials(): { pin: string; secret: string } | null {
  const pin = process.env.DEMO_PIN;
  const secret = process.env.DEMO_SECRET;
  if (!pin || !secret) return null;
  return { pin, secret };
}
