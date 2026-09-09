/**
 * The schema, as an append-only list of migrations (17.8).
 *
 * **Never edit a migration that has shipped.** Add another one. The runner records which ids it has
 * applied and applies the rest in order, so an edited migration is silently skipped on every
 * database that already ran it — the worst possible failure, because it works on yours.
 *
 * Two conventions the tables lean on:
 *
 * - **`STRICT` everywhere** (17.9). Without it SQLite will happily store the string `"eight"` in an
 *   INTEGER column, and a duration that is secretly text is the kind of thing that surfaces on an
 *   invoice.
 * - **A date is `TEXT` in `YYYY-MM-DD`** (17.13), never an epoch. Every question asked of it is a
 *   calendar question, lexicographic order is date order, and `substr(date, 1, 7)` is the month.
 */

export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "initial",
    sql: `
      -- ---------------------------------------------------------------- work
      CREATE TABLE work_entry (
        id           TEXT    PRIMARY KEY,
        -- 2.18, 17.13. Fixed when the timer started, from the starting device's calendar.
        date         TEXT    NOT NULL,
        duration_ms  INTEGER NOT NULL CHECK (duration_ms >= 0),
        billing_tag  TEXT    NOT NULL,
        -- 2.8 vs 2.9: both present for a timed entry, both absent for a duration-only one. The
        -- CHECK is what makes 17.1 -- "preserve whether an entry is timed" -- a property of the
        -- table rather than a convention the writers agree to keep.
        started_at   INTEGER,
        ended_at     INTEGER,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        CHECK ((started_at IS NULL) = (ended_at IS NULL)),
        CHECK (ended_at IS NULL OR ended_at >= started_at)
      ) STRICT;
      CREATE INDEX work_entry_date ON work_entry (date);

      -- 2.2 -- at most one active timer, globally. The primary key does the enforcing: there is no
      -- second row to race for, so two devices starting at once resolve in SQLite rather than in
      -- whichever handler happened to check first (1.10).
      CREATE TABLE active_timer (
        id          INTEGER PRIMARY KEY CHECK (id = 1),
        started_at  INTEGER NOT NULL,
        date        TEXT    NOT NULL,
        billing_tag TEXT    NOT NULL
      ) STRICT;

      -- ------------------------------------------------------- work-detail notes
      -- 17.10 -- the audio lives on disk and is referenced from here.
      CREATE TABLE work_note (
        id          TEXT    PRIMARY KEY,
        created_at  INTEGER NOT NULL,
        body        TEXT,
        audio_path  TEXT,
        audio_ms    INTEGER,
        -- Whether this answered a prompt (5.6) or was written unprompted (5.4, 5.5).
        prompted    INTEGER NOT NULL DEFAULT 0 CHECK (prompted IN (0, 1)),
        CHECK (body IS NOT NULL OR audio_path IS NOT NULL)
      ) STRICT;
      CREATE INDEX work_note_created ON work_note (created_at);

      -- ------------------------------------------------------------- invoices
      -- 17.5 -- the snapshot is stored beside the mutable work rather than derived from it, which
      -- is what makes 11.8 true: editing an entry cannot reach through into an issued invoice.
      -- 17.11 -- the PDF is a path, not a blob.
      CREATE TABLE invoice (
        id            TEXT    PRIMARY KEY,
        period        TEXT    NOT NULL,
        number        TEXT    NOT NULL,
        status        TEXT    NOT NULL CHECK (status IN ('draft', 'issued', 'paid')),
        draft_json    TEXT    NOT NULL,
        snapshot_json TEXT,
        pdf_path      TEXT,
        issued_at     INTEGER,
        paid_at       INTEGER,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        CHECK ((status = 'draft') = (issued_at IS NULL)),
        CHECK (status = 'paid' OR paid_at IS NULL)
      ) STRICT;

      -- 11.20 and 9.16 as constraints rather than as checks in a handler. A partial unique index
      -- ignores drafts entirely, which is 11.22, and frees the period the moment an issuance is
      -- reverted, which is 11.21.
      CREATE UNIQUE INDEX invoice_one_committed_period
        ON invoice (period) WHERE status IN ('issued', 'paid');
      CREATE UNIQUE INDEX invoice_one_committed_number
        ON invoice (number) WHERE status IN ('issued', 'paid');

      -- --------------------------------------------------------------- access
      -- 13.29. The private key never arrives here (13.4); this is the public half and the role an
      -- admin granted (13.28). The name is a display string and nothing more (13.38).
      CREATE TABLE device (
        public_key    BLOB    PRIMARY KEY,
        name          TEXT    NOT NULL,
        role          TEXT    NOT NULL CHECK (role IN ('read', 'write', 'admin')),
        authorized_at INTEGER NOT NULL,
        last_seen_at  INTEGER
      ) STRICT;

      CREATE TABLE access_request (
        public_key     BLOB    PRIMARY KEY,
        name           TEXT    NOT NULL,
        requested_role TEXT    NOT NULL CHECK (requested_role IN ('read', 'write', 'admin')),
        requested_at   INTEGER NOT NULL
      ) STRICT;

      -- ------------------------------------------------------------------ logs
      -- 12.1-12.3. 12.13's retention is a delete against \`at\`, which is why it is indexed.
      CREATE TABLE log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        at           INTEGER NOT NULL,
        level        TEXT    NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
        source       TEXT    NOT NULL,
        message      TEXT    NOT NULL,
        context_json TEXT,
        -- 12.7 -- which authenticated device reported this, where one did.
        device_key   BLOB
      ) STRICT;
      CREATE INDEX log_at ON log (at);

      -- ---------------------------------------------------------------- config
      -- 9.1-9.3 and 6.1: everything the user configures, as JSON under a key. Deliberately not a
      -- column per setting -- these change shape as the product does, and a migration per field
      -- would be all migration and no schema.
      CREATE TABLE config (
        key        TEXT    PRIMARY KEY,
        value_json TEXT    NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;

      -- 6.19, 6.20 -- pacing only. A separate table from work_entry precisely so that nothing
      -- reporting or billing can pick these up by accident.
      CREATE TABLE pacing_override (
        date       TEXT PRIMARY KEY,
        start_time TEXT,
        end_time   TEXT,
        reason     TEXT,
        CHECK ((start_time IS NULL) = (end_time IS NULL))
      ) STRICT;

      -- 6.6 -- the holiday feed, cached server-side, one row per region and year.
      CREATE TABLE holiday_cache (
        region       TEXT    NOT NULL,
        year         INTEGER NOT NULL,
        fetched_at   INTEGER NOT NULL,
        payload_json TEXT    NOT NULL,
        PRIMARY KEY (region, year)
      ) STRICT;
    `,
  },
  {
    id: 2,
    name: "freeze-invoice-config",
    sql: `
      -- 24.30, completed. Issuing froze the *numbers* in \`snapshot_json\`, and every download
      -- reads the PDF file written at that moment — but if that file is lost the server falls
      -- back to re-rendering, and the letterhead, payment details and tax label then came from
      -- the configuration as it stands now. A frozen document that quietly changes is the one
      -- thing freezing was for.
      --
      -- Its own column rather than a field inside \`snapshot_json\`, because the snapshot is sent
      -- to every authorised device and this holds the payment block. \`SELECT\` in
      -- \`invoices.ts\` names its columns, so nothing that reads an invoice for the wire can pick
      -- this up by accident; the one reader is \`frozenConfigFor\`.
      ALTER TABLE invoice ADD COLUMN config_json TEXT;
    `,
  },
];
