import { config } from "../config.js";
import {
  IdReference,
  type NewUserInput, type UserResult,
  type NewTradingAccountInput, type NewTradingAccountResult,
  type NewSubscriptionInput, type SubscriptionResult,
  type SubscriptionView,
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

  private async request<T>(
    path: string,
    actionLabel: string,
    opts: { method?: "GET" | "POST" | "PUT" | "DELETE"; query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const method = opts.method ?? (opts.body ? "POST" : "GET");
    const url = new URL(path, this.baseUrl);
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
    if (!res.ok) throw new DxFeedApiError(actionLabel, res.status, text);

    if (!text) return undefined as T;
    const json = JSON.parse(text) as unknown;
    if (json && typeof json === "object" && "success" in json && "data" in json) {
      return (json as { data: T }).data;
    }
    return json as T;
  }

  /** Propfirm API V1 — default for all account/user/subscription actions. */
  private async call<T>(
    action: string,
    opts: { method?: "GET" | "POST"; query?: Query; body?: unknown } = {},
  ): Promise<T> {
    return this.request<T>(`/api/Propsite/${action}`, action, opts);
  }

  /**
   * Propfirm API V2 — used only where V1 has no equivalent (TradingRule/List).
   * Do not migrate other actions to V2 without an explicit product decision.
   */
  private async callV2<T>(
    path: string,
    opts: { method?: "GET" | "POST" | "PUT" | "DELETE"; query?: Query; body?: unknown } = {},
  ): Promise<T> {
    const label = `v2/${path}`;
    return this.request<T>(`/api/v2/Propsite/${path}`, label, opts);
  }

  /**
   * V2 GET /api/v2/Propsite/User?userId= — returns null when user does not exist.
   * @see https://dxfeed.volumetricaprop.com/swagger/index.html
   */
  async getUserV2(userId: string): Promise<Record<string, unknown> | null> {
    const id = userId.trim();
    if (!id) return null;
    try {
      const data = await this.callV2<Record<string, unknown> | null>("User", {
        method: "GET",
        query: { userId: id },
      });
      if (!data || typeof data !== "object") return null;
      return data;
    } catch (err) {
      if (err instanceof DxFeedApiError && (err.status === 404 || /not found/i.test(err.message))) {
        return null;
      }
      throw err;
    }
  }

  /**
   * V2 POST /api/v2/Propsite/User — create user (prefer over V1 NewUser for new flows).
   * Prefill country/name so agreement signing works.
   */
  async createUserV2(input: NewUserInput): Promise<UserResult> {
    return this.callV2<UserResult>("User", { method: "POST", body: input });
  }

  /**
   * V2 PUT /api/v2/Propsite/User?userId= — update existing user (e.g. rotate password).
   */
  async updateUserV2(userId: string, input: NewUserInput): Promise<UserResult> {
    return this.callV2<UserResult>("User", {
      method: "PUT",
      query: { userId },
      body: input,
    });
  }

  /** @deprecated Prefer createUserV2 / updateUserV2 (V2 Propsite/User). */
  newUser(input: NewUserInput): Promise<UserResult> {
    return this.call<UserResult>("NewUser", { method: "POST", body: input });
  }

  /**
   * SSO / magic login into Volumetrica dashboard (Platforms → Deepchart license + download).
   * POST /api/Propsite/LoginUrl — returns a short-lived URL string.
   */
  async getLoginUrl(userId: string, accountId?: string | null): Promise<string | null> {
    try {
      const data = await this.call<string | { url?: string; loginUrl?: string }>("LoginUrl", {
        method: "POST",
        body: {
          userId,
          ...(accountId ? { accountId } : {}),
        },
      });
      if (typeof data === "string" && data.startsWith("http")) return data;
      if (data && typeof data === "object") {
        const url = data.url ?? data.loginUrl;
        if (typeof url === "string" && url.startsWith("http")) return url;
      }
    } catch {
      /* optional on some hosts */
    }
    return null;
  }

  createTradingAccount(input: NewTradingAccountInput): Promise<NewTradingAccountResult> {
    return this.call<NewTradingAccountResult>("CreateTradingAccount", { method: "POST", body: input });
  }

  /**
   * Associate an org trading rule with an existing account (fills Admin "Account rule id").
   * V2 POST /api/v2/Propsite/TradingAccount/ChangeTradingRule
   * Requires accountRuleReference=Application (0) — V1 ChangeTradingRuleForAccount returns "Rule not found".
   * @see https://dxfeed.volumetricaprop.com/swagger/index.html
   */
  async changeTradingRuleForAccount(accountId: string, ruleId: string): Promise<void> {
    await this.callV2<unknown>("TradingAccount/ChangeTradingRule", {
      method: "POST",
      body: {
        accountId,
        accountRuleReference: IdReference.APPLICATION,
        ruleId,
      },
    });
  }

  newSubscription(input: NewSubscriptionInput): Promise<SubscriptionResult> {
    return this.call<SubscriptionResult>("NewSubscription", { method: "POST", body: input });
  }

  /**
   * V2 GET /api/v2/Propsite/Subscription — SubscriptionViewModel
   * (volumetricaLicense, volumetricaDownloadLink, volumetricaPlatform).
   */
  async getSubscriptionV2(
    userId?: string | null,
    subscriptionId?: string | null,
  ): Promise<SubscriptionView | null> {
    try {
      const raw = await this.callV2<unknown>("Subscription", {
        query: {
          userId: userId || undefined,
          subscriptionId: subscriptionId || undefined,
        },
      });
      return normalizeSubscriptionView(raw);
    } catch (err) {
      if (err instanceof DxFeedApiError && err.status === 404) return null;
      throw err;
    }
  }

  /** V2 POST /api/v2/Propsite/Subscription — create subscribed platform account. */
  async createSubscriptionV2(input: NewSubscriptionInput): Promise<SubscriptionView> {
    const raw = await this.callV2<unknown>("Subscription", { method: "POST", body: input });
    const view = normalizeSubscriptionView(raw);
    if (!view) throw new DxFeedApiError("v2/Subscription", 502, "empty SubscriptionViewModel");
    return view;
  }

  /** V2 PUT /api/v2/Propsite/Subscription — update (e.g. set volumetricaPlatform). */
  async updateSubscriptionV2(
    subscriptionId: string,
    input: NewSubscriptionInput,
  ): Promise<SubscriptionView | null> {
    const raw = await this.callV2<unknown>("Subscription", {
      method: "PUT",
      query: { subscriptionId },
      body: input,
    });
    return normalizeSubscriptionView(raw);
  }

  /** V2 POST /api/v2/Propsite/Subscription/Active */
  async activeSubscriptionV2(subscriptionId: string): Promise<SubscriptionView | null> {
    const raw = await this.callV2<unknown>("Subscription/Active", {
      method: "POST",
      body: { subscriptionId },
    });
    return normalizeSubscriptionView(raw);
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

  /** Active trading account ids (Propsite GetEnabledAccountsId). */
  getEnabledAccountsId(): Promise<string[]> {
    return this.call<string[]>("GetEnabledAccountsId");
  }

  getAccountInfo(accountId: string): Promise<{ tradingRuleId?: string | null }> {
    return this.call<{ tradingRuleId?: string | null }>("GetAccountInfo", {
      query: { accountId },
    });
  }

  /** Single global/account trading rule by Volumetrica rule UUID (V1). */
  getTradingRule(ruleId: string): Promise<Record<string, unknown>> {
    return this.call<Record<string, unknown>>("GetTradingRule", { query: { ruleId } });
  }

  /**
   * All organization trading rules (Propfirm API V2 only).
   * GET /api/v2/Propsite/TradingRule/List — V1 has no list endpoint.
   */
  async listTradingRules(opts: { skip?: number; take?: number } = {}): Promise<Record<string, unknown>[]> {
    const skip = opts.skip ?? -1;
    const take = opts.take ?? -1;
    const table = await this.callV2<{
      data?: unknown;
      recordsTotal?: number;
      recordsFiltered?: number;
    }>("TradingRule/List", { query: { skip, take } });

    const rows = unwrapTradingRuleListRows(table);
    return rows.map((rule) => {
      const ruleId = typeof rule.ruleId === "string" ? rule.ruleId : undefined;
      return ruleId ? { ...rule, ruleId } : rule;
    });
  }

  /**
   * REST auto-sync source: V2 TradingRule/List (full catalog).
   * `previouslySyncedRuleIds` marks Vault templates whose dx rule UUID is no longer listed (deleted upstream).
   */
  async fetchTradingRulesFromRest(previouslySyncedRuleIds: string[] = []): Promise<{
    rules: Record<string, unknown>[];
    missingRuleIds: string[];
  }> {
    const rules = await this.listTradingRules();
    const listedIds = new Set<string>();
    for (const rule of rules) {
      const rid = typeof rule.ruleId === "string" ? rule.ruleId.trim() : "";
      if (rid) listedIds.add(rid);
    }

    const missingRuleIds: string[] = [];
    for (const id of previouslySyncedRuleIds) {
      const t = id?.trim();
      if (t && !listedIds.has(t)) missingRuleIds.push(t);
    }

    return { rules, missingRuleIds };
  }

  /** @deprecated Prefer fetchTradingRulesFromRest (V2 TradingRule/List). */
  async getTradingRules(): Promise<unknown> {
    const { rules } = await this.fetchTradingRulesFromRest();
    return rules;
  }
}

/** Normalize V2 DataTable payload: `{ data: Rule[] }` or a bare Rule[]. */
function unwrapTradingRuleListRows(table: unknown): Record<string, unknown>[] {
  if (Array.isArray(table)) {
    return table.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
  }
  if (!table || typeof table !== "object") return [];
  const nested = (table as { data?: unknown }).data;
  if (Array.isArray(nested)) {
    return nested.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object");
  }
  return [];
}

function normalizeSubscriptionView(raw: unknown): SubscriptionView | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested = (o.data && typeof o.data === "object" && !Array.isArray(o.data)
    ? o.data
    : o) as Record<string, unknown>;

  const subscriptionId = nested.subscriptionId;
  if (typeof subscriptionId !== "string" || !subscriptionId) return null;

  const signedRaw = nested.dxAgreementSigned;
  const dxAgreementSigned =
    signedRaw === true
    || signedRaw === 1
    || signedRaw === "1"
    || signedRaw === "true";

  const platform = nested.platform;
  return {
    subscriptionId,
    confirmationId: typeof nested.confirmationId === "string" ? nested.confirmationId : null,
    status: typeof nested.status === "number" ? nested.status : null,
    dxAgreementLink: typeof nested.dxAgreementLink === "string" ? nested.dxAgreementLink : null,
    dxAgreementSigned,
    platform: typeof platform === "number" ? (platform as SubscriptionView["platform"]) : null,
    volumetricaPlatform:
      typeof nested.volumetricaPlatform === "string"
        ? nested.volumetricaPlatform
        : nested.volumetricaPlatform != null
          ? String(nested.volumetricaPlatform)
          : null,
    volumetricaLicense:
      typeof nested.volumetricaLicense === "string" && nested.volumetricaLicense.trim()
        ? nested.volumetricaLicense.trim()
        : null,
    volumetricaDownloadLink:
      typeof nested.volumetricaDownloadLink === "string"
        && nested.volumetricaDownloadLink.startsWith("http")
        ? nested.volumetricaDownloadLink
        : null,
    userId: typeof nested.userId === "string" ? nested.userId : null,
  };
}

export const propfirm = new PropfirmClient();
