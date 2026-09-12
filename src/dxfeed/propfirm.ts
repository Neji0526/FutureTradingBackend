import { config } from "../config.js";
import type {
  NewUserInput, UserResult,
  NewTradingAccountInput, NewTradingAccountResult,
  NewSubscriptionInput, SubscriptionResult,
} from "./types.js";

/** Volumetrica Propfirm REST client — authenticated with DXFEED_API_KEY (x-api-key). */

export class DxFeedApiError extends Error {
  constructor(
    readonly action: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`dxFeed ${action} failed (HTTP ${status}): ${body.slice(0, 500)}`);
    this.name = "DxFeedApiError";
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class PropfirmClient {
  constructor(
    private readonly baseUrl: string = config.dxfeed.propfirmUrl,
    private readonly apiKey: string = config.dxfeed.apiKey,
  ) {}

  private async call<T>(
    action: string,
    opts: { method?: "GET" | "POST"; query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const method = opts.method ?? (opts.body ? "POST" : "GET");
    const url = new URL(`/api/Propsite/${action}`, this.baseUrl);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }

    const res = await fetch(url, {
      method,
      headers: {
        "x-api-key": this.apiKey,
        ...(opts.body ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) throw new DxFeedApiError(action, res.status, text);

    if (!text) return undefined as T;
    const json = JSON.parse(text) as unknown;
    if (json && typeof json === "object" && "success" in json && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  newUser(input: NewUserInput): Promise<UserResult> {
    return this.call<UserResult>("NewUser", { method: "POST", body: input });
  }

  createTradingAccount(input: NewTradingAccountInput): Promise<NewTradingAccountResult> {
    return this.call<NewTradingAccountResult>("CreateTradingAccount", { method: "POST", body: input });
  }

  newSubscription(input: NewSubscriptionInput): Promise<SubscriptionResult> {
    return this.call<SubscriptionResult>("NewSubscription", { method: "POST", body: input });
  }

  getUserAccounts(userId: string): Promise<Array<{ id?: string; header?: string; enabled?: boolean }>> {
    return this.call<Array<{ id?: string; header?: string; enabled?: boolean }>>("GetUserAccounts", {
      query: { userId },
    });
  }

  /**
   * Fetch subscription by userId and/or subscriptionId.
   * Swagger: userId alone returns that user's subscription (subscriptionId may be omitted).
   */
  getSubscriptionStatus(userId?: string | null, subscriptionId?: string | null): Promise<unknown> {
    return this.call<unknown>("GetSubscriptionStatus", {
      query: {
        userId: userId || undefined,
        subscriptionId: subscriptionId || undefined,
      },
    });
  }

  enableTradingAccount(accountId: string): Promise<unknown> {
    return this.call<unknown>("EnableTradingAccount", { query: { accountId } });
  }

  disableTradingAccount(accountId: string, reason = "Vault onboarding reset", forceClose = true): Promise<unknown> {
    return this.call<unknown>("DisableTradingAccount", { query: { accountId, reason, forceClose } });
  }

  deleteTradingAccount(userId: string, accountId: string): Promise<unknown> {
    return this.call<unknown>("DeleteTradingAccount", { query: { userId, accountId } });
  }

  deactivateSubscription(subscriptionId: string): Promise<unknown> {
    return this.call<unknown>("DeactiveSubscription", { query: { subscriptionId } });
  }

  deleteSubscription(subscriptionId: string): Promise<unknown> {
    return this.call<unknown>("DeleteSubscription", { query: { subscriptionId } });
  }

  /** Note: Volumetrica query param is misspelled `subcriptionId` in their API. */
  updateSubscription(subscriptionId: string, body: NewSubscriptionInput): Promise<unknown> {
    return this.call<unknown>("UpdateSubscription", {
      method: "POST",
      query: { subcriptionId: subscriptionId },
      body,
    });
  }

  activeSubscription(subscriptionId: string): Promise<unknown> {
    return this.call<unknown>("ActiveSubscription", { query: { subscriptionId } });
  }
}

export const propfirm = new PropfirmClient();
