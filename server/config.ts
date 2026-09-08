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

/** Which fields never travel back to a frontend. Named once, so the read path cannot miss one. */
export const SENSITIVE_INVOICE_FIELDS = [
  "payMethod",
  "payName",
  "payBsb",
  "payAccountNumber",
  "payBank",
] as const satisfies readonly (keyof InvoiceConfig)[];

/** 5.7 — how often a work-detail prompt should fire, on average. */
export interface PromptConfig {
  meanIntervalMs: number;
  enabled: boolean;
}

export interface Config {
  pacing: PacingConfig;
  invoice: InvoiceConfig;
  prompt: PromptConfig;
}

export const DEFAULTS: Config = {
  pacing: {
    monthlyTargetHours: 160,
    schedule: defaultSchedule(),
    region: "AU-NSW", // 6.32
  },
  invoice: {
    fromName: "",
    fromAddress: "",
    fromEmail: "",
    fromAbn: "",
    fromPhone: "",
    clientName: "",
    clientAddress: "",
    currency: "AUD",
    rateMinor: 0,
    taxRate: 0,
    taxLabel: "GST",
    approver: "",
    teamProject: "",
    bonusMinor: 0,
    bonusTeamProject: "General",
    note: "",
    payMethod: "Wire Transfer",
    payName: "",
    payBsb: "",
    payAccountNumber: "",
    payBank: "",
  },
  prompt: {
    meanIntervalMs: 45 * 60_000,
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
  const merged = { ...getConfig(db, key), ...value };
  db.prepare(
    `INSERT INTO config (key, value_json, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value_json = excluded.value_json,
                                     updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(merged), now);
  return merged;
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
  & { paymentDetailsSet: boolean };

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
  let anySet = false;
  for (const field of SENSITIVE_INVOICE_FIELDS) {
    if (field !== "payMethod" && String(cfg[field] ?? "").length > 0) anySet = true;
    delete rest[field];
  }
  return {
    ...(rest as Omit<InvoiceConfig, typeof SENSITIVE_INVOICE_FIELDS[number]>),
    paymentDetailsSet: anySet,
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
