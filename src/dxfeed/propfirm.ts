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

  getSubscriptionStatus(userId: string, subscriptionId: string): Promise<unknown> {
    return this.call<unknown>("GetSubscriptionStatus", { query: { userId, subscriptionId } });
  }
}

export const propfirm = new PropfirmClient();
