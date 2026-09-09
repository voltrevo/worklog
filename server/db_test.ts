import { assertEquals, assertThrows } from "jsr:@std/assert@^1";
import { appliedMigrations, type Db, migrate, open, transact } from "./db.ts";
import { MIGRATIONS } from "./migrations.ts";

function fresh(): Db {
  return open({ path: ":memory:" });
}

Deno.test("a fresh database runs every migration, and a second call runs none", () => {
  const db = fresh();
  assertEquals(appliedMigrations(db), MIGRATIONS.map((m) => m.id));
  assertEquals(migrate(db), [], "migrations are not re-run");
  db.close();
});

Deno.test("a database ahead of this build is left alone rather than refused", () => {
  // An old binary meeting a new database. Refusing to start would be worse than serving a schema
  // with a column this build does not read.
  const db = fresh();
  db.prepare("INSERT INTO schema_migration (id, name, applied_at) VALUES (?, ?, ?)")
    .run(9999, "from-the-future", Date.now());
  assertEquals(migrate(db), []);
  db.close();
});

Deno.test("a failing migration rolls back and leaves nothing behind", () => {
  const db = fresh();
  assertThrows(
    () =>
      // A number no real migration will reach. It was `2`, which stopped failing the moment
      // there *was* a migration 2: `fresh()` had already applied it, so this one was skipped as
      // done and never ran. A test whose fixture collides with production data silently inverts.
      migrate(db, [{
        id: 90_002,
        name: "bad",
        sql:
          "CREATE TABLE ok_so_far (x INTEGER) STRICT; CREATE TABLE ok_so_far (x INTEGER) STRICT;",
      }]),
    Error,
    "migration 90002 (bad) failed",
  );
  assertEquals(appliedMigrations(db).includes(90_002), false);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok_so_far'").all();
  assertEquals(tables.length, 0, "the half that succeeded was rolled back too");
  db.close();
});

Deno.test("STRICT means a duration cannot secretly be text", () => {
  const db = fresh();
  assertThrows(() =>
    db.prepare(
      "INSERT INTO work_entry (id, date, duration_ms, billing_tag, created_at, updated_at)" +
        " VALUES ('a', '2026-09-08', 'eight hours', 'tag', 0, 0)",
    ).run()
  );
  db.close();
});

Deno.test("17.1 -- an entry is timed or duration-only, and the table will not accept a half", () => {
  const db = fresh();
  const insert = (started: number | null, ended: number | null) =>
    db.prepare(
      "INSERT INTO work_entry (id, date, duration_ms, billing_tag, started_at, ended_at," +
        " created_at, updated_at) VALUES (?, '2026-09-08', 3600000, 'tag', ?, ?, 0, 0)",
    ).run(crypto.randomUUID(), started, ended);

  insert(null, null); // duration-only (2.9)
  insert(1_000, 4_600_000); // timed (2.8)
  assertThrows(() => insert(1_000, null), Error, "CHECK");
  assertThrows(() => insert(null, 1_000), Error, "CHECK");
  db.close();
});

Deno.test("a timed entry cannot end before it started", () => {
  const db = fresh();
  assertThrows(
    () =>
      db.prepare(
        "INSERT INTO work_entry (id, date, duration_ms, billing_tag, started_at, ended_at," +
          " created_at, updated_at) VALUES ('x', '2026-09-08', 0, 'tag', 5000, 1000, 0, 0)",
      ).run(),
    Error,
    "CHECK",
  );
  db.close();
});

Deno.test("2.2 -- there is nowhere to put a second active timer", () => {
  const db = fresh();
  const start = (id: number) =>
    db.prepare("INSERT INTO active_timer (id, started_at, date, billing_tag) VALUES (?, ?, ?, ?)")
      .run(id, Date.now(), "2026-09-08", "Product Development");

  start(1);
  assertThrows(() => start(2), Error, "CHECK", "the id is pinned to 1");
  assertThrows(() => start(1), Error, "UNIQUE", "and there is only one of it");
  db.close();
});

Deno.test("11.20 -- the database itself refuses a second issued invoice for a month", () => {
  const db = fresh();
  const put = (id: string, period: string, number: string, status: string) =>
    db.prepare(
      "INSERT INTO invoice (id, period, number, status, draft_json, issued_at, created_at," +
        " updated_at) VALUES (?, ?, ?, ?, '{}', ?, 0, 0)",
    ).run(id, period, number, status, status === "draft" ? null : 1);

  put("a", "2026-09", "INV-2026-09", "issued");
  assertThrows(
    () => put("b", "2026-09", "INV-2026-09-B", "issued"),
    Error,
    "UNIQUE",
    "11.19/11.20 -- one committed invoice per period",
  );
  assertThrows(
    () => put("c", "2026-10", "INV-2026-09", "paid"),
    Error,
    "UNIQUE",
    "9.16 -- and one committed invoice per number",
  );

  // 11.22 -- drafts are invisible to both indexes, however many of them there are.
  put("d", "2026-09", "INV-2026-09", "draft");
  put("e", "2026-09", "INV-2026-09", "draft");
  db.close();
});

Deno.test("11.21 -- reverting an issuance frees the period for another", () => {
  const db = fresh();
  db.prepare(
    "INSERT INTO invoice (id, period, number, status, draft_json, issued_at, created_at," +
      " updated_at) VALUES ('a', '2026-09', 'INV-2026-09', 'issued', '{}', 1, 0, 0)",
  ).run();
  db.prepare("UPDATE invoice SET status = 'draft', issued_at = NULL WHERE id = 'a'").run();
  db.prepare(
    "INSERT INTO invoice (id, period, number, status, draft_json, issued_at, created_at," +
      " updated_at) VALUES ('b', '2026-09', 'INV-2026-09R', 'issued', '{}', 2, 0, 0)",
  ).run();
  db.close();
});

