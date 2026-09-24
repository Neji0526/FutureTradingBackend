/**
 * Mirror Volumetrica "ChallengeFailed" → Vault Account.status = FAILED
 * and deactivate the user's Volumetrica subscription.
 * The fail itself runs through RiskEngine (liquidate, Violation, ActivityLog, live push),
 * registered from index.ts via setChallengeFailHandler.
 */
import { useDatabase } from "../config.js";
import { getPool } from "../db/pool.js";
import { AccountStatus } from "./types.js";
import { deactivateSubscriptionOnFail, isBlockedAccountStatus } from "./challenge-subscription.js";

export type ExternalViolation = "DAILY_LOSS_EXCEEDED" | "MAX_DRAWDOWN_BREACHED";
type ChallengeFailHandler = (
  vaultAccountId: string,
  violation: ExternalViolation,
  detail: string,
) => Promise<void>;

let failHandler: ChallengeFailHandler | null = null;

export function setChallengeFailHandler(handler: ChallengeFailHandler): void {
  failHandler = handler;
}

function violationForReason(reason: string): ExternalViolation {
  return /daily/i.test(reason) ? "DAILY_LOSS_EXCEEDED" : "MAX_DRAWDOWN_BREACHED";
}

/**
 * If Volumetrica reports ChallengeFailed or Disabled for this trading account, deactivate
 * the subscription. On ChallengeFailed also fail the linked Vault account
 * (only while it is still ACTIVE — idempotent across webhook + poll).
 */
export async function mirrorVaultStatusFromDxAccount(
  dxAccountId: string,
  info: { status?: number | null; reason?: string | null },
): Promise<{ failed: boolean; reason?: string }> {
  if (!isBlockedAccountStatus(info.status)) return { failed: false };

  const platformReason = info.reason?.trim()
    || (info.status === AccountStatus.DISABLED ? "trading account disabled" : "a risk rule was breached");
  try {
    await deactivateSubscriptionOnFail({ dxAccountId }, platformReason);
  } catch (err) {
    console.warn(
      `[dxfeed] deactivate subscription ${dxAccountId.slice(0, 8)}:`,
      (err as Error).message.slice(0, 160),
    );
  }

  if (info.status !== AccountStatus.CHALLENGE_FAILED) return { failed: false };
  if (!useDatabase) return { failed: false, reason: "no database" };
  const { rows } = await getPool().query<{ vaultAccountId: string; status: string }>(
    `SELECT a."id" AS "vaultAccountId", a."status"
     FROM "DxFeedAccount" d
     JOIN "Account" a ON a."userId" = d."userId"
     WHERE d."dxAccountId" = $1 AND d."userId" IS NOT NULL
     ORDER BY d."updatedAt" DESC
     LIMIT 1`,
    [dxAccountId],
  );
  const row = rows[0];
  if (!row) return { failed: false, reason: "no Vault Account linked" };
  if (row.status !== "ACTIVE") return { failed: false, reason: `already ${row.status}` };

  if (!failHandler) {
    console.warn("[dxfeed] ChallengeFailed received but no fail handler registered");
    return { failed: false, reason: "no fail handler" };
  }

  const detail = `Challenge failed on trading platform: ${platformReason}`;
  await failHandler(row.vaultAccountId, violationForReason(platformReason), detail);
  console.warn(
    `[dxfeed] Volumetrica ChallengeFailed → Vault FAILED dxAccount=${dxAccountId.slice(0, 8)}… ` +
      `vault=${row.vaultAccountId.slice(0, 8)}… — ${platformReason}`,
  );
  return { failed: true };
}
