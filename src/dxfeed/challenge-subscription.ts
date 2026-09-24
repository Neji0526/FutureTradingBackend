/**
 * Challenge fail → deactivate the user's Volumetrica subscription (Status: Active → Disabled).
 * Vault reset → reset the Volumetrica trading account and re-activate the subscription,
 * otherwise the next poll would see ChallengeFailed again and re-fail the account.
 * Every step checks the remote state first, so webhook + poll + RiskEngine can all call it.
 */
import { dxfeedProvisionReady, useDatabase } from "../config.js";
import { getPool } from "../db/pool.js";
import { propfirm } from "./propfirm.js";
import {
  getDxFeedLinkByUserId,
  getLinkByAccountId,
  getLinkByDxUserId,
  upsertDxFeedLink,
  type DxFeedLink,
} from "./store.js";
import { AccountStatus } from "./types.js";

const SUBSCRIPTION_DISABLED = 0;
const SUBSCRIPTION_ACTIVE = 1;

const inFlight = new Set<string>();

async function resolveSubscription(
  dxUserId: string | null,
  subscriptionId: string | null,
): Promise<{ id: string; status: number | null } | null> {
  const view = dxUserId || subscriptionId
    ? await propfirm.getSubscriptionV2(dxUserId, subscriptionId).catch(() => null)
    : null;
  const id = view?.subscriptionId ?? subscriptionId;
  return id ? { id, status: view?.status ?? null } : null;
}

async function saveSubscriptionStatus(link: DxFeedLink | null, subscriptionId: string, status: number) {
  if (!link) return;
  if (link.subscriptionStatus === status && link.dxSubscriptionId === subscriptionId) return;
  await upsertDxFeedLink({ ...link, dxSubscriptionId: subscriptionId, subscriptionStatus: status });
}

async function linkForVaultAccount(vaultAccountId: string): Promise<DxFeedLink | null> {
  if (!useDatabase) return null;
  const { rows } = await getPool().query<{ userId: string }>(
    `SELECT "userId" FROM "Account" WHERE "id" = $1`,
    [vaultAccountId],
  );
  const userId = rows[0]?.userId;
  return userId ? getDxFeedLinkByUserId(userId) : null;
}

/**
 * Deactivate the Volumetrica subscription that owns this trading account / dx user.
 * Works without a Vault user link (only needs the DxFeedAccount row or the dx userId).
 */
export async function deactivateSubscriptionOnFail(
  ref: { dxAccountId?: string | null; dxUserId?: string | null },
  reason: string,
): Promise<boolean> {
  if (!dxfeedProvisionReady) return false;
  const link =
    (ref.dxAccountId ? await getLinkByAccountId(ref.dxAccountId) : null)
    ?? (ref.dxUserId ? await getLinkByDxUserId(ref.dxUserId) : null);
  const dxUserId = link?.dxUserId || ref.dxUserId || null;
  const key = dxUserId ?? ref.dxAccountId ?? "";
  if (!key || inFlight.has(key)) return false;
  inFlight.add(key);
  try {
    const sub = await resolveSubscription(dxUserId, link?.dxSubscriptionId ?? null);
    if (!sub) {
      console.warn(`[dxfeed] challenge failed but no subscription found (dxUser=${dxUserId ?? "?"})`);
      return false;
    }
    if (sub.status === SUBSCRIPTION_DISABLED) {
      await saveSubscriptionStatus(link, sub.id, SUBSCRIPTION_DISABLED);
      return false;
    }

    try {
      await propfirm.deactivateSubscription(sub.id);
    } catch (err) {
      console.warn(`[dxfeed] V1 DeactiveSubscription failed, trying V2:`, (err as Error).message.slice(0, 160));
      await propfirm.deactivateSubscriptionV2(sub.id);
    }
    await saveSubscriptionStatus(link, sub.id, SUBSCRIPTION_DISABLED);
    console.warn(
      `[dxfeed] challenge failed → subscription ${sub.id.slice(0, 8)}… deactivated ` +
        `(dxUser=${dxUserId ?? "?"}) — ${reason}`,
    );
    return true;
  } finally {
    inFlight.delete(key);
  }
}

/** Vault RiskEngine failed the account → deactivate the linked Volumetrica subscription. */
export async function deactivateSubscriptionForVaultAccount(
  vaultAccountId: string,
  reason: string,
): Promise<boolean> {
  const link = await linkForVaultAccount(vaultAccountId);
  if (!link) return false;
  return deactivateSubscriptionOnFail(
    { dxAccountId: link.dxAccountId, dxUserId: link.dxUserId },
    reason,
  );
}

/**
 * Vault reset → reset the Volumetrica trading account (if it is still ChallengeFailed)
 * and re-activate the subscription (if it is not Active).
 */
export async function reactivateAfterVaultReset(vaultAccountId: string): Promise<void> {
  if (!dxfeedProvisionReady) return;
  const link = await linkForVaultAccount(vaultAccountId);
  if (!link) return;

  if (link.dxAccountId) {
    const info = await propfirm.getAccountInfo(link.dxAccountId).catch(() => null);
    if (info?.status === AccountStatus.CHALLENGE_FAILED) {
      try {
        await propfirm.resetTradingAccountV2(link.dxAccountId, AccountStatus.ENABLED);
      } catch (err) {
        console.warn(`[dxfeed] V2 TradingAccount/Reset failed, trying EnableTradingAccount:`, (err as Error).message.slice(0, 160));
        await propfirm.enableTradingAccount(link.dxAccountId);
      }
      await upsertDxFeedLink({ ...link, accountStatus: AccountStatus.ENABLED });
      console.log(`[dxfeed] Vault reset → trading account ${link.dxAccountId.slice(0, 8)}… reset on Volumetrica`);
    }
  }

  const sub = await resolveSubscription(link.dxUserId || null, link.dxSubscriptionId);
  if (!sub || sub.status === SUBSCRIPTION_ACTIVE) return;
  try {
    await propfirm.activeSubscriptionV2(sub.id);
  } catch (err) {
    console.warn(`[dxfeed] V2 Subscription/Active failed, trying V1:`, (err as Error).message.slice(0, 160));
    await propfirm.activeSubscription(sub.id);
  }
  const fresh = (link.dxAccountId ? await getLinkByAccountId(link.dxAccountId) : null) ?? link;
  await saveSubscriptionStatus(fresh, sub.id, SUBSCRIPTION_ACTIVE);
  console.log(`[dxfeed] Vault reset → subscription ${sub.id.slice(0, 8)}… re-activated`);
}
