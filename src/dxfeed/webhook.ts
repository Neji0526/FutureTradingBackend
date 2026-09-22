import { config } from "../config.js";
import {
  getLinkByAccountId,
  getLinkByDxUserId,
  getLinkBySubscriptionId,
  upsertDxFeedLink,
} from "./store.js";
import { AccountStatus } from "./types.js";
import { dxFeedApiKeyOk } from "./trading-rules-sync.js";

export const NotificationCategory = {
  ACCOUNTS: 0,
  OVERNIGHT: 1,
  SUBSCRIPTIONS: 2,
  TRADE_REPORT: 3,
  PORTFOLIO: 4,
  ORG_USER: 5,
  TRADING_RULES: 6,
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
 * Volumetrica webhook — accounts / subscriptions only.
 * Trading-rule sync is REST auto-watch (V2 TradingRule/List), not webhook.
 */
export async function handleDxFeedWebhook(apiKey: string | undefined, body: unknown): Promise<WebhookResult> {
  if (!config.dxfeed.apiKey || !dxFeedApiKeyOk(apiKey)) {
    console.warn("[dxfeed webhook] rejected — bad or missing x-api-key");
    return { status: 401, note: "bad or missing x-api-key" };
  }
  try {
    const ev = (body ?? {}) as WebhookEvent;
    const keys = body && typeof body === "object" ? Object.keys(body as object).join(",") : typeof body;
    console.log(`[dxfeed webhook] recv category=${ev.category} event=${ev.event} keys=[${keys}]`);
    if (ev.category === NotificationCategory.TRADING_RULES) {
      console.log(
        "[dxfeed webhook] ignoring Trading Rules category — RuleTemplate sync uses REST watch only",
      );
      return { status: 200, note: "trading-rules ignored (REST watch)" };
    }
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
      const sub = ev.subscription;
      const uid = ev.userId ?? null;
      const subId = sub?.subscriptionId ?? null;
      const link =
        (uid ? await getLinkByDxUserId(uid) : null)
        ?? (subId ? await getLinkBySubscriptionId(subId) : null);
      if (!link) return;
      if (sub) {
        if (sub.subscriptionId) link.dxSubscriptionId = sub.subscriptionId;
        if (sub.status != null) link.subscriptionStatus = sub.status;
        if (typeof sub.dxAgreementSigned === "boolean") {
          link.agreementSigned = sub.dxAgreementSigned;
        }
        if (sub.dxAgreementLink !== undefined) {
          link.agreementLink = sub.dxAgreementLink ?? link.agreementLink;
        }
        await upsertDxFeedLink(link);
        if (sub.dxAgreementSigned) {
          console.log(`[dxfeed] user ${link.dxUserId} SIGNED the data agreement (order ${link.orderNumber})`);
          const { notifyMakeAfterAgreementSigned } = await import("./make-credentials.js");
          void notifyMakeAfterAgreementSigned(link.orderNumber).catch((e) => {
            console.error("[dxfeed webhook] Make after agreement failed:", (e as Error).message);
          });
        }
      }
      return;
    }
    default:
      return;
  }
}
