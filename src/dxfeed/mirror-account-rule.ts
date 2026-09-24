/**
 * Mirror Volumetrica "Account rule id" → Vault Account.ruleTemplateId + Rule row.
 * Minimal reverse sync when admin changes a user's rule in dxFeed Admin.
 * Does NOT reset balances / positions (unlike adminAssignTier).
 */
import { useDatabase } from "../config.js";
import { getPool } from "../db/pool.js";
import { propfirm } from "./propfirm.js";
import { mirrorVaultStatusFromDxAccount } from "./mirror-account-status.js";

function challengePhaseForTemplatePhase(phase: string | null | undefined): number {
  return phase === "Challenge Phase 1" ? 1 : 2;
}

/** Resolve Vault RuleTemplate.id from a Volumetrica tradingRuleId UUID. */
export async function findTemplateIdByDxRuleId(dxRuleId: string): Promise<string | null> {
  const id = dxRuleId.trim();
  if (!id || !useDatabase) return null;
  const { rows } = await getPool().query<{ id: string }>(
    `SELECT "id" FROM "RuleTemplate"
     WHERE "externalReference" = $1 OR "id" = $1
     ORDER BY CASE WHEN "source" = 'dxfeed' THEN 0 ELSE 1 END
     LIMIT 1`,
    [id],
  );
  return rows[0]?.id ?? null;
}

/**
 * Soft-apply a RuleTemplate onto a Vault account: update template link + Rule limits only.
 */
async function softApplyTemplate(
  vaultAccountId: string,
  templateId: string,
): Promise<boolean> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const tpl = await client.query(
      `SELECT "phase","maxDailyLoss","maxDrawdown","profitTarget","maxContracts",
              "minTradingDays","maxDailyProfitPct","maxRiskPerTrade","maxPositionUnits",
              "stopLossRequired","minHoldTimeSecs","overnightHoldsProhibited","weekendHoldsProhibited",
              "drawdownType","allowedInstruments"
       FROM "RuleTemplate" WHERE "id" = $1`,
      [templateId],
    );
    const t = tpl.rows[0];
    if (!t) {
      await client.query("ROLLBACK");
      return false;
    }
    const phase = challengePhaseForTemplatePhase(t.phase as string | null);
    await client.query(
      `UPDATE "Account" SET
         "ruleTemplateId" = $2,
         "challengePhase" = $3,
         "updatedAt" = now()
       WHERE "id" = $1`,
      [vaultAccountId, templateId, phase],
    );
    await client.query(
      `INSERT INTO "Rule" (
         "accountId","maxDailyLoss","maxDrawdown","profitTarget","maxContracts",
         "minTradingDays","maxDailyProfitPct","maxRiskPerTrade","maxPositionUnits",
         "stopLossRequired","minHoldTimeSecs","overnightHoldsProhibited","weekendHoldsProhibited",
         "drawdownType","allowedInstruments","updatedAt"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT ("accountId") DO UPDATE SET
         "maxDailyLoss" = EXCLUDED."maxDailyLoss", "maxDrawdown" = EXCLUDED."maxDrawdown",
         "profitTarget" = EXCLUDED."profitTarget", "maxContracts" = EXCLUDED."maxContracts",
         "minTradingDays" = EXCLUDED."minTradingDays", "maxDailyProfitPct" = EXCLUDED."maxDailyProfitPct",
         "maxRiskPerTrade" = EXCLUDED."maxRiskPerTrade", "maxPositionUnits" = EXCLUDED."maxPositionUnits",
         "stopLossRequired" = EXCLUDED."stopLossRequired", "minHoldTimeSecs" = EXCLUDED."minHoldTimeSecs",
         "overnightHoldsProhibited" = EXCLUDED."overnightHoldsProhibited",
         "weekendHoldsProhibited" = EXCLUDED."weekendHoldsProhibited",
         "drawdownType" = EXCLUDED."drawdownType", "allowedInstruments" = EXCLUDED."allowedInstruments",
         "updatedAt" = now()`,
      [
        vaultAccountId,
        Number(t.maxDailyLoss),
        Number(t.maxDrawdown),
        Number(t.profitTarget),
        Number(t.maxContracts),
        Number(t.minTradingDays),
        Number(t.maxDailyProfitPct),
        Number(t.maxRiskPerTrade),
        Number(t.maxPositionUnits),
        Boolean(t.stopLossRequired),
        Number(t.minHoldTimeSecs),
        Boolean(t.overnightHoldsProhibited),
        Boolean(t.weekendHoldsProhibited),
        t.drawdownType,
        (t.allowedInstruments as string[] | null) ?? [],
      ],
    );
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * For one Volumetrica trading account: read tradingRuleId → map to RuleTemplate →
 * soft-update the linked Vault Account (via DxFeedAccount.userId).
 */