Deno.test("an invoice's status and its timestamps cannot disagree", () => {
  const db = fresh();
  // A draft with an issuance time, or an issued invoice without one, are both nonsense (11.10).
  assertThrows(
    () =>
      db.prepare(
        "INSERT INTO invoice (id, period, number, status, draft_json, issued_at, created_at," +
          " updated_at) VALUES ('a', '2026-09', 'n', 'draft', '{}', 5, 0, 0)",
      ).run(),
    Error,
    "CHECK",
  );
  assertThrows(
    () =>
      db.prepare(
        "INSERT INTO invoice (id, period, number, status, draft_json, issued_at, created_at," +
          " updated_at) VALUES ('b', '2026-09', 'n', 'issued', '{}', NULL, 0, 0)",
      ).run(),
    Error,
    "CHECK",
  );
  db.close();
});

Deno.test("a work note has to say something, in text or in audio", () => {
  const db = fresh();
  assertThrows(
    () => db.prepare("INSERT INTO work_note (id, created_at) VALUES ('a', 0)").run(),
    Error,
    "CHECK",
  );
  db.prepare("INSERT INTO work_note (id, created_at, body) VALUES ('b', 0, 'wrote the parser')")
    .run();
  db.prepare("INSERT INTO work_note (id, created_at, audio_path) VALUES ('c', 0, 'notes/c.opus')")
    .run();
  db.close();
});

Deno.test("a role has to be one of the three that are defined", () => {
  const db = fresh();
  const key = new Uint8Array([1, 2, 3]);
  assertThrows(
    () =>
      db.prepare("INSERT INTO device (public_key, name, role, authorized_at) VALUES (?,?,?,?)")
        .run(key, "MacBook Pro", "superuser", 0),
    Error,
    "CHECK",
  );
  for (const [i, role] of ["read", "write", "admin"].entries()) {
    db.prepare("INSERT INTO device (public_key, name, role, authorized_at) VALUES (?,?,?,?)")
      .run(new Uint8Array([i]), `dev-${role}`, role, 0);
  }
  db.close();
});

Deno.test("transact rolls back on a throw and nests without a second BEGIN", () => {
  const db = fresh();
  db.exec("CREATE TABLE t (x INTEGER) STRICT");
  const count = () => Number((db.prepare("SELECT count(*) c FROM t").get() as { c: number }).c);

  transact(db, () => {
    db.prepare("INSERT INTO t (x) VALUES (1)").run();
    transact(db, () => db.prepare("INSERT INTO t (x) VALUES (2)").run());
  });
  assertEquals(count(), 2);

  assertThrows(() =>
    transact(db, () => {
      db.prepare("INSERT INTO t (x) VALUES (3)").run();
      throw new Error("no");
    })
  );
  assertEquals(count(), 2, "the insert before the throw did not survive");
  db.close();
});

Deno.test({
  name:
    "17.8 -- a migration added later runs against an existing database, once, without touching what is there",
  permissions: { read: ["."], write: [".tmp"] },
  async fn() {
    /*
     * The case every release is, and the only one that can lose data.
     *
     * "A fresh database runs every migration" and "a second call runs none" are both above, and
     * between them they miss it: they never have an *old file* meet a *new list*. I found the gap
     * by trying to make the persistence test fail — I added a destructive migration and it changed
     * nothing, because on a fresh database it ran before there was anything to destroy. A
     * mutation that cannot fail the test is a test that is not making the claim.
     *
     * On disk rather than `:memory:`, because "the same database, later" is the whole subject and
     * an in-memory one does not survive being closed.
     */
    const dir = await Deno.makeTempDir({ dir: ".tmp", prefix: "migrate-" });
    const path = `${dir}/m.sqlite`;

    const first = open({ path });
    first.prepare(
      "INSERT INTO work_entry (id, date, duration_ms, billing_tag, created_at, updated_at)" +
        " VALUES (?, ?, ?, ?, ?, ?)",
    ).run("e1", "2026-09-09", 3_600_000, "Product Development", 1, 1);
    first.close();

    // The next release. `later` is observable, and `MIGRATIONS` re-running would throw on its own
    // `CREATE TABLE` — so "ran exactly the new one" is checked by the return value *and* by the
    // fact that this call does not blow up.
    const later = {
      id: 10_001,
      name: "test-added-later",
      sql: `CREATE TABLE arrived_later (id TEXT PRIMARY KEY) STRICT;`,
    };
    const second = open({ path, migrations: [...MIGRATIONS, later] });

    assertEquals(
      appliedMigrations(second).includes(later.id),
      true,
      "the new migration did not run",
    );
    assertEquals(
      second.prepare("SELECT count(*) AS n FROM arrived_later").get(),
      { n: 0 },
      "the new migration ran but did not take effect",
    );
    // And the row that was already there is still there, unchanged.
    assertEquals(
      second.prepare("SELECT id, billing_tag, duration_ms FROM work_entry").all(),
      [{ id: "e1", billing_tag: "Product Development", duration_ms: 3_600_000 }],
    );
    // Once: a third open with the same list adds nothing.
    assertEquals(migrate(second, [...MIGRATIONS, later]), []);
    second.close();

    await Deno.remove(dir, { recursive: true });
  },
});
