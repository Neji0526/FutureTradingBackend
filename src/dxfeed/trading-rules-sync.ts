import { timingSafeEqual } from "node:crypto";
import { config, useDatabase } from "../config.js";
import { adminUpdateRuleTemplate, adminListRuleTemplates } from "../trading/admin-repository.js";
import { getPool } from "../db/pool.js";

/**
 * dxFeed / Volumetrica Trading Rules → Vault RuleTemplate sync.
 *
 * Admin edits on dxfeed.volumetricaprop.com/Admin/.../TradingRules push here via
 * webhook (or POST /api/dxfeed/trading-rules). We map their Reference
 * (e.g. PRIME_50K_EVAL) onto our RuleTemplate ids, cascade into every linked
 * per-account Rule row, and OrderEngine / RiskEngine pick the new limits up
 * on the next order / equity tick — no SignalApp involvement.
 */

export type DxFeedTradingRulePayload = {
  /** Volumetrica rule Reference, e.g. PRIME_50K_EVAL */
  reference?: string | null;
  Reference?: string | null;
  id?: string | null;
  ruleId?: string | null;
  description?: string | null;
  Description?: string | null;
  startBalance?: number | string | null;
  StartBalance?: number | string | null;
  maxDrawdown?: number | string | null;
  MaxDD?: number | string | null;
  "Max. DD"?: number | string | null;
  dailyDrawdown?: number | string | null;
  DailyDD?: number | string | null;
  "Daily. DD"?: number | string | null;
  profitTarget?: number | string | null;
  ProfitTgt?: number | string | null;
  "Profit Tgt"?: number | string | null;
  /** e.g. "5/50" → 5 minis / 50 micros */
  universe?: string | null;
  Universe?: string | null;
  currency?: string | null;
  Currency?: string | null;
  margin?: number | string | null;
  Margin?: number | string | null;
  maxRiskPerTrade?: number | string | null;
  minHoldTimeSecs?: number | string | null;
  minTradingDays?: number | string | null;
  maxDailyProfitPct?: number | string | null;
  stopLossRequired?: boolean | null;
  drawdownType?: string | null;
  overnightHoldsProhibited?: boolean | null;
  weekendHoldsProhibited?: boolean | null;
  allowedInstruments?: string[] | null;
};

export type SyncResult = {
  reference: string;
  templateId: string | null;
  applied: boolean;
  reason?: string;
};

function num(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v).replace(/[$,%\s]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t || undefined;
}

function bool(v: unknown): boolean | undefined {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const t = v.trim().toLowerCase();
    if (t === "true" || t === "1" || t === "yes") return true;
    if (t === "false" || t === "0" || t === "no") return false;
  }
  return undefined;
}

