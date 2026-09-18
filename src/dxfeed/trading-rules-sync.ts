import { timingSafeEqual } from "node:crypto";
import { config, useDatabase } from "../config.js";
import { upsertDxFeedRuleTemplate } from "../trading/admin-repository.js";
import { propfirm } from "./propfirm.js";

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
  organizationReferenceId?: string | null;
  id?: string | null;
  ruleId?: string | null;
  RuleId?: string | null;
  description?: string | null;
  Description?: string | null;
  startBalance?: number | string | null;
  StartBalance?: number | string | null;
  startingBalance?: number | string | null;
  maxDrawdown?: number | string | null;
  MaxDD?: number | string | null;
  "Max. DD"?: number | string | null;
  maxDrawdownMoney?: number | string | null;
  dailyDrawdown?: number | string | null;
  DailyDD?: number | string | null;
  "Daily. DD"?: number | string | null;
  maxIntradayDrawdownMoney?: number | string | null;
  profitTarget?: number | string | null;
  ProfitTgt?: number | string | null;
  "Profit Tgt"?: number | string | null;
  profitTargetMoney?: number | string | null;
  universe?: string | null;
  Universe?: string | null;
  currency?: string | null;
  Currency?: string | null;
  margin?: number | string | null;
  Margin?: number | string | null;
  maxRiskPerTrade?: number | string | null;
  minHoldTimeSecs?: number | string | null;
  scalpingMinSeconds?: number | string | null;
  minTradingDays?: number | string | null;
  minSessionNumbers?: number | string | null;
  maxDailyProfitPct?: number | string | null;
  stopLossRequired?: boolean | null;
  drawdownType?: string | null;
  overnightHoldsProhibited?: boolean | null;
  weekendHoldsProhibited?: boolean | null;
  failOnOvernight?: boolean | null;
  failOnOverweekend?: boolean | null;
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
  dxRuleId?: string;
  label?: string;
  accountSize?: number;
  phase: string;
  fields: Parameters<typeof upsertDxFeedRuleTemplate>[0]["fields"];
} | null {
  // Prefer organization Reference (Admin "Organization reference id") as Vault template id.
  const orgRef = str(raw.organizationReferenceId) ?? str(raw.reference) ?? str(raw.Reference);
  const dxRuleId = str(raw.ruleId) ?? str(raw.RuleId);
  const referenceRaw = orgRef ?? dxRuleId ?? str(raw.id);
  if (!referenceRaw) return null;

  const reference = resolveTemplateId(referenceRaw);
  const label = str(raw.description) ?? str(raw.Description);
  const universe = str(raw.universe) ?? str(raw.Universe);
  const fromUniverse = parseUniverse(universe);

  const maxDrawdown =
    num(raw.maxDrawdown) ?? num(raw.maxDrawdownMoney) ?? num(raw.MaxDD) ?? num(raw["Max. DD"]);
  const maxDailyLoss =
    num(raw.dailyDrawdown) ??
    num(raw.maxIntradayDrawdownMoney) ??
    num(raw.DailyDD) ??
    num(raw["Daily. DD"]);
  const profitTarget =
    num(raw.profitTarget) ?? num(raw.profitTargetMoney) ?? num(raw.ProfitTgt) ?? num(raw["Profit Tgt"]);
  const accountSize =
    num(raw.startBalance) ?? num(raw.startingBalance) ?? num(raw.StartBalance);

  const fields: Parameters<typeof upsertDxFeedRuleTemplate>[0]["fields"] = {};
  if (maxDrawdown != null) fields.maxDrawdown = maxDrawdown;
  if (maxDailyLoss != null) fields.maxDailyLoss = maxDailyLoss;
  if (profitTarget != null) fields.profitTarget = profitTarget;
  if (fromUniverse.maxContracts != null) fields.maxContracts = fromUniverse.maxContracts;
  if (fromUniverse.maxPositionUnits != null) fields.maxPositionUnits = fromUniverse.maxPositionUnits;

  const risk = num(raw.maxRiskPerTrade);
  if (risk != null) fields.maxRiskPerTrade = risk;
  const hold = num(raw.minHoldTimeSecs) ?? num(raw.scalpingMinSeconds);
  if (hold != null) fields.minHoldTimeSecs = hold;
  const days = num(raw.minTradingDays) ?? num(raw.minSessionNumbers);
  if (days != null) fields.minTradingDays = days;
  const pct = num(raw.maxDailyProfitPct);
  if (pct != null) fields.maxDailyProfitPct = pct;

  const sl = bool(raw.stopLossRequired);
  if (sl != null) fields.stopLossRequired = sl;

  const failOvernight = bool(raw.failOnOvernight);
  const ov = bool(raw.overnightHoldsProhibited) ?? (failOvernight != null ? failOvernight : undefined);
  if (ov != null) fields.overnightHoldsProhibited = ov;

  const failWeekend = bool(raw.failOnOverweekend);
  const wk = bool(raw.weekendHoldsProhibited) ?? (failWeekend != null ? failWeekend : undefined);
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
    dxRuleId: dxRuleId && dxRuleId !== reference ? dxRuleId : dxRuleId,
    label,
    accountSize,
    phase: inferPhase(referenceRaw, label),
    fields,
  };
}

