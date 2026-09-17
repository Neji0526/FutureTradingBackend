import { timingSafeEqual } from "node:crypto";
import { config, useDatabase } from "../config.js";
import { upsertDxFeedRuleTemplate } from "../trading/admin-repository.js";

/**
 * dxFeed / Volumetrica Trading Rules → Vault RuleTemplate sync.
 *
 * The Volumetrica Reference (e.g. PRIME_50K_EVAL_PHASE1) IS the Vault template id.
 * New rules added in Volumetrica are inserted automatically; edits update + cascade
 * to every linked account. No DXFEED_RULE_MAP required.
 */

export type DxFeedTradingRulePayload = {
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

/** Sanitize Reference into a stable RuleTemplate id (same visible name). */
export function referenceAsTemplateId(reference: string): string {
  const raw = reference.trim();
  // Keep Volumetrica References as-is when already safe; otherwise normalize.
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/.test(raw)) return raw;
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "DXFEED_RULE";
}

/**
 * Optional legacy remap via DXFEED_RULE_MAP. Default: template id = Reference.
 */
export function resolveTemplateId(reference: string): string {
  const key = reference.trim().toUpperCase();
  const fromEnv = config.dxfeed.ruleMap[key] ?? config.dxfeed.ruleMap[reference.trim()];
  if (fromEnv) return fromEnv;
  return referenceAsTemplateId(reference);
}

function parseUniverse(universe: string | undefined): { maxContracts?: number; maxPositionUnits?: number } {
  if (!universe) return {};
  const m = universe.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
  if (!m) return {};
  const minis = Number(m[1]);
  if (!Number.isFinite(minis) || minis < 0) return {};
  return { maxContracts: Math.round(minis), maxPositionUnits: minis };
}

function inferDrawdownType(reference: string, explicit?: string): "INTRADAY" | "EOD" {
  const e = explicit?.trim().toUpperCase();
  if (e === "INTRADAY" || e === "EOD") return e;
  const r = reference.toUpperCase();
  if (r.includes("FUND")) return "EOD";
  return "INTRADAY";
}

function inferPhase(reference: string, label?: string): string {
  const hay = `${reference} ${label ?? ""}`.toUpperCase();
  if (hay.includes("PHASE2") || hay.includes("PHASE_2") || hay.includes("PHASE 2")) {
    return "Challenge Phase 2";
  }
  if (hay.includes("PHASE1") || hay.includes("PHASE_1") || hay.includes("PHASE 1") || hay.includes("EVAL")) {
    return "Challenge Phase 1";
  }
  if (hay.includes("FUND")) return "Funded";
  return "dxFeed";
}

export function normalizeTradingRule(raw: DxFeedTradingRulePayload): {
  reference: string;
  label?: string;
  accountSize?: number;
  phase: string;
  fields: Parameters<typeof upsertDxFeedRuleTemplate>[0]["fields"];
} | null {
  const referenceRaw =
    str(raw.reference) ??
    str(raw.Reference) ??
    str(raw.id) ??
    str(raw.ruleId);
  if (!referenceRaw) return null;

  const reference = resolveTemplateId(referenceRaw);
  const label = str(raw.description) ?? str(raw.Description);
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

  const fields: Parameters<typeof upsertDxFeedRuleTemplate>[0]["fields"] = {};
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

  fields.drawdownType = inferDrawdownType(referenceRaw, str(raw.drawdownType));

  if (Array.isArray(raw.allowedInstruments)) {
    fields.allowedInstruments = raw.allowedInstruments.filter((s) => typeof s === "string");
  }

  // Sensible defaults for brand-new inserts when Volumetrica omits optional fields.
  if (fields.stopLossRequired == null) fields.stopLossRequired = true;
  if (fields.overnightHoldsProhibited == null) fields.overnightHoldsProhibited = true;
  if (fields.weekendHoldsProhibited == null) fields.weekendHoldsProhibited = true;
  if (fields.minHoldTimeSecs == null) fields.minHoldTimeSecs = 30;

  return {
    reference,
    label,
    accountSize,
    phase: inferPhase(referenceRaw, label),
    fields,
  };
}

/** Apply one Volumetrica trading-rule payload: create or update Vault template + cascade. */
export async function applyDxFeedTradingRule(raw: DxFeedTradingRulePayload): Promise<SyncResult> {
  const normalized = normalizeTradingRule(raw);
  if (!normalized) {
    return { reference: "?", templateId: null, applied: false, reason: "missing reference" };
  }

  if (!useDatabase()) {
    return {
      reference: normalized.reference,
      templateId: normalized.reference,
      applied: false,
      reason: "database not configured",
    };
  }

  try {
    const templateId = await upsertDxFeedRuleTemplate({
      reference: normalized.reference,
      label: normalized.label ?? normalized.reference,
      phase: normalized.phase,
      accountSize: normalized.accountSize ?? 50_000,
      fields: normalized.fields,
    });

    console.log(
      `[dxfeed rules] upserted ${normalized.reference} → ${templateId}` +
        ` fields=${Object.keys(normalized.fields).join(",") || "(meta)"}`,
    );

    return { reference: normalized.reference, templateId, applied: true };
  } catch (err) {
    console.warn(`[dxfeed rules] upsert failed for ${normalized.reference}:`, (err as Error).message);
    return {
      reference: normalized.reference,
      templateId: null,
      applied: false,
      reason: (err as Error).message,
    };
  }
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
