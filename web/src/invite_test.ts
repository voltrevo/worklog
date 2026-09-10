/**
 * The invitation URL, in both directions and in both documents (27.23).
 *
 * These functions are two regular expressions and a template literal, which is exactly the kind of
 * code that is obviously right and is not. The `file://` branch in particular is unreachable from
 * the journey — that runs in Chromium over http — and reaching it in the desktop selftest would
 * mean driving a connected app inside WebKitGTK. It is a pure function of `location`, so it is
 * tested as one.
 */

import { assertEquals } from "jsr:@std/assert@^1";
import { clearInvitation, invitationTarget, invitedAddress } from "./invite.ts";

/**
 * Stand in for the document's `location` for the length of one test.
 *
 * `Object.defineProperty` rather than assignment: Deno's own `globalThis.location` is a getter
 * that throws without `--location`, and plain assignment to it does nothing (the same trap
 * `errorReporting_test.ts` documents for `localStorage`).
 */
function withLocation<T>(location: Partial<Location>, body: () => T): T {
  const had = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { value: location, configurable: true });
  try {
    return body();
  } finally {
    if (had) Object.defineProperty(globalThis, "location", had);
    else delete (globalThis as { location?: unknown }).location;
  }
}

const ADDRESS = "192.168.1.5:4433:9f2c8a1b4d6e";

Deno.test("27.23 -- an address in the fragment is an invitation", () => {
  withLocation({ hash: `#kps=${ADDRESS}` }, () => {
    assertEquals(invitedAddress(), ADDRESS);
  });
});

Deno.test("27.23 -- and a percent-encoded one is the same invitation", () => {
  withLocation({ hash: "#kps=192.168.1.5%3A4433%3A9f2c8a1b4d6e" }, () => {
    assertEquals(invitedAddress(), ADDRESS);
  });
});

Deno.test("27.23 -- anything else in the fragment is not one", () => {
  for (const hash of ["", "#", "#screen=timer", "#kps=", "#kpsx=1.2.3.4:1:aa"]) {
    withLocation({ hash }, () => {
      assertEquals(invitedAddress(), undefined, hash);
    });
  }
});

Deno.test("27.23 -- a fragment that is not valid encoding is refused, not thrown", () => {
  // `%zz` makes `decodeURIComponent` throw a URIError. Reaching the connect screen with its own
  // field to paste into is a recoverable end; a boot that throws is not.
  withLocation({ hash: "#kps=%zz" }, () => {
    assertEquals(invitedAddress(), undefined);
  });
});

Deno.test("27.23 -- the invitation is this page plus the address, colons intact", () => {
  withLocation(
    { origin: "https://someone.github.io", pathname: "/worklog/", protocol: "https:" },
    () => {
      assertEquals(invitationTarget(ADDRESS), {
        text: `https://someone.github.io/worklog/#kps=${ADDRESS}`,
        url: true,
      });
    },
  );
});

Deno.test("27.23 -- a query string on the issuing page is not carried into it", () => {
  withLocation(
    {
      origin: "https://someone.github.io",
      pathname: "/worklog/",
      protocol: "https:",
      search: "?utm=whatever",
    },
    () => {
      assertEquals(invitationTarget(ADDRESS).text.includes("utm"), false);
    },
  );
});

Deno.test("27.23 -- the desktop window offers the address, not a file:// URL", () => {
  // `origin` really is the string "null" for a `file://` document, so the naive version produces
  // `null/home/x/worklog.html#kps=…` and a QR code that looks like it worked.
  withLocation({ origin: "null", pathname: "/tmp/worklog/index.html", protocol: "file:" }, () => {
    assertEquals(invitationTarget(ADDRESS), { text: ADDRESS, url: false });
  });
});

Deno.test("27.23 -- clearing an invitation cannot throw, whatever the document allows", () => {
  // The desktop window refuses `replaceState` with a SecurityError. Whatever happens, the address
  // has already been stored by the time this is called, so there is nothing to report and nothing
  // to retry.
  withLocation({ pathname: "/worklog/", search: "" }, () => {
    const had = Object.getOwnPropertyDescriptor(globalThis, "history");
    Object.defineProperty(globalThis, "history", {
      value: {
        replaceState() {
          throw new Error("SecurityError");
        },
      },
      configurable: true,
    });
    try {
      clearInvitation();
    } finally {
      if (had) Object.defineProperty(globalThis, "history", had);
      else delete (globalThis as { history?: unknown }).history;
    }
  });
});
