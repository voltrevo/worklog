/**
 * User configuration, as JSON under a key.
 *
 * **Nothing here has a default that is somebody's real detail.** 9.4 and 9.5 forbid personal or
 * financial information reaching source, fixtures or defaults, so the invoice defaults below are
 * empty strings and zeroes: an unconfigured invoice is visibly unconfigured (9.9) rather than
 * quietly plausible. The pacing defaults are the only ones with real values, because a nine-to-five
 * week and a NSW region are settings rather than secrets.
 */

import type { Instant, PacingConfig } from "@worklog/shared/types";
import { defaultSchedule } from "@worklog/shared/schedule";
import type { Db } from "./db.ts";
import { Refused } from "./work.ts";

/** 9.1–9.3 — everything the invoice needs that is not derived from the work. */
export interface InvoiceConfig {
  /** Who is billing. */
  fromName: string;
  fromAddress: string;
  fromEmail: string;
  fromAbn: string;
  /** 9.17, 8.23 */
  fromPhone: string;
  /** 9.2 — who is being billed. */
  clientName: string;
  clientAddress: string;
  /** 9.3 */
  currency: string;
  rateMinor: number;
  /** A fraction: 0.1 is ten percent. Zero where tax does not apply. */
  taxRate: number;
  taxLabel: string;
  /** 8.12 — omitted from the PDF when empty. */
  approver: string;
  /** 9.7, 9.8 — the seed for the first invoice; later ones default from the previous. */
  teamProject: string;
  /** 9.9, 9.10 — same. */
  bonusMinor: number;
  /** 9.21, 8.21 — the bonus row is not work on the project, so it carries its own. */
  bonusTeamProject: string;
  /** 9.22, 8.32 — an optional line under the totals, e.g. about currency conversion. */
  note: string;

  // 9.18, 9.19, 8.30 — the payment block, as labelled fields rather than a blob, because the
  // format renders them as rows. Every one of these is sensitive under 20.1 and none of them
  // comes back on a read; see `publicInvoiceConfig`.
  payMethod: string;
  payName: string;
  payBsb: string;
  payAccountNumber: string;
  payBank: string;
}

/**
 * Which fields never travel back to a frontend. Named once, so the read path cannot miss one.
 *
 * 25.42 adds the postal address. It is not a secret in the sense a BSB is — it is printed on every
 * invoice — but it is a home address in most cases, and it was being sent to every authorised
 * device on every settings read for no reason: the only thing the frontend does with it is show it
 * back. The document is rendered on the server, which is where it is actually needed.
 */
export const SENSITIVE_INVOICE_FIELDS = [
  "payMethod",
  "payName",
  "payBsb",
  "payAccountNumber",
  "payBank",
  "fromAddress",
] as const satisfies readonly (keyof InvoiceConfig)[];

/**
 * 25.43 — the two groups, because clearing one must not clear the other.
 *
 * "Retype your bank details because you moved house" is the kind of thing that makes somebody
 * leave a field wrong rather than fix it.
 */
export const HIDDEN_GROUPS = {
  payment: ["payMethod", "payName", "payBsb", "payAccountNumber", "payBank"],
  address: ["fromAddress"],
} as const satisfies Record<string, readonly typeof SENSITIVE_INVOICE_FIELDS[number][]>;

/**
 * 5.7 — how often a work-detail prompt should fire, on average.
 *
 * `null` until somebody sets it, and 27.30 is why it is not a number with a plausible value in it.
 * It was `45 * 60_000`: a cadence nobody chose, shown in the settings box as though somebody had.
 * The same fault as the `"AUD"` and `"Wire Transfer"` that 24.35–24.37 deleted, and it survived
 * that sweep because a wrong interval does not print itself onto a document.
 *
 * A blank asks. There is no cadence that is right for everybody, and inventing one means the
 * screen cannot tell "45 minutes, chosen" from "nothing here yet" — which is exactly what a lost
 * update then wrote back to the server.
 */
