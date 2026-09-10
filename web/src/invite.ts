/**
 * An invitation is a URL: this app, with the server's address in its fragment (27.23).
 *
 * Somebody scanning it gets the frontend and the address in one act, which is the whole point —
 * the alternative is reading a hundred hexadecimal characters off one screen and typing them into
 * another. The name is the address here: a KPS address is `<ip>:<port>:<certhash>` and the
 * certificate hash is what makes the connection to *that* server and no other.
 *
 * **The fragment, deliberately.** 21.19 says this app does not keep state in the URL, and it still
 * does not: nothing here is navigable, bookmarkable or shareable after the fact, because the app
 * consumes the value and removes it. A fragment rather than a query string because a fragment is
 * never sent to the web server that hosts the page — GitHub Pages logs the path, not this.
 *
 * **It is not a credential.** The address gets a device as far as asking; an admin still approves
 * it (section 13). So the QR is safe to show on a screen in a room, which is where invitations
 * happen.
 */

const KEY = "kps";

/** The address carried by the current URL, if there is one. No side effects: safe during render. */
export function invitedAddress(): string | undefined {
  const hash = globalThis.location?.hash ?? "";
  const found = new RegExp(`(?:^|[#&])${KEY}=([^&]+)`).exec(hash);
  if (!found) return undefined;
  try {
    const value = decodeURIComponent(found[1] ?? "").trim();
    return value || undefined;
  } catch {
    // A fragment that is not valid percent-encoding is not an invitation; the connect screen is
    // the right place to end up, with its own field to paste into.
    return undefined;
  }
}

/**
 * Take the invitation out of the URL, once it has been acted on.
 *
 * `replaceState` rather than assigning `location.hash = ""`, which leaves a bare `#` behind and
 * pushes a history entry. Wrapped because a `file://` document — the desktop window — refuses
 * `replaceState` with a SecurityError, and there is no invitation there to remove anyway.
 */
export function clearInvitation(): void {
  try {
    const { pathname, search } = globalThis.location;
    // Reached structurally rather than as `globalThis.history`: this module is type-checked twice,
    // once by `tsc` with the DOM library and once by `deno check` without it, and `History` is not
    // a name the second one has.
    const history = (globalThis as unknown as {
      history?: { replaceState(state: unknown, unused: string, url: string): void };
    }).history;
    history?.replaceState(null, "", `${pathname}${search}`);
  } catch {
    // Nothing to do: the address has already been stored, which is the part that mattered.
  }
}

/**
 * What to put in the code: where this page came from, plus the address.
 *
 * `origin + pathname` rather than `href`, so an invitation issued from a page that was itself
 * opened by an invitation does not carry two fragments — and so it does not carry a query string
 * somebody's browser extension added either.
 *
 * **The desktop window has no web address.** It is a `file://` document, where `origin` is the
 * string "null", and a QR of `nullundefined#kps=…` is worse than useless — it looks like it
 * worked. So there the code carries the bare server address, which a camera shows as text to copy
 * into the other device's setup screen. `url: false` is how the dialog knows to say that.
 */
export function invitationTarget(address: string): { text: string; url: boolean } {
  const { origin, pathname, protocol } = globalThis.location;
  if (protocol !== "http:" && protocol !== "https:") return { text: address, url: false };
  /*
   * Colons left as themselves. `encodeURIComponent` turns each one into `%3A`, and a KPS address
   * has two — so the link a person reads aloud or types becomes `192.168.1.5%3A4433%3A9f…`, and
   * the QR carries four more characters than it needs. A colon is legal in a fragment (RFC 3986
   * `fragment = *( pchar / "/" / "?" )`, and `pchar` includes it), and `decodeURIComponent` gives
   * back a bare colon unchanged.
   */
  const encoded = encodeURIComponent(address).replaceAll("%3A", ":");
  return { text: `${origin}${pathname}#${KEY}=${encoded}`, url: true };
}
