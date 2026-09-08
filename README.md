# Worklog

Self-hosted work time tracking and invoicing. A Deno server holds the truth in SQLite; a React
frontend reaches it over [KPS](https://github.com/ethereum/kps) — from a Deno Desktop window or from
a static page on GitHub Pages, both dialling the same `<ip>:<port>:<certhash>` address.

<img src="docs/timer-desktop.png" alt="The timer screen: today's total against the day's scheduled hours, and the current session below it" width="420">
<img src="docs/timer-mobile.png" alt="The same screen in the mobile presentation, with a bottom tab bar" width="200">

[`REQUIREMENTS.md`](REQUIREMENTS.md) is the specification, and it is **append-only**: items keep
their numbers forever, superseded ones are struck through rather than edited, and new sections are
added rather than folded into old ones. That is what makes a reference to `6.10` safe to write down
and never revisit. Nearly every comment in this codebase cites one.

## Running it

```sh
deno task deps          # npm install, once — see "Why there is a package.json" below
deno task serve         # prints the address a frontend needs
```

**Serve it over HTTPS, or open it on localhost.** `crypto.subtle` — which is where the device key
lives — is only defined in a secure context, so a build served over plain HTTP from anything but
localhost cannot connect at all (24.38, 24.39). The app says so now instead of failing inside its
first signature. GitHub Pages is HTTPS, and `deno task web` binds to `127.0.0.1`, so both of the
intended ways in are fine; it is copying `web/dist` onto a plain HTTP server that is not.

```sh
deno task web           # the frontend, on http://127.0.0.1:5273
deno task web:build     # or a static bundle in web/dist
deno task desktop       # or the same frontend in a desktop window
```

The server prints something like `192.168.1.5:41108:uEiA…`. Paste it into the frontend's first
screen. **It is the only way in**, so treat it as a secret until a device is authorized — the first
device to arrive can claim admin, and every one after that has to be approved by an admin.

Only the four images this README embeds are committed. `deno task shots` captures every screen in
both shells — that walk is what validates them (23.5), and a screen that throws while rendering
fails the run — but writes the rest to `.screenshots/`, which is ignored. Nothing read the other
fourteen, nothing ever compared them against a baseline, and an older version's are recoverable by
checking that commit out and regenerating.

`deno task seed ./data` fills a database with invented work if you want something to look at.
`deno task shots` rebuilds the frontend and drives a real browser through the whole thing. It needs
`CHROME_PATH` pointing at a Chromium, because Playwright cannot download one everywhere; it checks
before it starts rather than after a minute of setup.

## Layout

| | |
| --- | --- |
| `shared/` | The domain core. Imports no runtime — no filesystem, no socket, no DOM — which is what makes 1.19's "one core behind both frontends" true by construction rather than by discipline. |
| `server/` | SQLite, the stores, the dispatcher. Everything KPS-shaped is in `main.ts` alone. |
| `web/` | React + Vite. Two shells over one set of screens. |
| `tools/` | The seeder, and the two browser harnesses over their shared rig. |

## Some decisions worth knowing about

**A work entry is filed under a plain calendar date, and that date is decided once.** It comes from
the local calendar of the device that *started* the timer, is captured at start rather than at stop,
and nothing later can move it — a session across midnight belongs entirely to the day it began
(2.19–2.23). Everything downstream is then timezone-free: the month an entry belongs to is a
substring of a string.

**How the projection is computed** (24.18 moved this off the screen). Every day of the month
contributes the work recorded on it plus however much of its scheduled interval has not yet
elapsed. A past day has none left, a future day has all of it, and today has the part after the
current minute — so the projection moves through the day, and sitting idle through a scheduled
morning shows up now rather than at midnight.

The screen shows that as one figure and two bars: how far through the month's *scheduled* time we
are, and how much of the target is done. Ahead or behind is the offset between them. It is drawn
rather than stated because the stated version needs a negative number — a month with 176 scheduled
hours against a 160-hour target carries 16 hours of slack, so "where you should be" opens at −16.

**Pacing is a schedule, not a number of hours.** Every day of the month contributes work recorded on
it plus however much of its scheduled interval has not yet elapsed. A past day has none left, a
future day has all of it, today has the part after the current minute — so the projection moves
through the day, and sitting idle through a scheduled morning shows up now rather than at midnight.
The pacing screen shows the terms adding up, because a pace figure on its own is a number to be
believed or not.

**A month is the unit of invoicing.** That collapses "do these two invoices overlap?" to a string
comparison, and makes the real rule *at most one issued-or-paid invoice per calendar month* — which
is enforced twice: by `canIssue`, so the caller gets a sentence, and by a partial unique index, so a
race cannot get past. Drafts are invisible to the index, so any number may coexist, and reverting an
issuance frees the month with no code of its own.

**Signing is an interface, not a key.** In a browser tab it is a non-extractable `CryptoKey` kept
in IndexedDB *as a key* rather than as bytes — Ed25519 honours `extractable: false` for the private
half while still letting the public half out, so "never leaves the device" is something the key
cannot do rather than a rule this code follows. In the desktop window it is a file the operating
system protects and the page asks the shell to sign. Either way the client never sees key material,
which a test proves by handing it a signer made of two plain functions.

**Payment details never come back from the server.** They are needed to edit and to render a PDF,
never to display, so the read path deletes them. `SENSITIVE_INVOICE_FIELDS` names them in one place,
and `publicInvoiceConfig` deletes rather than allow-lists — a new field reaches the UI by default,
and a newly-sensitive one leaves the wire by editing one list.

**The two presentations are separate shells, not breakpoints.** A sidebar does not become a tab bar
by getting narrower. What they share is everything below them: the same screens, the same store, the
same client. The viewport picks, not the runtime, so a narrow desktop window gets the phone layout —
the constraint being solved is how much room there is.

## The desktop window

`deno task desktop` builds and runs the same bundle in a `Deno.BrowserWindow` (`deno desktop
<entry>` only *builds*, so the task runs the result itself — the version that did not read exactly
like it had worked). What it adds is a window that
stays on top (**Settings → This window**) and a device key the operating system protects: the shell
generates it into `device-key.json` at `0600`, re-imports it non-extractable, and the page asks for
signatures rather than holding anything. That is a stronger reading of "the private key never
leaves the device" than a browser can offer, where the key at least lives in the tab's storage.

`deno task desktop:check` proves it — a real Ed25519 signature made by the shell and verified
against its public half, a settings round trip, a file written, and handler failures that reject
rather than hang. On a headless box, `xvfb-run -a deno task desktop:check`.

Its tenth check is the one that earns the rest: it loads the **real bundle** and asserts the app
mounts. Every other browser test in this repo drives Chromium, so a Chromium-only API in the
frontend is invisible to all of them — which is exactly how `Temporal` got in and kept the window
blank. Verified by putting `Temporal` back: the check goes red.

**It did not work at all until that check existed.** Four faults, stacked, none of which printed
anything:

- **`BrowserWindow.bind` exposes nothing.** In `deno desktop` 2.9.1's webview backend, `bind(name,
  fn)` returns `undefined` and `window[name]` stays undefined — every name shape, before and after
  navigation, on `file://` and `about:blank`, while `executeJs("1+1")` answers `2`. The shell bound
  five functions and had none. Worse than useless: `isDesktop()` was "did a global arrive?", so the
  app decided it was a browser tab and kept its key in a `file://` origin's IndexedDB, which is the
  exact storage the shell exists to replace. `desktop/bridge.ts` drives a queue over `executeJs`
  instead, and the build is detected by *which HTML file it is*, which is settled before anything
  runs.