export interface PromptConfig {
  meanIntervalMs: number | null;
  enabled: boolean;
}

export interface Config {
  pacing: PacingConfig;
  invoice: InvoiceConfig;
  prompt: PromptConfig;
}

export const DEFAULTS: Config = {
  pacing: {
    /*
     * 27.31 — no default, for the reason 24.33 gives about the region and 27.30 about the prompt
     * interval. 160 hours is full-time, which is a guess about the person, and the pacing screen
     * spends it immediately: "you will land 12h under" against a number nobody chose is a lie
     * carried to one decimal place.
     */
    monthlyTargetHours: null,
    schedule: defaultSchedule(),
    // 24.33 — no default. Mon–Fri 09:00–17:00 and 160 hours are sensible for anyone; a *place*
    // is not, and AU-NSW was a guess that silently decided which public holidays applied.
    region: "",
  },
  invoice: {
    fromName: "",
    fromAddress: "",
    fromEmail: "",
    fromAbn: "",
    fromPhone: "",
    clientName: "",
    clientAddress: "",
    // 24.35, 24.36 — nothing here is a guess about the person using it. "AUD" and "GST" were,
    // and a default that is wrong is worse than a blank: a blank asks, and a wrong default is
    // rendered onto a document that goes to a client.
    currency: "",
    rateMinor: 0,
    taxRate: 0,
    taxLabel: "",
    approver: "",
    teamProject: "",
    bonusMinor: 0,
    bonusTeamProject: "",
    note: "",
    // 24.37 — "Wire Transfer" is a guess too, and it is printed under "Method of payment".
    payMethod: "",
    payName: "",
    payBsb: "",
    payAccountNumber: "",
    payBank: "",
  },
  prompt: {
    // 27.30 — no default. See `PromptConfig`.
    meanIntervalMs: null,
    enabled: false,
  },
};

/**
 * Read one section, with anything unset falling back to the default.
 *
 * Merged one level deep rather than replaced wholesale, so a config written by an older build gains
 * a new field's default instead of losing every field the older build did not know about.
 */
export function getConfig<K extends keyof Config>(db: Db, key: K): Config[K] {
  const row = db.prepare("SELECT value_json FROM config WHERE key = ?").get(key) as
    | { value_json: string }
    | undefined;
  if (!row) return DEFAULTS[key];
  try {
    return { ...DEFAULTS[key], ...JSON.parse(row.value_json) };
  } catch {
    // Unparseable config is not a reason to refuse to start. The default is a known-good state and
    // the corruption is visible the moment anyone opens the settings screen.
    return DEFAULTS[key];
  }
}