/** Apply one Volumetrica trading-rule payload: create or update Vault template + cascade. */
export async function applyDxFeedTradingRule(raw: DxFeedTradingRulePayload): Promise<SyncResult> {
  console.log("[dxfeed rules] incoming rule from dxFeed:", JSON.stringify(raw));

  const normalized = normalizeTradingRule(raw);
  if (!normalized) {
    console.warn("[dxfeed rules] skip payload — missing Reference/reference/ruleId", summarizeRuleKeys(raw));
    return { reference: "?", templateId: null, applied: false, reason: "missing reference" };
  }

  console.log(
    "[dxfeed rules] normalized:",
    JSON.stringify({
      reference: normalized.reference,
      label: normalized.label ?? null,
      phase: normalized.phase,
      accountSize: normalized.accountSize ?? null,
      fields: normalized.fields,
    }),
  );

  if (!useDatabase) {
    console.warn(`[dxfeed rules] skip ${normalized.reference} — database not configured`);
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
      dxRuleId: normalized.dxRuleId,
      label: normalized.label ?? normalized.reference,
      phase: normalized.phase,
      accountSize: normalized.accountSize ?? 50_000,
      fields: normalized.fields,
    });

    console.log(
      `[dxfeed rules] upserted ${normalized.reference} → RuleTemplate.id=${templateId}` +
        ` phase=${normalized.phase}` +
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

/**
 * Guide-aligned: fetch one Volumetrica rule by UUID (V1 GetTradingRule) and upsert RuleTemplate.
 * Call after CreateTradingAccount returns tradingRuleId, or when DXFEED_DEFAULT_RULE_ID is set.
 * Full-catalog sync uses V2 TradingRule/List via fetchTradingRulesFromRest / watch.
 */
export async function syncTradingRuleById(ruleId: string): Promise<SyncResult> {
  const id = ruleId.trim();
  if (!id) {
    return { reference: "?", templateId: null, applied: false, reason: "missing ruleId" };
  }
  console.log(`[dxfeed rules] REST GetTradingRule ruleId=${id}`);
  try {
    const rule = await propfirm.getTradingRule(id);
    return await applyDxFeedTradingRule(rule as DxFeedTradingRulePayload);
  } catch (err) {
    console.warn(`[dxfeed rules] GetTradingRule(${id}) failed:`, (err as Error).message);
    return {
      reference: id,
      templateId: null,
      applied: false,
      reason: (err as Error).message,
    };
  }
}

function summarizeRuleKeys(raw: unknown): string {
  if (!raw || typeof raw !== "object") return typeof raw;
  return Object.keys(raw as object).slice(0, 20).join(",");
}

function looksLikeTradingRule(x: unknown): x is DxFeedTradingRulePayload {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.reference === "string" ||
    typeof o.Reference === "string" ||
    typeof o.organizationReferenceId === "string" ||
    typeof o.ruleId === "string" ||
    typeof o.RuleId === "string" ||
    typeof o.id === "string" ||
    o.MaxDD != null ||
    o.maxDrawdown != null ||
    o.maxDrawdownMoney != null ||
    o.StartBalance != null ||
    o.startBalance != null ||
    o.startingBalance != null
  );
}