- **A packaged app cannot load its own page.** `web/dist` is embedded, so `Deno.readFile` sees it
  and the webview does not; navigating to `file://<embedded>/desktop.html` leaves the window on
  `about:blank`. The shell copies the page out to real disk first, which is cheap only because
  `inline.mjs` makes it a single self-contained file.
- **`inline.mjs` was corrupting the bundle.** `String.replace` expands `$&` in the *replacement*,
  and minified React contains `$&`, so inlining spliced fragments of the document into the script
  and it failed to parse. A function replacement does not do that.
- **`Temporal` is Chromium-only**, and `shared/dates.ts` was built on it. The window threw
  `ReferenceError: Can't find variable: Temporal` on first render. That one was never a desktop
  problem: the Pages build was equally broken in Safari and in Firefox, and the only test driving a
  browser drove the one engine where it worked. `dates.ts` is plain UTC arithmetic now, the
  `unstable: ["temporal"]` flag is gone, and the containment its own header claimed — "keep
  `Temporal` from leaking" — is what kept the fix to one file.

Every one of those presented as an empty window and a cheerful log line. So the shell now asks the
page what it is a second after loading it, and says whether it answered: the build marker, the
child count under `#root`, and any boot error. `inline.mjs` records what a `file://` document
otherwise sanitises to `Script error. @ ?:0`, and `main.tsx` hands React's own errors to the same
place, because a packaged app has no console to read and no devtools to open.

What is still unverified is **the desktop window reaching a server**, and it is unverifiable here
rather than untried: this WebKitGTK has no `RTCPeerConnection` at all — the constructor is
undefined, not broken — so no dial can be attempted from it. Everything below the transport is
covered by `desktop:check`; the transport is covered end to end in Chromium by `deno task journey`.

That is a property of how a webview was compiled rather than of this container, so the app now says
so in a sentence instead of throwing `Can't find variable: RTCPeerConnection`, which reads like a
bug in the frontend and is not one.

## Why there is a package.json

Deno cannot install `@kpstreams/server` itself. Its QUIC backend lists
`@infisical/quic-darwin-arm64` as an `optionalDependency` and that package 404s on the registry; npm
skips a failing optional dependency, Deno treats it as fatal. So `deno task deps` runs `npm install`
once and everything after that uses `--node-modules-dir=manual`.

