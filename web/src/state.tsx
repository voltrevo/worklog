/**
 * The one place the app talks to the server.
 *
 * **The server is the source of truth and this does not pretend otherwise** (1.7, 1.11). There is no
 * optimistic local mutation: an action calls, and the screen changes when the snapshot comes back
 * or when a pushed event says to refetch. That costs a round trip on a local network and buys the
 * thing 1.11 asks for — a frontend cannot show a state the server does not hold.
 *
 * Refetching on `changed` rather than applying deltas is the same trade (see `protocol.ts`): the
 * server names an area, the client asks again, and there is one implementation of what the state
 * means instead of two that have to agree.
 */

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  memoryKeyStore,
  ServerRefusal,
  type Signer,
  webCryptoSigner,
  WorklogClient,
} from "@worklog/shared/client";
import type { Event, HelloResult, Request, SnapshotResult } from "@worklog/shared/protocol";
import type { AccessRole, AuthPurpose } from "@worklog/shared/auth";
import { minutesSinceMidnight, monthOf, today } from "@worklog/shared/dates";
import { connect } from "./kpsTransport.ts";
import { playPromptTune } from "./promptTune.ts";
import { desktopSigner, isDesktop, primeDeviceStorage } from "./desktop.ts";
import { clearInvitation, invitedAddress } from "./invite.ts";
import {
  describeError,
  flushQueue,
  installGlobalHandlers,
  report,
  type Sender,
} from "./errorReporting.ts";
import {
  clearAddress,
  indexedDbKeyStore,
  loadAddress,
  loadDeviceName,
  saveAddress,
  saveDeviceName,
} from "./deviceKeys.ts";

/** 22.7 — the four states a person can be in, each with something different to do about it. */
/** 22.8 — how long to wait before each attempt. Five, over about fifteen seconds. */
const RECONNECT_DELAYS = [400, 1_000, 2_500, 5_000, 6_000];

/**
 * How long one dial may take before it is a failure rather than a wait.
 *
 * Generous, because a first connection over WebRTC does ICE and DTLS and a slow network is a real
 * thing. Finite, because the alternative is a screen that says "Connecting…" forever.
 */
const CONNECT_TIMEOUT_MS = 12_000;

/**
 * 22.10 — how often the app asks whether the server is still there.
 *
 * Short enough that "Connected" is not a stale claim for long, long enough that it is nothing on a
 * local network: one request every eight seconds, answered with a timestamp.
 */
const HEARTBEAT_MS = 8_000;

/**
 * How long a ping may take before the connection counts as gone.
 *
 * Generous for a local network, where a round trip is a millisecond, and short enough that the
 * header stops lying inside a quarter of a minute. Being wrong here reconnects a working
 * connection, which costs a second and is invisible; being too patient is the bug this fixes.
 */
const HEARTBEAT_TIMEOUT_MS = 6_000;

export type Phase =
  | { k: "no-address" }
  | { k: "connecting"; address: string }
  | { k: "failed"; address: string; message: string }
  | {
    k: "unauthorized";
    address: string;
    offer: Exclude<AuthPurpose, "auth">;
    asked: boolean;
  }
  /**
   * 25.33 — asked, and answered yes.
   *
   * Its own phase rather than going straight to `ready`, because the answer arrives while nobody
   * is looking at the screen. Dropping somebody into the app the instant an admin approves them —
   * possibly mid-sentence on the waiting page — is a change of context they did not ask for and
   * cannot tell apart from a bug. The waiting page said "this page will carry on once they do",
   * and until now it did not: it needed a reload, which nothing said.
   */
  | { k: "approved"; address: string }
  | { k: "ready"; address: string; role: AccessRole; version: string };

export interface Store {
  phase: Phase;
  snapshot?: SnapshotResult;
  month: string;
  /** Ticks every second while a timer runs, so the home screen counts up (3.4). */
  tick: number;
  setMonth(month: string): void;
  call<T>(req: Request): Promise<T>;
  refresh(): Promise<void>;
  connectTo(address: string, deviceName: string): Promise<void>;
  claimAdmin(): Promise<void>;
  requestAccess(role: AccessRole): Promise<void>;
  forget(): void;
  deviceName: string;
  setDeviceName(name: string): void;
  lastError?: string;
  /** 22.8 — a loss is being retried, so the header can say so instead of the app vanishing. */
  reconnecting: boolean;
  clearError(): void;
  /** 5.16, 5.17 — set when the server fires a prompt; cleared when it is answered or dismissed. */
  prompt?: { id: string; firedAt: number };
  dismissPrompt(): void;
  /**
   * 26.7 — the tune stops when the prompt is *acknowledged*, which is not the same as answering it.
   *
   * It used to play until `dismissPrompt`, which is called on save or on "Not now" — so it went on
   * over somebody who had already turned to the dialog and started typing. Reaching the dialog is
   * the acknowledgement; what happens after is note-taking, and a tune playing through it is an
   * alarm that has stopped conveying anything.
   */
  acknowledgePrompt(): void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(Ctx);
  if (!store) throw new Error("useStore outside a StoreProvider");
  return store;
}