export function setConfig<K extends keyof Config>(
  db: Db,
  key: K,
  value: Partial<Config[K]>,
  now: Instant = Date.now(),
): Config[K] {
  /*
   * Only fields this section actually has.
   *
   * The merge used to take whatever it was handed, so a client could write arbitrary keys into the
   * config row and they would be stored, returned, and merged forever after. Nothing malicious was
   * needed: the settings screen sends its whole draft back, and that draft contains
   * `paymentDetailsSet` — a *derived* flag from the read path — which was kept out only by the
   * frontend remembering to set it to `undefined` before sending. 25.42 added a second such flag,
   * which is the point at which "remember to exclude it" stopped being a plan.
   *
   * `DEFAULTS` is the list of what a section has, and it has to be complete for the section to
   * work at all, so it cannot silently fall behind the way a second list would.
   */
  validateSection(key, value);

  const known = DEFAULTS[key] as unknown as Record<string, unknown>;
  const accepted = Object.fromEntries(
    Object.entries(value).filter(([k]) => k in known),
  ) as Partial<Config[K]>;
  const merged = { ...getConfig(db, key), ...accepted };

  /*
   * 27.30 — prompts cannot be on without a cadence to be on at.
   *
   * Removing the invented 45-minute default created a state that could not exist before: enabled,
   * and no interval. `probabilityFor` would read it as "never", so the checkbox would say the
   * prompts were on and no prompt would ever come — a lie told by a control that looks set.
   *
   * Checked on the *result* rather than on the request, because the request that reaches it does
   * not mention the interval: it is `{enabled: true}` against a config that has none. A rule about
   * a pair of values belongs where the pair exists. (The other way in is closed already — `null`
   * is not a number, so an interval can be changed but never taken back out.)
   */
  if (key === "prompt") {
    const p = merged as PromptConfig;
    if (p.enabled && (p.meanIntervalMs === null || p.meanIntervalMs === undefined)) {
      throw new Refused("bad-config", "Prompts need an interval before they can be switched on.");
    }
  }

  db.prepare(
    `INSERT INTO config (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
                                     updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(merged), now);
  return merged;
}

/**
 * What a configuration value has to be.
 *
 * **All of this was accepted and stored**: an hourly rate of -50.00, a tax rate of 12 — which is
 * 1200% and would treble an invoice — a monthly target of a billion hours, a prompt interval of
 * minus one, and a Monday that ends before it starts. Every one is reachable from the settings
 * screen with a keyboard, and the frontend's own checks were the only thing between them and the
 * database.
 *
 * The money ones matter most: a negative rate produces a negative invoice, and a tax rate above 1
 * is a percentage somebody typed into a fraction. `updateDraft` already refused the second for a
 * *per-invoice* rate (25.12) and the global one had no such check, which is the shape of thing
 * that happens when a rule is written at the second call site rather than the first.
 *
 * Ranges rather than plausibility: 2.17's lesson from `work.ts` applies here too. A target of 500
 * hours is odd and allowed; a target of -50 cannot be meant.
 */
function validateSection<K extends keyof Config>(key: K, value: Partial<Config[K]>): void {
  const v = value as Record<string, unknown>;
  const refuse = (why: string) => {
    throw new Refused("bad-config", why);
  };
  const num = (name: string, min: number, max: number) => {
    const x = v[name];
    if (x === undefined) return;
    if (typeof x !== "number" || !Number.isFinite(x) || x < min || x > max) {
      refuse(`${name} must be a number between ${min} and ${max}`);
    }
  };

  if (key === "pacing") {
    // 744 is the longest month. A target above it is not an ambition, it is a typo.
    num("monthlyTargetHours", 0, 744);
    const schedule = v.schedule as Record<string, unknown> | undefined;
    for (const [day, interval] of Object.entries(schedule ?? {})) {
      if (interval === null || interval === undefined) continue;
      const { start, end } = interval as { start?: unknown; end?: unknown };
      const clock = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (
        typeof start !== "string" || typeof end !== "string" ||
        !clock.test(start) || !clock.test(end)
      ) {
        refuse(`${day} needs two times as HH:MM`);
      }
      // Not wrapped past midnight: 6.21's schedule is one interval within one day, and an end
      // before a start would make that day's capacity negative and every total below it wrong.
      if (String(end) <= String(start)) refuse(`${day} ends before it starts`);
    }
  }

  if (key === "prompt") {
    /*
     * Positive, and not longer than a day.
     *
     * I set the floor at a minute first, on the grounds that anything shorter is absurd — and the
     * journey went red, because it seeds a very short interval on purpose so a prompt fires while
     * the harness is watching. It is a legitimate value and refusing it was the same mistake as
     * the 24-hour cap in `work.ts`: a plausibility judgement dressed as a coherence check.
     *
     * The actual fault was `-1`, which `probabilityFor` reads as "never fire" — prompts silently
     * off, with a number in the box that looks like a setting.
     */
    num("meanIntervalMs", 1, 24 * 3_600_000);
  }

  if (key === "invoice") {
    num("rateMinor", 0, 100_000_000);
    num("bonusMinor", 0, 100_000_000);
    // A fraction. `0.1` is ten percent; `12` is twelve hundred.
    num("taxRate", 0, 0.9999);
  }
}

export function allConfig(db: Db): Config {
  return {
    pacing: getConfig(db, "pacing"),
    invoice: getConfig(db, "invoice"),
    prompt: getConfig(db, "prompt"),
  };
}

export type PublicInvoiceConfig =
  & Omit<InvoiceConfig, typeof SENSITIVE_INVOICE_FIELDS[number]>
  & { paymentDetailsSet: boolean; addressSet: boolean };

/**
 * The invoice configuration with the payment block removed (20.1, 20.3, 9.19).
 *
 * Those fields never need to reach a frontend in order to be *shown* — only to be edited — so the
 * read path drops them and the settings screen asks for them explicitly. That keeps bank details
 * out of every ordinary response, and therefore out of anything that later logs one.
 *
 * Built by deleting from a copy rather than by listing what to keep: a field added to
 * `InvoiceConfig` should appear in the UI by default, and a field added to
 * `SENSITIVE_INVOICE_FIELDS` should disappear from the wire without anything else being edited.
 */
export function publicInvoiceConfig(cfg: InvoiceConfig): PublicInvoiceConfig {
  const rest = { ...cfg } as Record<string, unknown>;
  for (const field of SENSITIVE_INVOICE_FIELDS) delete rest[field];

  // 25.42 — one flag per group, which is all a masked field needs to know: whether to show a mask
  // or an empty box. The values themselves stay here.
  const set = (fields: readonly (keyof InvoiceConfig)[]) =>
    fields.some((f) => String(cfg[f] ?? "").trim().length > 0);

  return {
    ...(rest as Omit<InvoiceConfig, typeof SENSITIVE_INVOICE_FIELDS[number]>),
    // `payMethod` deliberately excluded: it is "Wire Transfer", not an account number, and a
    // payment block that reads as configured because somebody typed the *method* is a block that
    // will print an invoice with no account on it.
    paymentDetailsSet: set(["payName", "payBsb", "payAccountNumber", "payBank"]),
    addressSet: set(HIDDEN_GROUPS.address),
  };
}

/** Anything missing that would make an invoice wrong rather than merely plain (20.9). */
export function invoiceConfigGaps(cfg: InvoiceConfig): string[] {
  const gaps: string[] = [];
  if (!cfg.fromName) gaps.push("your name or trading name");
  if (!cfg.clientName) gaps.push("the client's name");
  if (cfg.rateMinor <= 0) gaps.push("an hourly rate");
  if (!cfg.currency) gaps.push("a currency");
  if (!cfg.payName || !cfg.payAccountNumber) gaps.push("payment details");
  return gaps;
}

/**
 * What is missing before an invoice can be produced (24.31, 24.1).
 *
 * Returned as labels rather than as a boolean, and **all of them at once**: the alternative is
 * finding out about one empty field per attempt, which for a dozen fields is a dozen attempts.
 *
 * The list is what the document actually renders. `fromAbn` is not on it — the supplied format
 * does not carry one (24.34) — and neither are the approver, the note or the bonus, all of which
 * the renderer omits cleanly when unset. `taxLabel` is required only when there is tax to label,
 * because "no tax applies" is a legitimate configuration and 24.35 says so.
 */
export function missingInvoiceConfig(cfg: InvoiceConfig): string[] {
  const required: [keyof InvoiceConfig, string][] = [
    ["fromName", "your name"],
    ["fromAddress", "your address"],
    ["clientName", "the client's name"],
    ["clientAddress", "the client's address"],
    ["currency", "the currency"],
    ["teamProject", "the team or project"],
    ["payMethod", "the payment method"],
    ["payName", "the account name"],
    ["payBsb", "the BSB"],
    ["payAccountNumber", "the account number"],
    ["payBank", "the bank"],
  ];
  const missing = required
    .filter(([key]) => !String(cfg[key] ?? "").trim())
    .map(([, label]) => label);

  if (!(cfg.rateMinor > 0)) missing.push("an hourly rate above zero");
  if (cfg.taxRate > 0 && !cfg.taxLabel.trim()) missing.push("a name for the tax");
  return missing;
}
