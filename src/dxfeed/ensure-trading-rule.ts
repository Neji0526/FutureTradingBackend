/**
 * Ensure Volumetrica trading accounts get the org Phase 1 rule (50K Evaluation)
 * when the trader signs the dxFeed market-data agreement.
 *
 * Uses Propsite V1 ChangeTradingRuleForAccount:
 *   GET /api/Propsite/ChangeTradingRuleForAccount?accountId=&ruleId=
 * @see https://dxfeed.volumetricaprop.com/swagger/index.html
 */
import { config, dxfeedProvisionReady, useDatabase } from "../config.js";
import { getPool } from "../db/pool.js";
import { propfirm } from "./propfirm.js";
import type { DxFeedLink } from "./store.js";
import { syncTradingRuleById } from "./trading-rules-sync.js";

const PHASE1_REFS = [
  "PRIME_50K_EVAL_PHASE1",
  "PRIME_50K_EVAL",
  "50K - Evaluation (Phase 1)",
] as const;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Process-lifetime cache (only stores GetTradingRule-verified UUIDs). */
let cachedPhase1RuleId: string | null | undefined;

function looksLikeRuleUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

function extractRuleUuid(rule: Record<string, unknown>): string | null {
  for (const key of ["ruleId", "RuleId", "id", "Id"] as const) {
    const v = rule[key];
    if (typeof v === "string" && looksLikeRuleUuid(v)) return v.trim();
  }
  return null;
}

function isPhase1Rule(rule: Record<string, unknown>): boolean {
  const ref = String(
    rule.organizationReferenceId ?? rule.reference ?? rule.Reference ?? "",
  )
    .trim()
    .toUpperCase();
  const desc = String(rule.description ?? rule.Description ?? "")
    .trim()
    .toUpperCase();
  return (
    PHASE1_REFS.some((r) => ref === r.toUpperCase() || desc === r.toUpperCase())
    || (ref.includes("50K") && (ref.includes("PHASE1") || ref.includes("PHASE_1")))
    || (desc.includes("50K") && (desc.includes("PHASE 1") || desc.includes("PHASE1")))
  );
}

/** Confirm ruleId exists in Volumetrica (avoids CreateTradingAccount 404). */
async function verifyTradingRuleId(ruleId: string): Promise<string | null> {
  const id = ruleId.trim();
  if (!id) return null;
  try {
    const rule = await propfirm.getTradingRule(id);
    if (!rule || typeof rule !== "object") return null;
    const verified = extractRuleUuid(rule as Record<string, unknown>) || id;
    return verified;
  } catch (err) {
    console.warn(
      `[dxfeed] GetTradingRule(${id.slice(0, 36)}) failed:`,
      (err as Error).message.slice(0, 160),
    );
    return null;
  }
}

export function clearPhase1TradingRuleCache(): void {
  cachedPhase1RuleId = undefined;
}

/**
 * Resolve Volumetrica Trading Rule UUID for 50K Evaluation (Phase 1).
 * Only returns ids that GetTradingRule accepts (prevents "Trading rule not found").
 */
