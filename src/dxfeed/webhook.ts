import { config } from "../config.js";
import {
  getLinkByAccountId,
  getLinkByDxUserId,
  getLinkBySubscriptionId,
  upsertDxFeedLink,
} from "./store.js";
import { propfirm } from "./propfirm.js";
import { AccountStatus } from "./types.js";
import {
  dxFeedApiKeyOk,
  extractTradingRulesFromBody,
  syncTradingRulesFromBody,
} from "./trading-rules-sync.js";

export const NotificationCategory = {
  ACCOUNTS: 0,
  OVERNIGHT: 1,
  SUBSCRIPTIONS: 2,
  TRADE_REPORT: 3,
  PORTFOLIO: 4,
  ORG_USER: 5,
  /** Volumetrica Trading Rules admin changes (or custom webhook category). */
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
  tradingRule?: unknown;
  tradingRules?: unknown;
  rules?: unknown;
}

export interface WebhookResult { status: number; note: string }

/**
 * Volumetrica webhook — authenticated with DXFEED_API_KEY (x-api-key).
 * Must 200 on processing errors so their queue is not blocked.
 * 401 only when the key is missing/wrong (never process unauthenticated).
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
    await dispatch(ev, body);
    return { status: 200, note: `category=${ev.category} event=${ev.event}` };
  } catch (err) {
    console.warn("[dxfeed webhook] processing error (ack 200 anyway):", (err as Error).message);
    return { status: 200, note: "error swallowed" };
  }
}

async function dispatch(ev: WebhookEvent, rawBody: unknown): Promise<void> {
  // Trading-rule payloads may arrive as category=6 OR as a body that simply
  // contains tradingRule(s) — accept both so Admin rule edits always land.
  const rulePayloads = extractTradingRulesFromBody(rawBody);
  if (ev.category === NotificationCategory.TRADING_RULES || rulePayloads.length > 0) {
    if (rulePayloads.length > 0) {
      const results = await syncTradingRulesFromBody(rawBody);
      const ok = results.filter((r) => r.applied).length;
      console.log(`[dxfeed webhook] trading rules synced ${ok}/${results.length}`);
    } else if (ev.category === NotificationCategory.TRADING_RULES) {
      // Volumetrica often notifies "rule changed" without embedding the rule.
      // Pull the full list so wiped RuleTemplate rows are recreated on update.
      console.warn(
        "[dxfeed webhook] TRADING_RULES with no parseable rule body — pulling GetTradingRules/GetAccountRules",
      );
      try {
        const remote = await propfirm.getTradingRules();
        const results = await syncTradingRulesFromBody({ data: remote });
        const ok = results.filter((r) => r.applied).length;
        console.log(`[dxfeed webhook] trading rules pull-fallback synced ${ok}/${results.length}`);
      } catch (err) {
        console.warn(
          "[dxfeed webhook] trading rules pull-fallback failed:",
          (err as Error).message,
          "— POST /api/dxfeed/trading-rules/pull with x-api-key to sync manually",
        );
      }
    }
    if (ev.category === NotificationCategory.TRADING_RULES) return;
    // If category was something else but body also carried rules, fall through
    // so account/subscription updates still process.
  }

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
        }
      }
      return;
    }
    default:
      return;
  }
}