/** Compare API keys in constant time when lengths match. */
export function dxFeedApiKeyOk(provided: string | undefined | null): boolean {
  const expected = config.dxfeed.apiKey;
  if (!expected || !provided) return false;
  try {
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Default Reference → RuleTemplate id map.
 * Override with DXFEED_RULE_MAP JSON, e.g.
 * {"PRIME_50K_EVAL":"c1_50k","PRIME_50K_FUND":"f_50k"}
 */
export function resolveTemplateId(reference: string): string | null {
  const key = reference.trim().toUpperCase();
  const fromEnv = config.dxfeed.ruleMap[key] ?? config.dxfeed.ruleMap[reference.trim()];
  if (fromEnv) return fromEnv;

  const defaults: Record<string, string> = {
    PRIME_50K_EVAL: "c1_50k",
    PRIME_50K_FUND: "f_50k",
    PRIME_100K_EVAL: "c1_100k",
    PRIME_100K_FUND: "f_100k",
    C1_50K: "c1_50k",
    C2_50K: "c2_50k",
    F_50K: "f_50k",
  };
  if (defaults[key]) return defaults[key];

  const known = new Set([
    "c1_50k", "c1_100k", "c2_50k", "c2_100k",
    "f_50k", "f_100k", "f_250k", "f_500k", "f_1m",
  ]);
  if (known.has(reference.trim())) return reference.trim();
  return null;
}

function parseUniverse(universe: string | undefined): { maxContracts?: number; maxPositionUnits?: number } {
  if (!universe) return {};
  const m = universe.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (!m) return {};
  const minis = Number(m[1]);
  if (!Number.isFinite(minis) || minis < 0) return {};
  return { maxContracts: Math.round(minis), maxPositionUnits: minis };
}

function inferDrawdownType(reference: string, explicit?: string): "INTRADAY" | "EOD" | undefined {
  const e = explicit?.trim().toUpperCase();
  if (e === "INTRADAY" || e === "EOD") return e;
  const r = reference.toUpperCase();
  if (r.includes("FUND") || r.startsWith("F_")) return "EOD";
  if (r.includes("EVAL") || r.includes("C1") || r.includes("C2") || r.includes("CHALLENGE")) {
    return "INTRADAY";
  }
  return undefined;
}

export function normalizeTradingRule(raw: DxFeedTradingRulePayload): {
  reference: string;
  label?: string;
  accountSize?: number;
  fields: Parameters<typeof adminUpdateRuleTemplate>[1];
} | null {
  const reference =
    str(raw.reference) ??
    str(raw.Reference) ??
    str(raw.id) ??
    str(raw.ruleId);
  if (!reference) return null;

  const universe = str(raw.universe) ?? str(raw.Universe);
  const fromUniverse = parseUniverse(universe);

  const maxDrawdown =
    num(raw.maxDrawdown) ?? num(raw.MaxDD) ?? num(raw["Max. DD"]);
  const maxDailyLoss =
    num(raw.dailyDrawdown) ?? num(raw.DailyDD) ?? num(raw["Daily. DD"]);
  const profitTarget =
    num(raw.profitTarget) ?? num(raw.ProfitTgt) ?? num(raw["Profit Tgt"]);
  const accountSize =
    num(raw.startBalance) ?? num(raw.StartBalance);

  const fields: Parameters<typeof adminUpdateRuleTemplate>[1] = {};
  if (maxDrawdown != null) fields.maxDrawdown = maxDrawdown;
  if (maxDailyLoss != null) fields.maxDailyLoss = maxDailyLoss;
  if (profitTarget != null) fields.profitTarget = profitTarget;
  if (fromUniverse.maxContracts != null) fields.maxContracts = fromUniverse.maxContracts;
  if (fromUniverse.maxPositionUnits != null) fields.maxPositionUnits = fromUniverse.maxPositionUnits;

  const risk = num(raw.maxRiskPerTrade);
  if (risk != null) fields.maxRiskPerTrade = risk;
  const hold = num(raw.minHoldTimeSecs);
  if (hold != null) fields.minHoldTimeSecs = hold;
  const days = num(raw.minTradingDays);
  if (days != null) fields.minTradingDays = days;
  const pct = num(raw.maxDailyProfitPct);
  if (pct != null) fields.maxDailyProfitPct = pct;

  const sl = bool(raw.stopLossRequired);
  if (sl != null) fields.stopLossRequired = sl;
  const ov = bool(raw.overnightHoldsProhibited);
  if (ov != null) fields.overnightHoldsProhibited = ov;
  const wk = bool(raw.weekendHoldsProhibited);
  if (wk != null) fields.weekendHoldsProhibited = wk;

  const ddType = inferDrawdownType(reference, str(raw.drawdownType));
  if (ddType) fields.drawdownType = ddType;

  if (Array.isArray(raw.allowedInstruments)) {
    fields.allowedInstruments = raw.allowedInstruments.filter((s) => typeof s === "string");
  }

  return {
    reference,
    label: str(raw.description) ?? str(raw.Description),
    accountSize,
    fields,
  };
}

async function markSynced(templateId: string, reference: string): Promise<void> {
  if (!useDatabase()) return;
  try {
    await getPool().query(
      `UPDATE "RuleTemplate"
       SET "externalReference" = $2,
           "source" = 'dxfeed',
           "syncedAt" = now(),
           "updatedAt" = now()
       WHERE "id" = $1`,
      [templateId, reference],
    );
  } catch (err) {
    // Older DBs before schema migrate — limits still cascade via adminUpdateRuleTemplate.
    console.warn(
      `[dxfeed rules] could not stamp externalReference on ${templateId}:`,
      (err as Error).message,
    );
  }
}

async function touchLabelAndSize(
  templateId: string,
  label: string | undefined,
  accountSize: number | undefined,
): Promise<void> {
  if (!useDatabase()) return;
  const cols: string[] = [];
  const vals: unknown[] = [templateId];
  if (label) {
    cols.push(`"label" = $${vals.length + 1}`);
    vals.push(label);
  }
  if (accountSize != null && accountSize > 0) {
    cols.push(`"accountSize" = $${vals.length + 1}`);
    vals.push(accountSize);
  }
  if (cols.length === 0) return;
  await getPool().query(
    `UPDATE "RuleTemplate" SET ${cols.join(", ")}, "updatedAt" = now() WHERE "id" = $1`,
    vals,
  );
}

/** Apply one Volumetrica trading-rule payload onto the mapped Vault template + cascade. */
export async function applyDxFeedTradingRule(raw: DxFeedTradingRulePayload): Promise<SyncResult> {
  const normalized = normalizeTradingRule(raw);
  if (!normalized) {
    return { reference: "?", templateId: null, applied: false, reason: "missing reference" };
  }

  const templateId = resolveTemplateId(normalized.reference);
  if (!templateId) {
    return {
      reference: normalized.reference,
      templateId: null,
      applied: false,
      reason: `no RuleTemplate mapping for reference "${normalized.reference}" — set DXFEED_RULE_MAP`,
    };
  }

  if (!useDatabase()) {
    return {
      reference: normalized.reference,
      templateId,
      applied: false,
      reason: "database not configured",
    };
  }

  const hasFields = Object.keys(normalized.fields).length > 0;
  let applied = false;
  if (hasFields) {
    applied = await adminUpdateRuleTemplate(templateId, normalized.fields);
  }

  await touchLabelAndSize(templateId, normalized.label, normalized.accountSize);
  await markSynced(templateId, normalized.reference);

  if (!hasFields) {
    const list = await adminListRuleTemplates();
    applied = list.some((t) => t.id === templateId);
  }

  console.log(
    `[dxfeed rules] ${applied ? "synced" : "skipped"} ${normalized.reference} → ${templateId}` +
      (hasFields ? ` fields=${Object.keys(normalized.fields).join(",")}` : " (metadata only)"),
  );

  return {
    reference: normalized.reference,
    templateId,
    applied,
    reason: applied ? undefined : "template not found or empty update",
  };
}

/** Extract zero-or-more rule objects from a webhook / REST body. */
export function extractTradingRulesFromBody(body: unknown): DxFeedTradingRulePayload[] {
  if (!body || typeof body !== "object") return [];
  const o = body as Record<string, unknown>;

  const bag: unknown[] = [];
  if (o.tradingRule && typeof o.tradingRule === "object") bag.push(o.tradingRule);
  if (o.accountRule && typeof o.accountRule === "object") bag.push(o.accountRule);
  if (o.rule && typeof o.rule === "object") bag.push(o.rule);
  if (Array.isArray(o.tradingRules)) bag.push(...o.tradingRules);
  if (Array.isArray(o.rules)) bag.push(...o.rules);
  if (Array.isArray(o.data)) bag.push(...o.data);

  if (
    bag.length === 0 &&
    (typeof o.reference === "string" ||
      typeof o.Reference === "string" ||
      typeof o.ruleId === "string")
  ) {
    bag.push(o);
  }

  return bag.filter((x): x is DxFeedTradingRulePayload => Boolean(x) && typeof x === "object");
}

export async function syncTradingRulesFromBody(body: unknown): Promise<SyncResult[]> {
  const rules = extractTradingRulesFromBody(body);
  const out: SyncResult[] = [];
  for (const r of rules) {
    out.push(await applyDxFeedTradingRule(r));
  }
  return out;
}
