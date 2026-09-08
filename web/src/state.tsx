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
import { desktopSigner, isDesktop, primeDeviceStorage } from "./desktop.ts";
import {
  describeError,
  flushQueue,
  installGlobalHandlers,
  report,
  type Sender,
} from "./errorReporting.ts";
import {
  indexedDbKeyStore,
  loadAddress,
  loadDeviceName,
  saveAddress,
  saveDeviceName,
} from "./deviceKeys.ts";

/** 22.7 — the four states a person can be in, each with something different to do about it. */
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
  clearError(): void;
  /** 5.16, 5.17 — set when the server fires a prompt; cleared when it is answered or dismissed. */
  prompt?: { id: string; firedAt: number };
  dismissPrompt(): void;
}

const Ctx = createContext<Store | null>(null);

export function useStore(): Store {
  const store = useContext(Ctx);
  if (!store) throw new Error("useStore outside a StoreProvider");
  return store;
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>(() =>
    loadAddress() ? { k: "connecting", address: loadAddress()! } : { k: "no-address" }
  );
  const [snapshot, setSnapshot] = useState<SnapshotResult>();
  const [month, setMonth] = useState(() => monthOf(today()));
  const [deviceName, setNameState] = useState(() => loadDeviceName());
  const [lastError, setLastError] = useState<string>();
  const [tick, setTick] = useState(0);
  const [prompt, setPrompt] = useState<{ id: string; firedAt: number }>();

  const clientRef = useRef<WorklogClient>(null);
  const senderRef = useRef<Sender>(null);
  const monthRef = useRef(month);
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
      setPrompt({ id: event.id, firedAt: event.firedAt });
      chime();
      return;
    }
    void refresh();
  }, [refresh]);

  const connectTo = useCallback(async (address: string, name: string) => {
    saveAddress(address);
    saveDeviceName(name);
    setNameState(name);
    setPhase({ k: "connecting", address });
    setSnapshot(undefined);

    try {
      const transport = await connect(address);
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

      void transport.closed.then(() => {
        setPhase((p) =>
          p.k === "ready"
            ? {
              k: "failed",
              address,
              message: "The connection to the server dropped.",
            }
            : p
        );
      });
    } catch (err) {
      setPhase({ k: "failed", address, message: describe(err) });
    }
  }, [onEvent, refresh]);

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

  const forget = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
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
      const address = loadAddress();
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
    ...(lastError ? { lastError } : {}),
    clearError: () => setLastError(undefined),
    ...(prompt ? { prompt } : {}),
    dismissPrompt: () => setPrompt(undefined),
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

/**
 * Two soft notes, synthesised rather than fetched.
 *
 * A prompt should be audible without the page having downloaded an asset it might not have — and a
 * bundle that ships a sound file to say "hello?" is a bundle carrying a sound file. Failing
 * silently is fine: a muted tab is a preference, not an error.
 */
function chime(): void {
  try {
    const Ctx = globalThis.AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const audio = new Ctx();
    const gain = audio.createGain();
    gain.connect(audio.destination);
    gain.gain.setValueAtTime(0.0001, audio.currentTime);
    for (const [i, hz] of [660, 880].entries()) {
      const at = audio.currentTime + i * 0.16;
      const osc = audio.createOscillator();
      osc.type = "sine";
      osc.frequency.value = hz;
      osc.connect(gain);
      osc.start(at);
      osc.stop(at + 0.15);
    }
    gain.gain.exponentialRampToValueAtTime(0.12, audio.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.34);
    setTimeout(() => void audio.close().catch(() => {}), 900);
  } catch {
    // No audio permission, no audio context, a muted tab. None of these is worth reporting.
  }
}

function describe(err: unknown): string {
  if (err instanceof ServerRefusal) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}
