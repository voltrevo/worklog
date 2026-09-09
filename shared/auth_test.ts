/**
 * The one thing about a device key that is not a property of the key.
 *
 * 13.4 and 20.5 hold because there is no call that returns the private bytes — see the comment on
 * `generateDeviceKey`. What is worth testing is the failure a person actually meets: a browser
 * with Web Crypto and no Ed25519 in it.
 */

import { assertRejects } from "jsr:@std/assert@^1";
import { generateDeviceKey } from "./auth.ts";

Deno.test("a browser without Ed25519 is told what is wrong and what works", async () => {
  const real = crypto.subtle.generateKey;
  // What Safari before 17 does: `crypto.subtle` is there and this algorithm is not. Cast because
  // `generateKey` is overloaded four ways and a stub cannot satisfy all of them at once.
  crypto.subtle.generateKey = (() => {
    const err = new Error("Ed25519 is not supported");
    err.name = "NotSupportedError";
    return Promise.reject(err);
  }) as typeof crypto.subtle.generateKey;
  try {
    await assertRejects(
      () => generateDeviceKey(),
      Error,
      "cannot make an Ed25519 key",
    );
  } finally {
    crypto.subtle.generateKey = real;
  }
});

Deno.test("and any other failure is passed through as it was", async () => {
  const real = crypto.subtle.generateKey;
  crypto.subtle.generateKey =
    (() => Promise.reject(new Error("the disk is on fire"))) as typeof crypto.subtle.generateKey;
  try {
    await assertRejects(() => generateDeviceKey(), Error, "the disk is on fire");
  } finally {
    crypto.subtle.generateKey = real;
  }
});
