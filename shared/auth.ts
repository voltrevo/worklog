/**
 * What a device signs to prove who it is.
 *
 * This lives in `shared/` because both ends must produce **byte-for-byte the same message** — the
 * frontend to sign it and the server to verify it. Two implementations of "the same" encoding is
 * how signature schemes quietly stop protecting anything.
 *
 * **The encoding is length-prefixed, not JSON.** A JSON message would make the signature depend on
 * key order, whitespace and number formatting, none of which either side controls precisely; worse,
 * two different field sets can serialise to strings that a lenient parser reads the same way. Here
 * every field is `u32` length followed by bytes, in a fixed order, behind a domain tag — so a
 * message can be parsed exactly one way and cannot be reinterpreted as a different one.
 *
 * 13.17–13.23 name six things the signature must cover, and all six are fields below. The one worth
 * dwelling on is the **server's certificate hash** (13.23): without it a signed request captured by
 * one server could be replayed to another, and since a KPS address *is* a certhash, binding to it
 * is what makes "I meant to talk to this server" part of what was signed.
 */

export const AUTH_DOMAIN = "worklog-access-v1";

/** What the signature is for. Part of the signed bytes, so one purpose's proof is not another's. */
export type AuthPurpose =
  /** 13.6–13.9 — the first device, while the server has no authorized ones. */
  | "claim"
  /** 13.11–13.13 — every device after that. */
  | "request"
  /** 13.30, 13.31 — an already-authorized device proving itself on a later connection. */
  | "auth";

export type AccessRole = "read" | "write" | "admin";

export interface AuthClaim {
  purpose: AuthPurpose;
  /** 13.12, 13.18. An untrusted display string (13.38) — signed, but never an identity. */
  deviceName: string;
  /** 13.13, 13.19. What is being asked for; an admin grants what they choose (13.28). */
  role: AccessRole;
  /** 13.20 — raw Ed25519 public key, 32 bytes. */
  publicKey: Uint8Array;
  /** 13.21 — milliseconds since the epoch, as the device sees it. */
  timestamp: number;
  /** 13.22 — the server's fresh, single-use challenge. */
  challenge: Uint8Array;
  /** 13.23 — the KPS certificate hash of the server this is meant for. */
  serverCertHash: string;
}

const enc = new TextEncoder();

function u32(n: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, false);
  return out;
}

function u64(n: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(Math.trunc(n)), false);
  return out;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** `u32` length then the bytes. Every variable-length field goes through this, without exception. */
function field(bytes: Uint8Array | string): Uint8Array {
  const b = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  return concat([u32(b.length), b]);
}

/**
 * The exact bytes signed and verified.
 *
 * Changing anything here — an added field, a reordering, a different domain — invalidates every
 * signature made by an older build, which is the correct behaviour and the reason the domain string
 * carries a version.
 */
export function authMessage(claim: AuthClaim): Uint8Array {
  return concat([
    field(AUTH_DOMAIN),
    field(claim.purpose),
    field(claim.deviceName),
    field(claim.role),
    field(claim.publicKey),
    u64(claim.timestamp),
    field(claim.challenge),
    field(claim.serverCertHash),
  ]);
}

const ED = { name: "Ed25519" } as const;

/**
 * A device key that can sign and cannot be read.
 *
 * `extractable: false` is honoured for the private half; Ed25519 leaves the *public* half
 * extractable regardless, which is what makes a non-extractable pair usable at all. So 13.4 and
 * 20.5 are properties of the key rather than rules this code follows: there is no call that
 * returns the private bytes, to us or to anything else running on the page.
 */
export async function generateDeviceKey(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(ED, false, ["sign", "verify"]) as CryptoKeyPair;
}

export async function exportPublicKey(pair: CryptoKeyPair): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
}

export async function importPublicKey(raw: Uint8Array): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", raw as BufferSource, ED, true, ["verify"]);
}

export async function signClaim(claim: AuthClaim, privateKey: CryptoKey): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign(ED, privateKey, authMessage(claim) as BufferSource);
  return new Uint8Array(sig);
}

/**
 * Whether `signature` is this claim's, made by the key the claim names.
 *
 * Only the signature. Freshness, replay and whether the server even issued this challenge are the
 * server's business (13.24) and live in `server/access.ts` — a valid signature over a stale
 * challenge is still a valid signature, and conflating the two is how a replay gets accepted.
 */
export async function verifyClaim(claim: AuthClaim, signature: Uint8Array): Promise<boolean> {
  if (claim.publicKey.length !== 32 || signature.length !== 64) return false;
  try {
    const key = await importPublicKey(claim.publicKey);
    return await crypto.subtle.verify(
      ED,
      key,
      signature as BufferSource,
      authMessage(claim) as BufferSource,
    );
  } catch {
    return false;
  }
}

/** A short, stable, human-comparable form of a public key, for the admin queue (13.26). */
export function fingerprint(publicKey: Uint8Array): string {
  return [...publicKey.slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(":");
}
