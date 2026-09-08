/**
 * The one IndexedDB database this frontend has, and the one place that knows its version.
 *
 * **Two modules used to open it independently.** `deviceKeys.ts` opened `"worklog"` at version 1
 * and `localAudio.ts` opened `"worklog"` at version 2 — the same database, because they had the
 * same name. IndexedDB will not open an existing database at a *lower* version, so the moment
 * anything touched the audio store, every later `deviceKeys` open failed with
 * `VersionError: The requested version (1) is less than the existing version (2)`.
 *
 * What that cost is out of proportion to the typo. The device key lives in that store, so a device
 * that cannot open it cannot prove who it is: it falls back to the connect screen and appears to
 * the server as a *new* device, needing an admin to approve it all over again (13.11). Play the
 * loop file once and reload, and the phone has forgotten itself.
 *
 * Nothing caught it for a long time because it needs a *second* reload of the same browser profile
 * — the first one still finds the database at version 1. The screenshot harness reloaded the phone
 * exactly once until a run needed two.
 *
 * So the rule this file exists to enforce: **there is one `indexedDB.open` call in the frontend.**
 * `web/src/idb_test.ts` asserts that by counting them, because the failure mode is two callers
 * silently disagreeing and no type can see it.
 */

const DB_NAME = "worklog";

/**
 * Every store, created together whatever version we are upgrading from.
 *
 * A store is added by putting its name here and bumping `VERSION`. Creating them all in one
 * `onupgradeneeded` — rather than one branch per version step — means an upgrade from *any* older
 * version arrives at the same shape, which matters because the versions in the wild are 1 and 2 and
 * nobody kept a record of which browsers have which.
 */
export const STORES = ["device", "audio"] as const;

/**
 * 2 rather than 3: version 2 already creates both stores, so a browser sitting at 2 is correct
 * and must not be forced through a pointless upgrade. A browser at 1 upgrades and gains `audio`.
 */
const VERSION = 2;

export function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!req.result.objectStoreNames.contains(store)) {
          req.result.createObjectStore(store);
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** One request in one transaction, with the connection closed after it. */
export function run<T>(
  store: (typeof STORES)[number],
  mode: IDBTransactionMode,
  body: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then((db) =>
    new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const req = body(tx.objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => db.close();
    })
  );
}
