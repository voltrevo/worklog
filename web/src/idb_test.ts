/**
 * There is exactly one `indexedDB.open` call in the frontend.
 *
 * A grep rather than a unit test, because the bug this guards against is not something any
 * signature can express: two modules named the same database and asked for different versions of
 * it, and each was internally consistent. `deviceKeys.ts` opened `"worklog"` at 1 and
 * `localAudio.ts` opened `"worklog"` at 2, so once the audio store existed, the device key store
 * could never be opened again — `VersionError`, and a device that has forgotten who it is.
 *
 * Neither `deno check` nor `tsc` can see that, and no runtime test in this suite has an IndexedDB
 * to see it in. What is checkable is the shape that made it possible: more than one caller of
 * `indexedDB.open`.
 */

import { assertEquals } from "jsr:@std/assert@^1";

const SRC = new URL("./", import.meta.url).pathname;

async function sourceFiles(): Promise<string[]> {
  const out: string[] = [];
  for await (const entry of Deno.readDir(SRC)) {
    if (!entry.isFile) continue;
    if (!/\.tsx?$/.test(entry.name) || entry.name.endsWith("_test.ts")) {
      continue;
    }
    out.push(entry.name);
  }
  for await (const entry of Deno.readDir(`${SRC}screens`)) {
    if (entry.isFile && /\.tsx?$/.test(entry.name)) {
      out.push(`screens/${entry.name}`);
    }
  }
  return out.sort();
}

// `--allow-read=.` on the task is the floor; these narrow it to the directory they read, so a
// guard about source files cannot start reading anything else.
const READS_SOURCES: Pick<Deno.TestDefinition, "permissions"> = {
  permissions: { read: ["./web/src"] },
};

Deno.test({
  name: "only one module opens the database, so only one decides its version",
  ...READS_SOURCES,
  async fn() {
    const openers: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await Deno.readTextFile(`${SRC}${file}`);
      // The comments in `idb.ts` mention the call by name; the code is what matters.
      const calls = text.match(/indexedDB\.open\s*\(/g);
      if (calls) openers.push(`${file} (${calls.length})`);
    }
    assertEquals(
      openers,
      ["idb.ts (1)"],
      "a second opener means a second opinion about the version, and the loser is locked out",
    );
  },
});

Deno.test({
  name: "every store the frontend uses is one `idb.ts` creates",
  ...READS_SOURCES,
  async fn() {
    // A transaction naming a store that no upgrade created throws `NotFoundError` at the first use,
    // which in this app is at startup on a fresh profile -- the least recoverable moment there is.
    const declared = await Deno.readTextFile(`${SRC}idb.ts`);
    const stores = /^export const STORES = \[(.*?)\]/ms.exec(declared)?.[1] ??
      "";
    const known = [...stores.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
    assertEquals(known, ["audio", "device"]);

    // The call sites pass a `STORE` constant rather than a literal, so looking for `run<T>("audio"`
    // finds nothing and the check would pass by never running. What is written literally is the
    // constant's declaration, so that is what to read.
    let checked = 0;
    for (const file of await sourceFiles()) {
      if (file === "idb.ts") continue;
      const text = await Deno.readTextFile(`${SRC}${file}`);
      for (const [, name] of text.matchAll(/^const STORE = "([^"]+)";$/gm)) {
        checked++;
        assertEquals(
          known.includes(name!),
          true,
          `${file} names an undeclared store ${name}`,
        );
      }
    }
    assertEquals(
      checked,
      2,
      "deviceKeys.ts and localAudio.ts each name one; found a different set",
    );
  },
});