export async function mirrorVaultTierFromDxAccount(
  dxAccountId: string,
): Promise<{ ok: boolean; reason?: string; templateId?: string }> {
  if (!useDatabase) return { ok: false, reason: "no database" };
  const accountId = dxAccountId.trim();
  if (!accountId) return { ok: false, reason: "missing dxAccountId" };

  let tradingRuleId: string | null = null;
  try {
    const info = await propfirm.getAccountInfo(accountId);
    const raw = info?.tradingRuleId;
    tradingRuleId = typeof raw === "string" && raw.trim() ? raw.trim() : null;
    try {
      await mirrorVaultStatusFromDxAccount(accountId, info ?? {});
    } catch (err) {
      console.warn(
        `[dxfeed] mirror account status ${accountId.slice(0, 8)}:`,
        (err as Error).message.slice(0, 160),
      );
    }
  } catch (err) {
    return { ok: false, reason: `GetAccountInfo: ${(err as Error).message.slice(0, 160)}` };
  }
  if (!tradingRuleId) {
    return { ok: false, reason: "no tradingRuleId on Volumetrica account" };
  }

  const templateId = await findTemplateIdByDxRuleId(tradingRuleId);
  if (!templateId) {
    return {
      ok: false,
      reason: `no RuleTemplate for ruleId=${tradingRuleId} — wait for TradingRule/List sync`,
    };
  }

  const { rows } = await getPool().query<{ vaultAccountId: string; ruleTemplateId: string | null }>(
    `SELECT a."id" AS "vaultAccountId", a."ruleTemplateId"
     FROM "DxFeedAccount" d
     JOIN "Account" a ON a."userId" = d."userId"
     WHERE d."dxAccountId" = $1 AND d."userId" IS NOT NULL
     ORDER BY d."updatedAt" DESC
     LIMIT 1`,
    [accountId],
  );
  const row = rows[0];
  if (!row) {
    return { ok: false, reason: "no Vault Account linked to this dxFeed account (userId missing)" };
  }
  if (row.ruleTemplateId === templateId) {
    return { ok: true, templateId, reason: "already in sync" };
  }

  const applied = await softApplyTemplate(row.vaultAccountId, templateId);
  if (!applied) return { ok: false, reason: "softApply failed" };

  console.log(
    `[dxfeed] mirrored Account rule → Vault tier dxAccount=${accountId.slice(0, 8)}… ` +
      `vault=${row.vaultAccountId.slice(0, 8)}… template=${templateId}` +
      (row.ruleTemplateId ? ` (was ${row.ruleTemplateId})` : ""),
  );
  return { ok: true, templateId };
}

/**
 * Poll helper: mirror rule + status for every DxFeedAccount with a dxAccountId
 * (rows without a Vault userId still get the challenge-fail subscription deactivation).
 * Called from the existing TradingRule REST watch (no new scheduler).
 */
export async function mirrorAllLinkedAccountRules(): Promise<{ checked: number; updated: number }> {
  if (!useDatabase) return { checked: 0, updated: 0 };
  const { rows } = await getPool().query<{ dxAccountId: string }>(
    `SELECT DISTINCT "dxAccountId" FROM "DxFeedAccount"
     WHERE "dxAccountId" IS NOT NULL`,
  );
  let updated = 0;
  for (const row of rows) {
    try {
      const result = await mirrorVaultTierFromDxAccount(row.dxAccountId);
      if (result.ok && result.reason !== "already in sync") updated += 1;
    } catch (err) {
      console.warn(
        `[dxfeed] mirror account rule ${row.dxAccountId.slice(0, 8)}:`,
        (err as Error).message.slice(0, 160),
      );
    }
  }
  return { checked: rows.length, updated };
}