/**
 * Whether this device may change anything (27.43).
 *
 * Five screens wrote `phase.k === "ready" && phase.role !== "read"` out for themselves. All five
 * agreed, which is the state a copied rule is in right up until it is not — and this is the rule
 * that decides whether Start, Save, Delete and the invoice editor are offered at all. The server
 * refuses a read device regardless (`authorize`), so a divergence would show a control that then
 * fails rather than one that works; showing it is still a lie about what this key can do.
 *
 * A hook rather than a field on the store: it is derived from `phase`, and a derived value that
 * lives beside the thing it is derived from cannot fall out of step with it.
 */
export function useCanWrite(): boolean {
  const { phase } = useStore();
  return phase.k === "ready" && phase.role !== "read";
}

export function StoreProvider({ children }: { children: ReactNode }) {
  /*
   * 27.23 — an invitation in the URL counts as an address, from the first render.
   *
   * Peeked rather than consumed here: reading `location.hash` has no side effects, and a render
   * that stored things would run twice under StrictMode. The boot effect below saves it and takes
   * it out of the URL. Doing it only there would show the "where is your server?" screen for a
   * frame to somebody who has just scanned an invitation, which is the wrong first impression and
   * an easy tap on the wrong thing.
   */
  const [phase, setPhase] = useState<Phase>(() => {
    const address = invitedAddress() ?? loadAddress();
    return address ? { k: "connecting", address } : { k: "no-address" };
  });
  const [snapshot, setSnapshot] = useState<SnapshotResult>();
  const [month, setMonth] = useState(() => monthOf(today()));
  const [deviceName, setNameState] = useState(() => loadDeviceName());
  const [lastError, setLastError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [prompt, setPrompt] = useState<{ id: string; firedAt: number }>();
  /** 25.39 — how to stop the tune, held across renders because dismissal happens elsewhere. */
  const stopTuneRef = useRef<(() => void) | undefined>(undefined);

  const clientRef = useRef<WorklogClient>(null);
  /** Which transport the `closed` handler is allowed to act on. See `connectTo`. */
  const transportRef = useRef<Awaited<ReturnType<typeof connect>>>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const senderRef = useRef<Sender>(null);
  const monthRef = useRef(month);
  /**
   * The current phase, for the heartbeat, which is a timer and not a render.
   *
   * Written on every render below, beside the other refs that exist because a callback installed
   * once has to see what is true now rather than what was true when it was installed.
   */
  const phaseRef = useRef<Phase>(null);
  /** 27.1 — the number of the connection attempt in progress. See `connectTo`. */
  const attemptRef = useRef(0);
  monthRef.current = month;

  const refresh = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;
    try {
      setSnapshot(
        await client.call<SnapshotResult>({
          t: "snapshot",
          month: monthRef.current,
          // 3.9, 6.38 — the viewing device's clock, sent rather than inferred.
          clock: { today: today(), nowMinutes: minutesSinceMidnight() },
        }),
      );
    } catch (err) {
      setLastError(describe(err));
    }
  }, []);

  const call = useCallback(async <T,>(req: Request): Promise<T> => {
    const client = clientRef.current;
    if (!client) throw new Error("not connected");
    try {
      return await client.call<T>(req);
    } catch (err) {
      setLastError(describe(err));
      // A refusal is the server answering, not the app breaking; only the latter is worth logging.
      if (!(err instanceof ServerRefusal) && senderRef.current) {
        void report(senderRef.current, describeError(err, `request:${req.t}`));
      }
      throw err;
    }
  }, []);

  const onEvent = useCallback((event: Event) => {
    // Coarse by design: the server says what changed, the client asks again.
    if (event.e === "access-revoked") {
      setPhase((p) =>
        "address" in p
          ? {
            k: "unauthorized",
            address: p.address,
            offer: "request",
            asked: false,
          }
          : p
      );
      return;
    }
    if (event.e === "access-granted") {
      void refresh();
      return;
    }
    if (event.e === "prompt") {
      // 5.17 — each notified frontend presents it and plays its own tune. The sound is local: the
      // server knows a prompt fired and nothing about what any device did with it.
      //
      // 25.39 — the previous prompt's tune is stopped first. Two prompts close together would
      // otherwise overlap into a chord that is not either of them, and the second dismissal would
      // silence only the second tune.
      stopTuneRef.current?.();
      stopTuneRef.current = playPromptTune();
      setPrompt({ id: event.id, firedAt: event.firedAt });
      return;
    }
    void refresh();
  }, [refresh]);

  const connectTo = useCallback(async (address: string, name: string, retry = 0) => {
    /*
     * 27.1 — which attempt this is, so a superseded one cannot report anything.
     *
     * `transportRef` already stops an old *transport* from declaring the live one dropped, and
     * that is a different moment: an attempt which never produced a transport had nothing to
     * check itself against. Boot against a stored address, have it be slow or wrong, type a new
     * one — and the first attempt's failure arrives afterwards and puts "The connection to the
     * server dropped" over a session that is connecting or connected somewhere else. Reported as
     * flakiness at startup, and the giveaway was that it named the *previous* server.
     *
     * A counter rather than comparing addresses: connecting to the same server again is also a
     * new attempt, and the answer for the abandoned one is the same either way.
     */
    const attempt = ++attemptRef.current;
    const current = () => attemptRef.current === attempt;

    saveAddress(address);
    saveDeviceName(name);
    setNameState(name);
    if (retry === 0) {
      setPhase({ k: "connecting", address });
      setSnapshot(undefined);
    }

    /*
     * The previous connection goes before a new one is made.
     *
     * It used to be left running. Its `closed` promise resolved whenever it eventually died — and
     * the handler below then declared the *current* connection dropped, because it had no way to
     * tell which transport it belonged to. Connect to one server, connect to another, and a moment
     * later the second one reports a failure that happened to the first.
     */
    clientRef.current?.close();
    clientRef.current = null;

    try {
      /*
       * A dial that cannot succeed has to stop.
       *
       * `dial` waits on ICE and DTLS with no deadline of its own, so an address whose server is
       * gone left the app on "Connecting…" indefinitely. Nothing was wrong with the page and
       * nothing said so; the only way out was a Cancel button whose meaning is "forget this
       * server".
       *
       * This used to say that a restarted server is such an address, "since the certhash
       * changes". It does not: the KPS certificate is written to `kps-cert.pem` inside the data
       * directory, so the same server on the same data comes back at the same address. There is a
       * check for that now, because it is the difference between a restart being invisible and
       * every device having to be re-pointed by hand.
       */
      const transport = await connect(address, AbortSignal.timeout(CONNECT_TIMEOUT_MS));
      // Somebody typed a different address while this was dialling. This one is nobody's
      // connection now, and leaving it open would leave a second peer connection running.
      if (!current()) {
        transport.close();
        return;
      }
      transportRef.current = transport;
      const client = new WorklogClient({
        transport,
        signer: chooseSigner(),
        deviceName: name,
        onEvent,
      });
      clientRef.current = client;

      // 12.6, 12.16 — only an authenticated device may report, so the sender is wired up here
      // rather than at startup, and it is what drains anything held while there was no server.
      const send: Sender = (r) =>
        client.call({
          t: "client-error",
          message: r.message,
          context: r.context,
        });
      senderRef.current = send;

      const hello: HelloResult = await client.hello();
      if (hello.offer === "auth") {
        const who = await client.authenticate();
        setPhase({
          k: "ready",
          address,
          role: who.role,
          version: hello.version,
        });
        await client.subscribe();
        await refresh();
        void flushQueue(send); // 12.14 — whatever was held while there was no server
      } else {
        setPhase({
          k: "unauthorized",
          address,
          offer: hello.offer,
          asked: false,
        });
      }

      /*
       * 22.8 — a transient loss reconnects itself.
       *
       * Two things used to go wrong here at once. This handler fired for *any* transport, current
       * or not, so a connection replaced seconds earlier could mark a healthy one as dropped. And
       * `closed` resolves when the *subscription stream* ends, not only when the connection dies —
       * one stream finishing looked identical to the server going away.
       *
       * Both produced the same symptom: connect, work fine, then "The connection to the server
       * dropped" out of nowhere, and reconnecting fixes it because there is only one transport
       * again. On a local network, where a real drop is unlikely, that is all it ever was.
       *
       * So: only the current transport is listened to, and losing it is treated as transient
       * first. Five attempts over about fifteen seconds, and only then is it a failure worth a
       * screen.
       */
      const lost = () => {
        if (!current()) return; // an attempt that has been superseded (27.1)
        if (transportRef.current !== transport) return; // a connection we have already replaced
        if (retry >= RECONNECT_DELAYS.length) {
          setPhase((p) =>
            p.k === "ready"
              ? { k: "failed", address, message: "The connection to the server dropped." }
              : p
          );
          return;
        }
        setReconnecting(true);
        setTimeout(
          () => void connectToRef.current?.(address, name, retry + 1),
          RECONNECT_DELAYS[retry],
        );
      };
      void transport.closed.then(lost);

      /*
       * 22.10 — and asking, because waiting is not enough.
       *
       * `transport.closed` is the only thing that used to report a lost connection, and a server
       * that is *killed* never resolves it: the browser holds a peer connection whose other end
       * has stopped existing and says nothing about it for well over a minute — seventy seconds
       * measured, still green, still "Connected". The reconnect ladder below it is fine; nothing
       * was ever telling it to run.
       *
       * A ping is the cheapest question there is, and a failed one means the same thing as a
       * closed transport, so it goes down the same path. The interval is cleared when this
       * transport stops being the current one, which is what `lost` already knows how to check.
       */
      const beat = setInterval(() => {
        if (transportRef.current !== transport) {
          clearInterval(beat);
          return;
        }
        /*
         * Only while this device is somebody the server will answer.
         *
         * A revoked device keeps its page open and its transport alive — the unauthorised screen
         * needs it to ask for access again — and a ping from it is refused. Refusals are logged
         * (12.4), so pinging on regardless writes a warning into the server's log every eight
         * seconds for as long as the tab is open.
         */
        if (phaseRef.current?.k !== "ready") return;
        /*
         * With a deadline, because the failure being looked for does not produce an error.
         *
         * A request sent over a peer connection whose other end has stopped existing does not
         * reject — it waits, and so did the first version of this heartbeat: seventy seconds after
         * the server was killed the app was still green, now with a queue of pings behind it.
         * Nothing answers, so nothing is what has to be detected.
         */
        void Promise.race([
          client.call({ t: "ping" }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("no answer")), HEARTBEAT_TIMEOUT_MS)
          ),
        ]).catch((err) => {
          /*
           * A refusal is an answer — except for the one that says this device is nobody.
           *
           * The server saying no means it is there and the transport works, so treating that as a
           * lost connection turns a device it refuses into a reconnect loop: ping, refused,
           * "connection lost", redial, re-authenticate, refused, every few seconds.
           *
           * `unauthenticated` is the exception, and ignoring it was the other half of the same
           * mistake. It means the session is no longer one the server knows — a server restarted
           * onto a fresh database, a session dropped, anything that did not arrive as an
           * `access-revoked` event. The connection is fine and *this device* is not, and the
           * reconnect ladder is exactly the right response: it re-authenticates, fails honestly,
           * and lands on the screen that offers to ask for access. Without it the app sits on
           * "Connected" while every action fails.
           */
          if (err instanceof ServerRefusal && err.code !== "unauthenticated") return;
          clearInterval(beat);
          lost();
        });
      }, HEARTBEAT_MS);
      void transport.closed.then(() => clearInterval(beat));

      setReconnecting(false);
    } catch (err) {
      // 27.1 — an abandoned attempt fails in silence. Whatever went wrong with it went wrong with
      // a server nobody is waiting on any more.
      if (!current()) return;
      /*
       * Only a *reconnection* keeps trying.
       *
       * `retry === 0` is somebody pressing Connect, or the app booting against a stored address.
       * If that address is wrong — and after a server restart it is, because the certhash is new
       * — retrying it five times means half a minute of "Connecting…" before the form comes back,
       * to reach the same answer. 22.8 is about a transient loss of a connection that worked, not
       * about an address that never did.
       */
      if (retry > 0 && retry < RECONNECT_DELAYS.length) {
        setReconnecting(true);
        setTimeout(
          () => void connectToRef.current?.(address, name, retry + 1),
          RECONNECT_DELAYS[retry],
        );
        return;
      }
      setReconnecting(false);
      setPhase({ k: "failed", address, message: describe(err) });
    }
  }, [onEvent, refresh]);

  /*
   * `connectTo` calls itself on a delay, and a `useCallback` cannot name itself. The ref is
   * written on every render so a retry always uses the current closure rather than the one that
   * happened to be live when the connection dropped.
   */
  const connectToRef = useRef<typeof connectTo>(null);
  connectToRef.current = connectTo;
  phaseRef.current = phase;

  const claimAdmin = useCallback(async () => {
    const client = clientRef.current;
    if (!client || !("address" in phase)) return;
    try {
      const { outcome } = await client.claimAdmin();
      if (outcome === "admin-granted") {
        setPhase({
          k: "ready",
          address: phase.address,
          role: "admin",
          version: client.state!.version,
        });
        await client.subscribe();
        await refresh();
      } else {
        // 13.40 — the race was lost and the client asked instead, on the same connection.
        setPhase({
          k: "unauthorized",
          address: phase.address,
          offer: "request",
          asked: true,
        });
      }
    } catch (err) {
      setLastError(describe(err));
    }
  }, [phase, refresh]);

  const requestAccess = useCallback(async (role: AccessRole) => {
    const client = clientRef.current;
    if (!client || !("address" in phase)) return;
    try {
      await client.requestAccess(role);
      setPhase({
        k: "unauthorized",
        address: phase.address,
        offer: "request",
        asked: true,
      });
    } catch (err) {
      setLastError(describe(err));
    }
  }, [phase]);

  /**
   * While waiting, ask the server every few seconds whether the answer has arrived (25.33).
   *
   * `hello` is the cheapest thing the protocol has and needs no authorisation, which is what makes
   * it usable from a device that has none. Polling rather than a subscription because an
   * unauthorised device may not subscribe — the event that would carry this news is exactly the
   * kind of thing it is not allowed to hear.
   *
   * Three seconds. An admin approving a device is watching one screen while somebody watches the
   * other, so the wait is measured in how long it takes to say "done".
   */
  useEffect(() => {
    if (phase.k !== "unauthorized" || !phase.asked) return;
    const address = phase.address;
    let stopped = false;
    const id = setInterval(() => {
      const client = clientRef.current;
      if (!client) return;
      void client.hello()
        .then((hello) => {
          if (!stopped && hello.offer === "auth") setPhase({ k: "approved", address });
        })
        // A failed poll is not news. The server may be restarting, and saying so on a page whose
        // whole content is "wait" would be noise about the wrong thing.
        .catch(() => {});
    }, 3_000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [phase]);

  /**
   * 22.4, 27.1 — leave this server, and stop having anything to do with it.
   *
   * Closing the client resolves that transport's `closed`, which is the same signal a real drop
   * gives — so the reconnect ladder started, four hundred milliseconds later it redialled the
   * address that had just been abandoned, and on a LAN where that server is still running it
   * *succeeded*: the app came back on the connection somebody had just left, or announced that
   * connection as dropped over the top of the address they were typing. Reported as flakiness at
   * startup, with the giveaway that the message named the previous server.
   *
   * Superseding the attempt is what makes the closure expected rather than a loss. `transportRef`
   * goes with it, so nothing is left pointing at a connection that is deliberately over.
   */
  /**
   * Stop using this server — 22.6, and 27.57 for the half that was missing.
   *
   * Every caller means the same thing: Settings' "Disconnect from this server", and the connect
   * screen's "Use a different server" and "Cancel". So this cleared the *phase* and left the
   * address in device storage, which meant the connect screen appeared and one reload put the app
   * straight back on the server somebody had just left — the boot effect reads what is stored.
   *
   * `clearAddress` was written for this and called by nothing, which is how it surfaced: an
   * exported function with no callers is a question about the caller that should exist.
   */
  const forget = useCallback(() => {
    attemptRef.current++;
    transportRef.current = null;
    clientRef.current?.close();
    clientRef.current = null;
    clearAddress();
    setReconnecting(false);
    setSnapshot(undefined);
    setPhase({ k: "no-address" });
  }, []);

  // Reconnect on load if an address is already stored (22.3).
  const bootedRef = useRef(false);
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    // The desktop's settings live in a file, so they have to be in hand before anything reads the
    // stored address — otherwise the first render decides there is none and shows the setup screen
    // to somebody who set it up last week.
    void primeDeviceStorage().then(() => {
      /*
       * 27.23 — an invitation wins over what was stored, and is then gone.
       *
       * Wins, because scanning one is a deliberate act aimed at a particular server; a device that
       * was pointed somewhere else is being repointed on purpose. Gone, because the URL is not
       * where this app keeps state (21.19) and a fragment that survives is one that gets shared,
       * bookmarked, or re-applied by a reload after the address has been changed by hand.
       *
       * After `primeDeviceStorage`, because in the desktop window that call replaces the whole
       * in-memory settings map with the file's contents — a write before it is a write discarded.
       */
      const invited = invitedAddress();
      if (invited) {
        saveAddress(invited);
        clearInvitation();
      }
      const address = invited ?? loadAddress();
      setNameState(loadDeviceName());
      if (address) void connectTo(address, loadDeviceName());
      else setPhase({ k: "no-address" });
    });
  }, [connectTo]);

  useEffect(() => {
    if (phase.k === "ready") void refresh();
  }, [month, phase.k, refresh]);

  /**
   * 12.6 — anything the app throws outside a render, reported to the server.
   *
   * The sender goes through a ref rather than being captured, because these handlers are installed
   * once and the client is replaced on every reconnect. Capturing would report to the connection
   * that existed when the page loaded, which by then is usually the one that failed.
   */
  useEffect(() =>
    installGlobalHandlers((r) => {
      const send = senderRef.current;
      return send ? send(r) : Promise.reject(new Error("not connected"));
    }), []);

  // 3.4 — a running timer counts up between snapshots, from the start instant the server gave.
  useEffect(() => {
    if (!snapshot?.timer.active) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [snapshot?.timer.active]);

  const value = useMemo<Store>(() => ({
    phase,
    ...(snapshot ? { snapshot } : {}),
    month,
    tick,
    setMonth,
    call,
    refresh,
    connectTo,
    claimAdmin,
    requestAccess,
    forget,
    deviceName,
    setDeviceName: (n: string) => {
      saveDeviceName(n);
      setNameState(n);
    },
    reconnecting,
    ...(lastError ? { lastError } : {}),
    clearError: () => setLastError(undefined),
    ...(prompt ? { prompt } : {}),
    acknowledgePrompt: () => {
      stopTuneRef.current?.();
      stopTuneRef.current = undefined;
    },
    dismissPrompt: () => {
      // 25.39 — "until the prompt is answered or dismissed". Both routes end here: `WorkNote`
      // calls `onClose` after saving as well as on cancel.
      stopTuneRef.current?.();
      stopTuneRef.current = undefined;
      setPrompt(undefined);
    },
  }), [
    phase,
    snapshot,
    month,
    tick,
    call,
    refresh,
    connectTo,
    claimAdmin,
    requestAccess,
    forget,
    deviceName,
    /*
     * `reconnecting` was missing from this list.
     *
     * It is in the object above, so the type checker was satisfied and the flag was set exactly
     * when it should have been — and the memo never recomputed, so the context value stayed
     * identical and no consumer re-rendered. 22.8's amber dot has never once appeared: the app
     * said "Connected" from the moment a connection dropped until something else happened to
     * change `phase`, which on a server that has simply stopped is never.
     *
     * A dependency list is a claim about which values the object depends on, and nothing in the
     * language checks it. This one is now covered by a check that kills the server and looks.
     */
    reconnecting,
    lastError,
    prompt,
  ]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/**
 * Who signs for this device.
 *
 * In the desktop window, the shell — its key is a file the operating system protects and the page
 * never holds it. In a tab, a non-extractable `CryptoKey` in IndexedDB. And where storage is
 * blocked entirely, a key in memory: a private window should still be able to connect and work, it
 * just becomes a new device each time, which is honest — nothing was kept, so nothing is
 * remembered.
 */
function chooseSigner(): Signer {
  if (isDesktop()) return desktopSigner();
  try {
    if (typeof indexedDB !== "undefined") {
      return webCryptoSigner(indexedDbKeyStore());
    }
  } catch {
    // Blocked by the browser's storage settings.
  }
  return webCryptoSigner(memoryKeyStore());
}

function describe(err: unknown): string {
  // What `AbortSignal.timeout` throws. Its own message is "signal timed out", which says nothing
  // about what was being attempted or what to do about it.
  if (err instanceof DOMException && err.name === "TimeoutError") {
    return "No answer from that address. Check the server is running and that the address is " +
      "the one it printed — a server prints a new one each time its data directory is new.";
  }
  if (err instanceof ServerRefusal) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