export async function resolvePhase1TradingRuleId(): Promise<string | null> {
  if (cachedPhase1RuleId !== undefined) return cachedPhase1RuleId;

  const candidates: string[] = [];
  const push = (v: string | null | undefined) => {
    const s = v?.trim();
    if (!s || candidates.includes(s)) return;
    candidates.push(s);
  };

  push(config.dxfeed.provisioning.ruleId);

  if (useDatabase) {
    try {
      const { rows } = await getPool().query<{ id: string; externalReference: string | null }>(
        `SELECT "id", "externalReference" FROM "RuleTemplate"
         WHERE "id" = ANY($1::text[])
            OR "externalReference" = ANY($1::text[])
            OR upper(coalesce("label", '')) LIKE '%50K%PHASE 1%'
            OR upper(coalesce("label", '')) LIKE '%50K%PHASE1%'
         ORDER BY
           CASE WHEN "source" = 'dxfeed' THEN 0 ELSE 1 END,
           CASE WHEN "id" = 'PRIME_50K_EVAL_PHASE1' THEN 0 ELSE 1 END
         LIMIT 5`,
        [PHASE1_REFS as unknown as string[]],
      );
      for (const row of rows) {
        push(row.externalReference);
        if (looksLikeRuleUuid(row.id)) push(row.id);
      }
    } catch (err) {
      console.warn("[dxfeed] resolve Phase1 rule from DB:", (err as Error).message.slice(0, 160));
    }
  }

  try {
    const rules = await propfirm.listTradingRules();
    for (const rule of rules) {
      if (!isPhase1Rule(rule)) continue;
      push(extractRuleUuid(rule));
    }
  } catch (err) {
    console.warn("[dxfeed] resolve Phase1 rule via List:", (err as Error).message.slice(0, 200));
  }

  for (const candidate of candidates) {
    // Prefer UUID-shaped ids first, then try opaque env values.
    if (!looksLikeRuleUuid(candidate) && candidate !== config.dxfeed.provisioning.ruleId.trim()) {
      continue;
    }
    const verified = await verifyTradingRuleId(candidate);
    if (verified) {
      cachedPhase1RuleId = verified;
      console.log(`[dxfeed] Phase1 trading rule verified ruleId=${verified}`);
      return verified;
    }
  }

  // Last pass: any List Phase1 row UUID we haven't tried (already in candidates).
  for (const candidate of candidates) {
    const verified = await verifyTradingRuleId(candidate);
    if (verified) {
      cachedPhase1RuleId = verified;
      console.log(`[dxfeed] Phase1 trading rule verified ruleId=${verified}`);
      return verified;
    }
  }

  cachedPhase1RuleId = null;
  console.warn(
    "[dxfeed] Phase1 trading rule UUID not found — set DXFEED_DEFAULT_RULE_ID to the Volumetrica rule UUID",
  );
  return null;
}

/**
 * Attach 50K Evaluation (Phase 1) to the Volumetrica trading account.
 * Safe to call repeatedly (idempotent associate).
 */
export async function ensureVolumetricaTradingRule(
  link: Pick<DxFeedLink, "orderNumber" | "dxAccountId" | "dxUserId">,
): Promise<{ ok: boolean; ruleId?: string; reason?: string }> {
  if (!dxfeedProvisionReady) {
    return { ok: false, reason: "dxfeed not configured" };
  }
  const accountId = link.dxAccountId?.trim();
  if (!accountId) {
    return { ok: false, reason: `no dxAccountId for order ${link.orderNumber}` };
  }

  let ruleId = await resolvePhase1TradingRuleId();
  if (!ruleId) {
    clearPhase1TradingRuleCache();
    ruleId = await resolvePhase1TradingRuleId();
  }
  if (!ruleId) {
    return {
      ok: false,
      reason:
        "Phase1 trading rule UUID not found — set DXFEED_DEFAULT_RULE_ID or sync TradingRule/List",
    };
  }

  try {
    await propfirm.changeTradingRuleForAccount(accountId, ruleId);
    console.log(
      `[dxfeed] ChangeTradingRuleForAccount ok order=${link.orderNumber} account=${accountId} rule=${ruleId}`,
    );
  } catch (err) {
    const reason = (err as Error).message;
    // Stale cache / deleted rule — clear and retry once with fresh List.
    if (/not found/i.test(reason)) {
      clearPhase1TradingRuleCache();
      const fresh = await resolvePhase1TradingRuleId();
      if (fresh && fresh !== ruleId) {
        try {
          await propfirm.changeTradingRuleForAccount(accountId, fresh);
          console.log(
            `[dxfeed] ChangeTradingRuleForAccount retry ok order=${link.orderNumber} rule=${fresh}`,
          );
          void syncTradingRuleById(fresh).catch(() => {});
          return { ok: true, ruleId: fresh };
        } catch (e2) {
          return { ok: false, ruleId: fresh, reason: (e2 as Error).message };
        }
      }
    }
    console.warn(
      `[dxfeed] ChangeTradingRuleForAccount failed order=${link.orderNumber}:`,
      reason.slice(0, 240),
    );
    return { ok: false, ruleId, reason };
  }

  void syncTradingRuleById(ruleId).catch((e) => {
    console.warn("[dxfeed] sync after ChangeTradingRuleForAccount:", (e as Error).message.slice(0, 160));
  });

  return { ok: true, ruleId };
}
