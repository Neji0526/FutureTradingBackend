import { config } from "../config.js";
import { getLinkByAccountId, getLinkByDxUserId, upsertDxFeedLink } from "./store.js";
import { AccountStatus } from "./types.js";

export const NotificationCategory = {
  ACCOUNTS: 0, OVERNIGHT: 1, SUBSCRIPTIONS: 2, TRADE_REPORT: 3, PORTFOLIO: 4, ORG_USER: 5,
} as const;

interface WebhookEvent {
  category?: number;
  event?: number;
  userId?: string | null;
  accountId?: string | null;
  tradingAccount?: {
    id?: string | null;
    status?: number;
    reason?: string | null;
  } | null;
  subscription?: {
    subscriptionId?: string | null;
    status?: number;
    dxAgreementSigned?: boolean;
    dxAgreementLink?: string | null;
  } | null;
}

export interface WebhookResult { status: number; note: string }

/**
 * Volumetrica webhook — authenticated with the same DXFEED_API_KEY (x-api-key).
 * Must 200 on processing errors so their queue is not blocked.
 */
export async function handleDxFeedWebhook(apiKey: string | undefined, body: unknown): Promise<WebhookResult> {
  if (!config.dxfeed.apiKey || apiKey !== config.dxfeed.apiKey) {
    return { status: 401, note: "bad or missing x-api-key" };
  }
  try {
    const ev = (body ?? {}) as WebhookEvent;
    await dispatch(ev);
    return { status: 200, note: `category=${ev.category} event=${ev.event}` };
  } catch (err) {
    console.warn("[dxfeed webhook] processing error (ack 200 anyway):", (err as Error).message);
    return { status: 200, note: "error swallowed" };
  }
}

async function dispatch(ev: WebhookEvent): Promise<void> {
  switch (ev.category) {
    case NotificationCategory.ACCOUNTS: {
      const accountId = ev.accountId ?? ev.tradingAccount?.id ?? null;
      if (!accountId) return;
      const link = await getLinkByAccountId(accountId);
      if (!link) return;
      const status = ev.tradingAccount?.status;
      if (status != null && status !== link.accountStatus) {
        link.accountStatus = status;
        await upsertDxFeedLink(link);
        if (status === AccountStatus.CHALLENGE_SUCCESS) {
          console.log(`[dxfeed] account ${accountId} CHALLENGE PASSED`);
        } else if (status === AccountStatus.DISABLED) {
          console.log(`[dxfeed] account ${accountId} DISABLED — ${ev.tradingAccount?.reason ?? "?"}`);
        }
      }
      return;
    }
    case NotificationCategory.SUBSCRIPTIONS: {
      const uid = ev.userId ?? null;
      if (!uid) return;
      const link = await getLinkByDxUserId(uid);
      if (!link) return;
      const sub = ev.subscription;
      if (sub) {
        if (sub.status != null) link.subscriptionStatus = sub.status;
        if (typeof sub.dxAgreementSigned === "boolean") link.agreementSigned = sub.dxAgreementSigned;
        if (sub.dxAgreementLink !== undefined) {
          link.agreementLink = sub.dxAgreementLink ?? link.agreementLink;
        }
        await upsertDxFeedLink(link);
        if (sub.dxAgreementSigned) {
          console.log(`[dxfeed] user ${uid} SIGNED the data agreement (order ${link.orderNumber})`);
        }
      }
      return;
    }
    default:
      return;
  }
}
