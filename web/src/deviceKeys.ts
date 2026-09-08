/**
 * The device key, kept in IndexedDB (13.3).
 *
 * **IndexedDB rather than `localStorage` for a reason beyond capacity.** A `CryptoKey` is
 * structured-cloneable, so it can be stored *as a key* rather than as bytes — which is what keeps a
 * non-extractable key non-extractable across a reload. `localStorage` holds strings, so using it
 * would mean exporting the private key, and an exportable key is one an XSS can steal.
 *
 * This lives in the web package rather than in `shared/` because it is a browser API, and `shared/`
 * claims to import no runtime.
 */

import type { DeviceKeyStore } from "@worklog/shared/client";

const DB_NAME = "worklog";
const STORE = "device";
const KEY = "keypair";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then((db) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = body(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    })
  );
}

export function indexedDbKeyStore(): DeviceKeyStore {
  return {
    load: () => run<CryptoKeyPair | undefined>("readonly", (s) => s.get(KEY)),
    save: (pair) => run<unknown>("readwrite", (s) => s.put(pair, KEY)).then(() => {}),
    clear: () => run<unknown>("readwrite", (s) => s.delete(KEY)).then(() => {}),
  };
}

// ------------------------------------------------------------------ the server address

/**
 * 22.3, 22.4 — the address lives in device-local storage, and never in the URL.
 *
 * `localStorage` is right for this one: it is a short string, it must survive a reload, and unlike
 * the key there is nothing to protect — the address is a capability, but it is a capability this
 * device already holds by definition.
 */
const ADDRESS_KEY = "worklog.serverAddress";
const NAME_KEY = "worklog.deviceName";

export function loadAddress(): string | null {
  return localStorage.getItem(ADDRESS_KEY);
}

export function saveAddress(address: string): void {
  localStorage.setItem(ADDRESS_KEY, address.trim());
}

export function clearAddress(): void {
  localStorage.removeItem(ADDRESS_KEY);
}

export function loadDeviceName(): string {
  return localStorage.getItem(NAME_KEY) ?? guessDeviceName();
}

export function saveDeviceName(name: string): void {
  localStorage.setItem(NAME_KEY, name.trim());
}

/** A starting point for the name field, which the person can and should change (13.12). */
function guessDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android phone";
  if (/Macintosh/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(ua)) return "Linux PC";
  return "This device";
}

/**
 * 22.9 — a malformed address is a configuration mistake, not a connection failure.
 *
 * KPS addresses are `<ip>:<port>:<certhash>`. Telling someone "could not connect" when they pasted
 * half an address sends them looking at their network.
 */
export function addressProblem(address: string): string | null {
  const trimmed = address.trim();
  if (!trimmed) return "Paste the address the server printed when it started.";
  const parts = trimmed.split(":");
  if (parts.length !== 3) {
    return "An address looks like 192.168.1.5:41108:uEiA… — three parts separated by colons.";
  }
  const [host, port, certhash] = parts as [string, string, string];
  if (!host) return "The address is missing its host.";
  const portNumber = Number(port);
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
    return `“${port}” is not a port number.`;
  }
  if (!certhash.startsWith("uEi")) {
    return "The last part should be the certificate hash the server printed, starting with uEi.";
  }
  return null;
}