function pushRuleCandidate(bag: unknown[], item: unknown): void {
  if (!item) return;
  if (Array.isArray(item)) {
    for (const x of item) pushRuleCandidate(bag, x);
    return;
  }
  if (typeof item !== "object") return;
  const o = item as Record<string, unknown>;
  // Nested wrappers Volumetrica sometimes uses around a single rule.
  if (o.tradingRule && typeof o.tradingRule === "object") bag.push(o.tradingRule);
  if (o.accountRule && typeof o.accountRule === "object") bag.push(o.accountRule);
  if (o.AccountRule && typeof o.AccountRule === "object") bag.push(o.AccountRule);
  if (o.rule && typeof o.rule === "object") bag.push(o.rule);
  if (looksLikeTradingRule(item)) bag.push(item);
}

/** Extract zero-or-more rule objects from a webhook / REST body. */
export function extractTradingRulesFromBody(body: unknown): DxFeedTradingRulePayload[] {
  if (!body || typeof body !== "object") return [];
  const o = body as Record<string, unknown>;

  const bag: unknown[] = [];
  pushRuleCandidate(bag, o.tradingRule);
  pushRuleCandidate(bag, o.accountRule);
  pushRuleCandidate(bag, o.AccountRule);
  pushRuleCandidate(bag, o.rule);
  pushRuleCandidate(bag, o.tradingRules);
  pushRuleCandidate(bag, o.accountRules);
  pushRuleCandidate(bag, o.AccountRules);
  pushRuleCandidate(bag, o.rules);
  pushRuleCandidate(bag, o.items);
  pushRuleCandidate(bag, o.data);
  pushRuleCandidate(bag, o.payload);
  pushRuleCandidate(bag, o.content);
  pushRuleCandidate(bag, o.result);

  // Top-level rule object (Reference / MaxDD / …) with no wrapper key.
  // Skip bare webhook shells that only have category/event and no rule fields.
  if (bag.length === 0) {
    const hasRef =
      typeof o.reference === "string" ||
      typeof o.Reference === "string" ||
      typeof o.ruleId === "string" ||
      typeof o.RuleId === "string";
    const hasLimits = o.MaxDD != null || o.maxDrawdown != null || o.StartBalance != null || o.startBalance != null;
    if (hasRef || hasLimits) bag.push(o);
  }

  // Deduplicate by reference when the same rule appears nested twice.
  const out: DxFeedTradingRulePayload[] = [];
  const seen = new Set<string>();
  for (const x of bag) {
    if (!looksLikeTradingRule(x)) continue;
    const key =
      str(x.reference) ??
      str(x.Reference) ??
      str(x.ruleId) ??
      str(x.RuleId) ??
      str(x.id) ??
      JSON.stringify(x).slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(x);
  }
  return out;
}

export async function syncTradingRulesFromBody(body: unknown): Promise<SyncResult[]> {
  const rules = extractTradingRulesFromBody(body);
  console.log(
    `[dxfeed rules] sync start — extracted ${rules.length} rule(s)` +
      (rules.length
        ? ` refs=[${rules.map((r) => str(r.reference) ?? str(r.Reference) ?? str(r.ruleId) ?? str(r.RuleId) ?? "?").join(", ")}]`
        : ` bodyKeys=[${summarizeRuleKeys(body)}]`),
  );
  if (rules.length > 0) {
    console.log("[dxfeed rules] extracted payloads:", JSON.stringify(rules));
  }
  const out: SyncResult[] = [];
  for (const r of rules) {
    out.push(await applyDxFeedTradingRule(r));
  }
  const applied = out.filter((r) => r.applied).length;
  console.log(`[dxfeed rules] sync done — applied ${applied}/${out.length}`, JSON.stringify(out));
  return out;
}
