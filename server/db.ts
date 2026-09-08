/**
 * Opening the database and bringing it up to date.
 *
 * `node:sqlite` rather than an FFI binding: it ships with Deno, so the server has no native
 * dependency of its own and `deno run` is the whole install. `DatabaseSync` is synchronous, which
 * suits a single-writer server — the handlers are short, and the alternative is an async layer over
 * calls that never block on anything but the disk.
 */

import { DatabaseSync } from "node:sqlite";
import { type Migration, MIGRATIONS } from "./migrations.ts";

export type Db = DatabaseSync;

export interface OpenOptions {
  /** `":memory:"` for tests. */
  path: string;
  /** Applied after opening; used by tests that want to watch a half-migrated database. */
  migrations?: readonly Migration[];
}

/**
 * Open, configure and migrate.
 *
 * `foreign_keys` is on because SQLite's default of off is a trap, and `journal_mode = WAL` because
 * a reader must not block the writer — the log viewer reads while the timer writes.
 */
export function open(opts: OpenOptions): Db {
  const db = new DatabaseSync(opts.path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  if (opts.path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  migrate(db, opts.migrations ?? MIGRATIONS);
  return db;
}

/** Which migration ids this database has already run. */
export function appliedMigrations(db: Db): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migration (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL,
      applied_at INTEGER NOT NULL
    ) STRICT
  `);
  return db.prepare("SELECT id FROM schema_migration ORDER BY id")
    .all()
    .map((r) => Number((r as { id: number }).id));
}

/**
 * Apply every migration this build knows and the database has not run, in id order.
 *
 * Each one is its own transaction, so a failure half way through a list leaves the earlier ones
 * applied and recorded rather than rolling back work that succeeded. A database ahead of this build
 * — an id recorded that this build does not have — is left alone rather than treated as an error:
 * that is an old binary meeting a new database, and refusing to start would be worse than serving
 * a schema with a column it does not read.
 */
export function migrate(db: Db, migrations: readonly Migration[] = MIGRATIONS): number[] {
  const done = new Set(appliedMigrations(db));
  const ran: number[] = [];

  for (const m of [...migrations].sort((a, b) => a.id - b.id)) {
    if (done.has(m.id)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      db.prepare("INSERT INTO schema_migration (id, name, applied_at) VALUES (?, ?, ?)")
        .run(m.id, m.name, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.id} (${m.name}) failed: ${(err as Error).message}`, {
        cause: err,
      });
    }
    ran.push(m.id);
  }
  return ran;
}

/** Run `body` in a transaction, rolling back if it throws. Nested calls reuse the outer one. */
export function transact<T>(db: Db, body: () => T): T {
  const nested = db.isTransaction;
  if (!nested) db.exec("BEGIN");
  try {
    const out = body();
    if (!nested) db.exec("COMMIT");
    return out;
  } catch (err) {
    if (!nested) db.exec("ROLLBACK");
    throw err;
  }
}
