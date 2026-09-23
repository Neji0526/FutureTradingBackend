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

/** Process-lifetime cache so we do not List rules on every agreement poll. */
let cachedPhase1RuleId: string | null | undefined;

function looksLikeRuleUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/**
 * Resolve Volumetrica Trading Rule UUID for 50K Evaluation (Phase 1).
 * Prefer DXFEED_DEFAULT_RULE_ID, then synced RuleTemplate, then TradingRule/List.
 */
export async function resolvePhase1TradingRuleId(): Promise<string | null> {
  const fromEnv = config.dxfeed.provisioning.ruleId.trim();
  if (fromEnv && looksLikeRuleUuid(fromEnv)) return fromEnv;
  if (fromEnv) {
    // Non-UUID env value — still try as ruleId (some orgs use opaque ids).
    return fromEnv;
  }

  if (cachedPhase1RuleId !== undefined) return cachedPhase1RuleId;

  if (useDatabase) {
    try {
      const { rows } = await getPool().query<{ id: string; externalReference: string | null }>(
        `SELECT "id", "externalReference" FROM "RuleTemplate"
         WHERE "id" = ANY($1::text[])
            OR "externalReference" = ANY($1::text[])
            OR upper("label") LIKE '%50K%PHASE 1%'
            OR upper("label") LIKE '%50K%PHASE1%'
         ORDER BY
           CASE WHEN "source" = 'dxfeed' THEN 0 ELSE 1 END,
           CASE WHEN "id" = 'PRIME_50K_EVAL_PHASE1' THEN 0 ELSE 1 END
         LIMIT 1`,
        [PHASE1_REFS as unknown as string[]],
      );
      const row = rows[0];
      if (row) {
        const ext = row.externalReference?.trim() || "";
        if (ext && looksLikeRuleUuid(ext)) {
          cachedPhase1RuleId = ext;
          return ext;
        }
        if (looksLikeRuleUuid(row.id)) {
          cachedPhase1RuleId = row.id;
          return row.id;
        }
      }
    } catch (err) {
      console.warn("[dxfeed] resolve Phase1 rule from DB:", (err as Error).message.slice(0, 160));
    }
  }

  try {
    const rules = await propfirm.listTradingRules();
    for (const rule of rules) {
      const ruleId = typeof rule.ruleId === "string" ? rule.ruleId.trim() : "";
      if (!ruleId) continue;
      const ref = String(
        rule.organizationReferenceId
          ?? rule.reference
          ?? rule.Reference
          ?? "",
      ).trim().toUpperCase();
      const desc = String(rule.description ?? rule.Description ?? "").trim().toUpperCase();
      const hit =
        PHASE1_REFS.some((r) => ref === r.toUpperCase() || desc === r.toUpperCase())
        || (ref.includes("50K") && ref.includes("PHASE1"))
        || (desc.includes("50K") && desc.includes("PHASE 1"))
        || (desc.includes("50K") && desc.includes("PHASE1"));
      if (hit) {
        cachedPhase1RuleId = ruleId;
        console.log(`[dxfeed] resolved Phase1 trading ruleId=${ruleId} ref=${ref || desc}`);
        return ruleId;
      }
    }
  } catch (err) {
    console.warn("[dxfeed] resolve Phase1 rule via List:", (err as Error).message.slice(0, 200));
  }

  cachedPhase1RuleId = null;
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

  const ruleId = await resolvePhase1TradingRuleId();
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
    console.warn(
      `[dxfeed] ChangeTradingRuleForAccount failed order=${link.orderNumber}:`,
      reason.slice(0, 240),
    );
    return { ok: false, ruleId, reason };
  }

  // Keep Vault RuleTemplate aligned with the rule we just attached.
  void syncTradingRuleById(ruleId).catch((e) => {
    console.warn("[dxfeed] sync after ChangeTradingRuleForAccount:", (e as Error).message.slice(0, 160));
  });

  return { ok: true, ruleId };
}
