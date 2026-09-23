/**
 * Attach a Volumetrica trading rule to a dxFeed trading account.
 *
 * Flow (at registration / CreateTradingAccount):
 *   1. dxUserId + dxAccountId already saved
 *   2. GET TradingRule/List — pick Evaluation Phase 1, else first listed rule
 *   3. ChangeTradingRuleForAccount → fills Admin "Account rule id"
 *
 * Also safe to call again on Complete onboarding (idempotent).
 *
 * @see https://dxfeed.volumetricaprop.com/swagger/index.html
 */
import { config, dxfeedProvisionReady, useDatabase } from "../config.js";
import { getPool } from "../db/pool.js";
import { propfirm } from "./propfirm.js";
import { getDxFeedLinkByOrder, upsertDxFeedLink, type DxFeedLink } from "./store.js";
import { syncTradingRuleById } from "./trading-rules-sync.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let cachedDefaultRuleId: string | null | undefined;

function looksLikeRuleUuid(value: string): boolean {
  return UUID_RE.test(value.trim());
}

function extractRuleId(rule: Record<string, unknown>): string | null {
  for (const key of ["ruleId", "RuleId", "id", "Id"] as const) {
    const v = rule[key];
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (!s) continue;
    if (looksLikeRuleUuid(s) || key.toLowerCase() === "ruleid") return s;
  }
  return null;
}

function ruleLabels(rule: Record<string, unknown>): { ref: string; desc: string; hay: string } {
  const ref = String(
    rule.organizationReferenceId ?? rule.reference ?? rule.Reference ?? "",
  )
    .trim()
    .toUpperCase();
  const desc = String(rule.description ?? rule.Description ?? "")
    .trim()
    .toUpperCase();
  return { ref, desc, hay: `${ref} ${desc}` };
}

/** Prefer Evaluation Phase 1; avoid Phase 2 / funded. */
function phase1Score(rule: Record<string, unknown>): number {
  const { ref, desc, hay } = ruleLabels(rule);
  if (!hay.trim()) return 0;

  if (
    /\bPHASE\s*2\b/.test(hay)
    || /\bPHASE_2\b/.test(hay)
    || /\bPHASE2\b/.test(hay)
    || (/\bFUND/.test(hay) && !/\bEVAL/.test(hay))
  ) {
    return 0;
  }

  let score = 0;
  if (ref === "PRIME_50K_EVAL_PHASE1" || desc === "50K - EVALUATION (PHASE 1)") score += 100;
  if (/\bPHASE\s*1\b/.test(hay) || /\bPHASE_1\b/.test(hay) || /\bPHASE1\b/.test(hay)) score += 40;
  if (/\bEVAL/.test(hay) || /\bEVALUATION\b/.test(hay) || /\bCHALLENGE\b/.test(hay)) score += 25;
  if (/\b50K\b/.test(hay) || /\b50000\b/.test(hay)) score += 15;
  if (ref.includes("EVAL_PHASE1") || ref.endsWith("PHASE1")) score += 20;
  return score;
}

function pickFromList(
  rules: Record<string, unknown>[],
): { ruleId: string; score: number; label: string; source: "phase1" | "first" } | null {
  let best: { ruleId: string; score: number; label: string; source: "phase1" | "first" } | null = null;
  for (const rule of rules) {
    const score = phase1Score(rule);
    if (score < 40) continue;
    const ruleId = extractRuleId(rule);
    if (!ruleId) continue;
    const { ref, desc } = ruleLabels(rule);
    const label = desc || ref || ruleId;
    if (!best || score > best.score) best = { ruleId, score, label, source: "phase1" };
  }
  if (best) return best;

  // User requirement: if no Phase 1 match, use the first rule from List.
  for (const rule of rules) {
    const ruleId = extractRuleId(rule);
    if (!ruleId) continue;
    const { ref, desc } = ruleLabels(rule);
    return { ruleId, score: 0, label: desc || ref || ruleId, source: "first" };
  }
  return null;
}

async function verifyTradingRuleId(ruleId: string): Promise<string | null> {
  const id = ruleId.trim();
  if (!id) return null;
  try {
    const rule = await propfirm.getTradingRule(id);
    if (!rule || typeof rule !== "object") return null;
    return extractRuleId(rule) || id;
  } catch (err) {
    console.warn(
      `[dxfeed] GetTradingRule(${id.slice(0, 36)}) failed:`,
      (err as Error).message.slice(0, 160),
    );
    return null;
  }
}

export function clearPhase1TradingRuleCache(): void {
  cachedDefaultRuleId = undefined;
}