There is a second, related fault worth knowing about: **QUIC streams do not work under Deno.** The
handshake completes and `accept()` resolves, but `acceptStream()` never does, where the identical
client against the identical listener under Node echoes fine. It costs this project nothing, because
both frontends are browsers and take the WebRTC path — which does work, and is exercised end to end
by `deno task shots`.

## How it is checked

| | |
| --- | --- |
| `deno task gate` | fmt, lint, types, **221 unit tests**, the browser build, then the published-bundle guard |
| `deno task journey` | **45 checks** driving the write path from three concurrent browsers |
| `deno task desktop:check` | **10 checks** on the desktop bridge, ending with "does the real app mount in WebKit" |
| `deno task shots` | 16 screenshots, both presentations, nothing mocked |

## Two browser harnesses, and what each is for

`deno task shots` proves every screen renders. `deno task journey` proves pressing things on them
works — forty-five checks across three concurrent browsers: run a timer and watch the other device
learn about it unasked, record time from the phone, edit an entry down to duration-only, delete
one, write a work note and see it arrive, record a voice note through a synthetic microphone and play
it back off the server's disk, wait for a server-initiated prompt to reach both devices, invoice a month, take delivery of the PDF, issue it, and
change the schedule and watch the projection move on another device, revoke the phone while it is
still holding an open subscription, and confirm a `read` device is shown none of the controls it
would be refused. They share `tools/harness.mjs` and run on different
ports, so both can run at once.

**An admin watching the Admin screen never saw a request arrive.** That screen fetched its pending
and device lists once on mount, so `access-request` broadcast, the store refreshed, and the two
lists carried on showing what they had. The request appeared if you navigated away and came back.
"Show pending requests to admins" (13.25) is not much use when the showing happens before the
request does. The lists now follow the store's snapshot, like every other screen.

**The address is the credential, and nothing checked it stayed out of the bundle.** `web/dist`
publishes to Pages on every push, and 22.5 forbids a server address in it — `<ip>:<port>:<certhash>`
is the whole of what a stranger needs to reach the server and start asking for access, which is why
13.41 treats it as the bootstrap secret. It was true, by argument: the address lives in device
storage and no build step touches it. `web/bundle_test.ts` makes it a check, and runs *after*
`web:build` so it reads the bundle that is about to ship rather than whichever one was lying around.
The discriminator is length — a real certhash is forty-odd base64url characters, and the example on
the connect screen is `uEiA…`, which cannot become one by accident. A guard that fired on the
placeholder would be switched off, and then it would miss the real thing too.

**A device could lose its own identity, and one reload was not enough to see it.** The device key
lives in IndexedDB, and two modules opened that database independently: `deviceKeys.ts` at version
1, `localAudio.ts` at version 2. IndexedDB refuses to open an existing database at a lower version,
so once anything touched the audio store, every later attempt to read the key failed with
`VersionError` — and a device that cannot read its key cannot prove who it is, so it lands back on
the connect screen and needs an admin to approve it all over again. Play the loop file once and
reload, and the phone has forgotten itself. `web/src/idb.ts` now owns the database, its version and
its stores, and a test counts the `indexedDB.open` calls, because nothing in the type system can
see two callers disagreeing about a number.

The distinction earned itself. The screenshots were green for a fortnight while **"Generate PDF"
rendered a document onto the server's disk and handed the person who pressed it nothing** — the
button existed, the screen rendered, the call succeeded, and the result was discarded (8.33). And
underneath that, **every subscription silently dropped its first event**: the subscribe
acknowledgement went out through `encodeJson` with no trailing newline while every event after it
had one, so the two arrived as one unparseable string and the client's `catch` counted it as one
event lost. Nothing failed. The device that made a change refreshed itself and looked right; the
second device was one event behind forever. It took two browsers to see it, and the test that
should have caught it was green because its *fake* transport wrote the newline the real server
did not.

## The screenshots are the end-to-end test

`tools/screenshots.mjs` mocks nothing. It seeds a database, starts the real KPS listener, serves the
real production bundle, and drives Chromium through the real claim-admin handshake over WebRTC —
then opens a *second* browser context, which is genuinely a second device because the key lives in
IndexedDB, has it request access, and approves it from the first. If the transport, the protocol,
the signing or either shell is broken, there are no pictures.

<img src="docs/pacing-desktop.png" alt="The pacing screen: how far ahead or behind, and two bars comparing the month elapsed against the hours worked" width="420">
<img src="docs/invoices-desktop.png" alt="The invoice list, with every lifecycle action on the row" width="420">

The invoice PDF is rendered on the server and follows the supplied format closely — see
[`docs/invoice-sample.pdf`](docs/invoice-sample.pdf), generated from the fixture by
`deno run -A --node-modules-dir=manual tools/invoice-pdf.ts ./data 2026-08 out.pdf`.