/**
 * Resolve default trading rule for new accounts.
 * 1) TradingRule/List — Phase 1 preferred, else first rule
 * 2) Optional DXFEED_DEFAULT_RULE_ID
 * 3) Synced RuleTemplate rows
 */
export async function resolvePhase1TradingRuleId(): Promise<string | null> {
  if (cachedDefaultRuleId !== undefined) return cachedDefaultRuleId;

  try {
    const rules = await propfirm.listTradingRules();
    const picked = pickFromList(rules);
    if (picked) {
      cachedDefaultRuleId = picked.ruleId;
      console.log(
        `[dxfeed] default rule from TradingRule/List ruleId=${picked.ruleId} via=${picked.source} label=${picked.label}`,
      );
      return picked.ruleId;
    }
    console.warn(`[dxfeed] TradingRule/List returned ${rules.length} rule(s); none had a ruleId`);
  } catch (err) {
    console.warn("[dxfeed] TradingRule/List failed:", (err as Error).message.slice(0, 200));
  }

  const fromEnv = config.dxfeed.provisioning.ruleId.trim();
  if (fromEnv) {
    const verified = await verifyTradingRuleId(fromEnv);
    if (verified) {
      cachedDefaultRuleId = verified;
      console.log(`[dxfeed] default rule from DXFEED_DEFAULT_RULE_ID=${verified}`);
      return verified;
    }
  }

  if (useDatabase) {
    try {
      const { rows } = await getPool().query<{ id: string; externalReference: string | null }>(
        `SELECT "id", "externalReference" FROM "RuleTemplate"
         WHERE "source" = 'dxfeed'
            OR upper(coalesce("id", '')) LIKE '%PHASE1%'
            OR upper(coalesce("label", '')) LIKE '%PHASE 1%'
            OR upper(coalesce("label", '')) LIKE '%PHASE1%'
         ORDER BY CASE WHEN "source" = 'dxfeed' THEN 0 ELSE 1 END
         LIMIT 10`,
      );
      for (const row of rows) {
        const ext = row.externalReference?.trim() || "";
        if (ext) {
          const verified = await verifyTradingRuleId(ext);
          if (verified) {
            cachedDefaultRuleId = verified;
            return verified;
          }
        }
        if (looksLikeRuleUuid(row.id)) {
          const verified = await verifyTradingRuleId(row.id);
          if (verified) {
            cachedDefaultRuleId = verified;
            return verified;
          }
        }
      }
    } catch (err) {
      console.warn("[dxfeed] resolve default rule from DB:", (err as Error).message.slice(0, 160));
    }
  }

  cachedDefaultRuleId = null;
  console.warn("[dxfeed] No trading rule in TradingRule/List — create one in Volumetrica Admin");
  return null;
}

/**
 * Set Account rule id on the Volumetrica trading account for this dxFeed user.
 * Call right after CreateTradingAccount (and again on Complete as a safety net).
 */
export async function ensureVolumetricaTradingRule(
  link: Pick<DxFeedLink, "orderNumber" | "dxAccountId" | "dxUserId">,
): Promise<{ ok: boolean; ruleId?: string; reason?: string; accountId?: string }> {
  if (!dxfeedProvisionReady) {
    return { ok: false, reason: "dxfeed not configured" };
  }

  let accountId = link.dxAccountId?.trim() || "";
  if (!accountId && link.dxUserId) {
    try {
      const accounts = await propfirm.getUserAccounts(link.dxUserId);
      const first = accounts.find((a) => typeof a.id === "string" && a.id.trim())?.id?.trim();
      if (first) {
        accountId = first;
        try {
          const full = await getDxFeedLinkByOrder(link.orderNumber);
          if (full && !full.dxAccountId) {
            full.dxAccountId = first;
            await upsertDxFeedLink(full);
          }
        } catch {
          /* non-fatal */
        }
      }
    } catch (err) {
      console.warn(
        `[dxfeed] GetUserAccounts order ${link.orderNumber}:`,
        (err as Error).message.slice(0, 160),
      );
    }
  }
  if (!accountId) {
    return { ok: false, reason: `no dxAccountId for order ${link.orderNumber}` };
  }

  clearPhase1TradingRuleCache();
  const ruleId = await resolvePhase1TradingRuleId();
  if (!ruleId) {
    return {
      ok: false,
      accountId,
      reason: "No trading rule found in Volumetrica TradingRule/List",
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
    return { ok: false, ruleId, accountId, reason };
  }

  void syncTradingRuleById(ruleId).catch((e) => {
    console.warn("[dxfeed] sync after ChangeTradingRuleForAccount:", (e as Error).message.slice(0, 160));
  });

  return { ok: true, ruleId, accountId };
}
