import type { IncomingMessage, ServerResponse } from "node:http";
import { createEvaluationAccount } from "../trading/repository.js";
import { dxfeedProvisionReady, useDatabase } from "../config.js";
import type { AuthService } from "../auth/service.js";
import type { UserStore } from "../auth/users.js";
import { getPurchaseStore } from "./store.js";
import { extractPurchaseFields } from "./extract.js";
import { getOnboardingProfileStore } from "./onboarding-profile.js";
import { adminDeactivateSubscription } from "../trading/admin-repository.js";
import { isValidOrderNumber, normalizeOrderNumber } from "./order-number.js";
import {
  provisionForOnboarding,
  refreshAgreementStatus,
  resetForOnboarding,
} from "../dxfeed/provision.js";
import { attachDxFeedUserId, getDxFeedLinkByOrder, getDxFeedLinksByEmail, upsertDxFeedLink } from "../dxfeed/store.js";
import { handleDxFeedWebhook } from "../dxfeed/webhook.js";
import { DxFeedApiError } from "../dxfeed/propfirm.js";
import {
  dxFeedApiKeyOk,
  syncTradingRulesFromBody,
} from "../dxfeed/trading-rules-sync.js";
import { adminListRuleTemplates } from "../trading/admin-repository.js";
import { propfirm } from "../dxfeed/propfirm.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;
type ReadJsonFn = <T>(req: IncomingMessage) => Promise<T | null>;

interface OnboardingCompleteBody {
  orderNumber?: string;
  email?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  ageRange?: string;
  country?: string;
  acceptTerms?: boolean | string;
  acceptRisk?: boolean | string;
}

interface DxFeedAgreementBody {
  orderNumber?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  country?: string;
}

/**
 * ClickFunnels → backend purchase webhook.
 * This is the ONLY way a Purchase row is created.
 */
export async function handleClickFunnelsWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  const expected = process.env.CLICKFUNNELS_WEBHOOK_SECRET?.trim();
  if (expected) {
    const header = req.headers["x-webhook-secret"];
    const url = new URL(req.url ?? "/", "http://localhost");
    const query = url.searchParams.get("secret");
    if (header !== expected && query !== expected) {
      json(res, 401, { error: "Unauthorized." });
      return;
    }
  }

  const payload = (await readJson<unknown>(req)) ?? {};
  const fields = extractPurchaseFields(payload);

  if (!fields.orderNumber || !isValidOrderNumber(fields.orderNumber)) {
    json(res, 400, { error: "Missing or invalid order number in webhook payload." });
    return;
  }
  if (!fields.email || !EMAIL_RE.test(fields.email)) {
    json(res, 400, { error: "Missing or invalid buyer email in webhook payload." });
    return;
  }

  const purchase = await getPurchaseStore().record({
    orderNumber: normalizeOrderNumber(fields.orderNumber),
    email: fields.email,
    productName: fields.productName,
    rawPayload: payload,
  });

  json(res, 200, {
    ok: true,
    purchase: {
      orderNumber: purchase.orderNumber,
      email: purchase.email,
      status: purchase.status,
    },
  });
}

/** Page-open gate: order must exist, be PAID, and unused. */
export async function handlePurchaseValidate(
  orderNumber: string,
  res: ServerResponse,
  json: JsonFn,
): Promise<void> {
  const normalized = normalizeOrderNumber(orderNumber);
  if (!isValidOrderNumber(normalized)) {
    json(res, 400, { ok: false, reason: "invalid_order" });
    return;
  }

  const purchase = await getPurchaseStore().findByOrderNumber(normalized);
  if (!purchase) {
    json(res, 404, { ok: false, reason: "not_found" });
    return;
  }
  if (purchase.status !== "PAID") {
    json(res, 409, { ok: false, reason: "already_used" });
    return;
  }

  json(res, 200, {
    ok: true,
    orderNumber: purchase.orderNumber,
    emailHint: maskEmail(purchase.email),
  });
}

/**
 * Start or resume Volumetrica provisioning (DXFEED_API_KEY) and return the
 * market-data agreement link for the first onboarding step.
 */
export async function handleDxFeedAgreementStart(
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  if (!dxfeedProvisionReady) {
    json(res, 200, {
      ok: true,
      required: false,
      agreementSigned: true,
      agreementLink: null,
      note: "DXFEED_API_KEY not set — agreement step skipped.",
    });
    return;
  }

  const body = (await readJson<DxFeedAgreementBody>(req)) ?? {};
  const orderNumber = normalizeOrderNumber(body.orderNumber?.trim() ?? "");
  const email = body.email?.trim().toLowerCase() ?? "";
  const firstName = body.firstName?.trim() ?? "";
  const lastName = body.lastName?.trim() ?? "";
  const country = body.country?.trim().toUpperCase() ?? "";

  if (!isValidOrderNumber(orderNumber)) return json(res, 400, { error: "Invalid order number." });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Invalid email." });
  if (firstName.length < 2 || lastName.length < 2) {
    return json(res, 400, { error: "Please enter your full name first." });
  }
  if (!COUNTRY_RE.test(country)) return json(res, 400, { error: "Country is required." });

  const purchase = await getPurchaseStore().findByOrderNumber(orderNumber);
  if (!purchase) return json(res, 404, { error: "Purchase not found." });
  if (purchase.status !== "PAID") {
    return json(res, 409, { error: "This purchase has already been used." });
  }
  if (purchase.email !== email) {
    return json(res, 403, { error: "Email must match the email used for the purchase." });
  }

  try {
    const link = await provisionForOnboarding({
      orderNumber,
      email,
      firstName,
      lastName,
      country,
    });
    json(res, 200, {
      ok: true,
      required: true,
      agreementSigned: link.agreementSigned,
      agreementLink: link.agreementLink,
      subscriptionStatus: link.subscriptionStatus,
    });
  } catch (err) {
    const message = err instanceof DxFeedApiError
      ? err.message
      : (err as Error).message || "Could not start dxFeed agreement.";
    console.error("[onboarding] dxFeed provision failed:", message);

    const alreadyExists = isDxFeedAlreadyExistsError(message);
    json(res, alreadyExists ? 409 : 502, {
      ok: false,
      code: alreadyExists ? "already_exists" : "provision_failed",
      error: alreadyExists
        ? "A dxFeed / Volumetrica account or subscription already exists for this email."
        : "Could not prepare the market data agreement.",
      detail: message.slice(0, 500),
      hint: alreadyExists
        ? "Use Reset & re-sign below to clear the old Volumetrica subscription for this paid order, then Prepare again. Or use Check status if you already signed."
        : "Refresh the page and try Prepare agreement again. If it keeps failing, use Reset & re-sign, then Prepare again.",
    });
  }
}

/**
 * Clear Volumetrica subscription/accounts + local DxFeedAccount for a still-PAID
 * purchase so the trader can Prepare and sign again (no repurchase).
 */
export async function handleDxFeedAgreementReset(
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  if (!dxfeedProvisionReady) {
    json(res, 200, { ok: true, required: false, reset: false });
    return;
  }

  const body = (await readJson<DxFeedAgreementBody>(req)) ?? {};
  const orderNumber = normalizeOrderNumber(body.orderNumber?.trim() ?? "");
  const email = body.email?.trim().toLowerCase() ?? "";
  const firstName = body.firstName?.trim() ?? "";
  const lastName = body.lastName?.trim() ?? "";
  const country = body.country?.trim().toUpperCase() ?? "";

  if (!isValidOrderNumber(orderNumber)) return json(res, 400, { error: "Invalid order number." });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Invalid email." });
  if (firstName.length < 2 || lastName.length < 2) {
    return json(res, 400, { error: "Please enter your full name first." });
  }
  if (!COUNTRY_RE.test(country)) return json(res, 400, { error: "Country is required." });

  const purchase = await getPurchaseStore().findByOrderNumber(orderNumber);
  if (!purchase) return json(res, 404, { error: "Purchase not found." });
  if (purchase.status !== "PAID") {
    return json(res, 409, { error: "This purchase has already been used." });
  }
  if (purchase.email !== email) {
    return json(res, 403, { error: "Email must match the email used for the purchase." });
  }

  try {
    const result = await resetForOnboarding({
      orderNumber,
      email,
      firstName,
      lastName,
      country,
    });
    json(res, 200, {
      ok: true,
      required: true,
      reset: true,
      agreementSigned: result.agreementSigned,
      agreementLink: result.agreementLink,
      clearedLocal: result.clearedLocal,
      deletedSubscription: result.deletedSubscription,
      notes: result.notes,
    });
  } catch (err) {
    const message = (err as Error).message || "Could not reset dxFeed agreement.";
    console.error("[onboarding] dxFeed reset failed:", message);
    json(res, 502, {
      ok: false,
      code: "reset_failed",
      error: "Could not reset the market data agreement.",
      detail: message.slice(0, 500),
      hint: "Try again in a moment. If it keeps failing, contact support with the details below.",
    });
  }
}

/** Poll / refresh whether the trader has signed the Volumetrica data agreement. */
export async function handleDxFeedAgreementStatus(
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  if (!dxfeedProvisionReady) {
    json(res, 200, {
      ok: true,
      required: false,
      agreementSigned: true,
      agreementLink: null,
    });
    return;
  }

  const body = (await readJson<{ orderNumber?: string; email?: string }>(req)) ?? {};
  const orderNumber = normalizeOrderNumber(body.orderNumber?.trim() ?? "");
  const email = body.email?.trim().toLowerCase() ?? "";

  if (!isValidOrderNumber(orderNumber)) return json(res, 400, { error: "Invalid order number." });

  const purchase = await getPurchaseStore().findByOrderNumber(orderNumber);
  if (!purchase) return json(res, 404, { error: "Purchase not found." });
  if (email && purchase.email !== email) {
    return json(res, 403, { error: "Email must match the email used for the purchase." });
  }

  // If this order has no local row yet, adopt any DxFeedAccount for the purchase email
  // so GetSubscriptionStatus can sync agreementSigned into this order's row.
  let link = await getDxFeedLinkByOrder(orderNumber);
  if (!link) {
    const matchEmail = email || purchase.email;
    const siblings = await getDxFeedLinksByEmail(matchEmail);
    const donor = siblings.find((l) => l.dxUserId);
    if (donor) {
      await upsertDxFeedLink({
        ...donor,
        orderNumber,
        email: matchEmail,
        userId: donor.userId,
      });
    }
  }

  link = await refreshAgreementStatus(orderNumber);
  if (!link) {
    json(res, 200, {
      ok: true,
      required: true,
      agreementSigned: false,
      agreementLink: null,
      ready: false,
    });
    return;
  }

  json(res, 200, {
    ok: true,
    required: true,
    agreementSigned: link.agreementSigned,
    agreementLink: link.agreementLink,
    subscriptionStatus: link.subscriptionStatus,
    ready: true,
  });
}

export async function handleDxFeedWebhookHttp(
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  const apiKeyHeader = req.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const body = await readJson<unknown>(req);
  const result = await handleDxFeedWebhook(apiKey, body);
  json(res, result.status, { ok: result.status === 200, note: result.note });
}

/**
 * Explicit Trading Rules upsert from dxFeed / Volumetrica Admin.
 * Protected by DXFEED_API_KEY (x-api-key). Cascades into every linked account Rule.
 *
 * Body examples:
 *   { "reference":"PRIME_50K_EVAL", "startBalance":50000, "maxDrawdown":2500, "dailyDrawdown":1250, "universe":"5/50" }
 *   { "tradingRules":[ {...}, {...} ] }
 */
export async function handleDxFeedTradingRulesUpsert(
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  const apiKeyHeader = req.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (!dxFeedApiKeyOk(apiKey)) {
    json(res, 401, { error: "Unauthorized. Provide a valid x-api-key." });
    return;
  }

  const body = (await readJson<unknown>(req)) ?? {};
  console.log("[dxfeed trading-rules] POST upsert received");
  try {
    const results = await syncTradingRulesFromBody(body);
    if (results.length === 0) {
      console.warn("[dxfeed trading-rules] upsert found 0 rules in body");
      json(res, 400, {
        error: "No trading rules found in body. Send tradingRule, tradingRules[], or a Reference object.",
      });
      return;
    }
    const synced = results.filter((r) => r.applied).length;
    console.log(`[dxfeed trading-rules] upsert ok — synced ${synced}/${results.length}`);
    json(res, 200, {
      ok: true,
      synced,
      results,
    });
  } catch (err) {
    console.warn("[dxfeed trading-rules] upsert error:", (err as Error).message);
    json(res, 500, { error: "Could not sync trading rules." });
  }
}

/**
 * Pull trading rules from Volumetrica Propsite (best-effort) and sync locally.
 * Protected by DXFEED_API_KEY. Safe to call periodically from an admin job.
 */
export async function handleDxFeedTradingRulesPull(
  req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
): Promise<void> {
  const apiKeyHeader = req.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (!dxFeedApiKeyOk(apiKey)) {
    json(res, 401, { error: "Unauthorized. Provide a valid x-api-key." });
    return;
  }

  console.log("[dxfeed trading-rules] POST pull — fetching GetTradingRules/GetAccountRules");
  try {
    const remote = await propfirm.getTradingRules();
    const pulled = Array.isArray(remote) ? remote.length : remote ? 1 : 0;
    console.log(`[dxfeed trading-rules] pull remote count=${pulled}`);
    const results = await syncTradingRulesFromBody({ data: remote });
    const synced = results.filter((r) => r.applied).length;
    console.log(`[dxfeed trading-rules] pull ok — synced ${synced}/${results.length}`);
    json(res, 200, {
      ok: true,
      pulled,
      synced,
      results,
    });
  } catch (err) {
    const message = err instanceof DxFeedApiError
      ? err.message
      : (err as Error).message;
    console.warn("[dxfeed trading-rules] pull error:", message);
    json(res, 502, {
      error: "Could not pull trading rules from dxFeed.",
      detail: message.slice(0, 300),
    });
  }
}

/** Public read of the rule templates currently enforced for traders. */
export async function handlePublicTradingRules(
  _req: IncomingMessage,
  res: ServerResponse,
  json: JsonFn,
): Promise<void> {
  if (!useDatabase) {
    json(res, 503, { error: "Database not configured." });
    return;
  }
  try {
    const templates = await adminListRuleTemplates();
    console.log(`[dxfeed rules] GET /api/trading-rules — returning ${templates.length} template(s)`);
    json(res, 200, {
      ok: true,
      source: "vault",
      note: "Limits are enforced from Rule rows cascaded from these templates. dxFeed Admin syncs overwrite mapped templates.",
      templates: templates.map((t) => ({
        id: t.id,
        label: t.label,
        phase: t.phase,
        accountSize: t.accountSize,
        maxDailyLoss: t.maxDailyLoss,
        maxDrawdown: t.maxDrawdown,
        profitTarget: t.profitTarget,
        maxContracts: t.maxContracts,
        maxPositionUnits: t.maxPositionUnits,
        maxRiskPerTrade: t.maxRiskPerTrade,
        minTradingDays: t.minTradingDays,
        maxDailyProfitPct: t.maxDailyProfitPct,
        minHoldTimeSecs: t.minHoldTimeSecs,
        stopLossRequired: t.stopLossRequired,
        overnightHoldsProhibited: t.overnightHoldsProhibited,
        weekendHoldsProhibited: t.weekendHoldsProhibited,
        drawdownType: t.drawdownType,
        updatedAt: t.updatedAt,
      })),
    });
  } catch (err) {
    console.warn("[trading-rules] list error:", (err as Error).message);
    json(res, 500, { error: "Could not load trading rules." });
  }
}

/**
 * Complete onboarding / registration: email must match the purchase, then create
 * the user, store the profile, provision an evaluation account, and burn the
 * order (one account per purchase).
 */
export async function handleOnboardingComplete(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthService,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  const body = (await readJson<OnboardingCompleteBody>(req)) ?? {};

  const orderNumber = normalizeOrderNumber(body.orderNumber?.trim() ?? "");
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const firstName = body.firstName?.trim() ?? "";
  const lastName = body.lastName?.trim() ?? "";
  const name = `${firstName} ${lastName}`.trim();
  const ageRange = body.ageRange?.trim() ?? "";
  const country = body.country?.trim().toUpperCase() ?? "";
  const acceptTerms = asBool(body.acceptTerms);
  const acceptRisk = asBool(body.acceptRisk);

  if (!isValidOrderNumber(orderNumber)) return json(res, 400, { error: "Invalid order number." });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Invalid email." });
  if (name.length < 2) return json(res, 400, { error: "Please enter your full name." });
  if (password.length < 8) return json(res, 400, { error: "Password must be at least 8 characters." });
  if (!ageRange) return json(res, 400, { error: "Age range is required." });
  if (!COUNTRY_RE.test(country)) return json(res, 400, { error: "Country is required." });
  if (!acceptTerms) return json(res, 400, { error: "You must accept the terms." });
  if (!acceptRisk) return json(res, 400, { error: "You must confirm the trading rules." });

  const store = getPurchaseStore();
  const purchase = await store.findByOrderNumber(orderNumber);

  if (!purchase) return json(res, 404, { error: "Purchase not found. Please purchase a subscription." });
  if (purchase.status !== "PAID") {
    return json(res, 409, { error: "This purchase has already been used." });
  }
  if (purchase.email !== email) {
    return json(res, 403, {
      error: "Email must match the email used for the purchase.",
    });
  }

  if (dxfeedProvisionReady) {
    const refreshed = await refreshAgreementStatus(orderNumber);
    const link = refreshed ?? (await getDxFeedLinkByOrder(orderNumber));
    if (!link?.dxSubscriptionId) {
      return json(res, 400, {
        error: "Complete the market data agreement before finishing.",
      });
    }
    if (!link.agreementSigned) {
      return json(res, 400, {
        error: "You must sign the dxFeed market data agreement before finishing.",
      });
    }
  }

  let userId: string;
  try {
    const result = await auth.register({ email, password, name });
    userId = result.user.id;
  } catch (err) {
    const message = (err as Error).message;
    if (message === "email already registered") {
      return json(res, 409, { error: "That email is already registered. Sign in instead." });
    }
    return json(res, 500, { error: "Could not create account." });
  }

  try {
    await getOnboardingProfileStore().save({
      userId,
      orderNumber,
      ageRange,
      country,
      acceptTerms,
      acceptRisk,
      // KYC uploads removed from onboarding — keep empty columns for schema compatibility.
      idType: "",
      addressType: "",
      idFileName: "",
      idFilePath: "",
      idMimeType: "",
      idSize: 0,
      addressFileName: "",
      addressFilePath: "",
      addressMimeType: "",
      addressSize: 0,
    });
  } catch (e) {
    console.error("[onboarding] profile save failed:", (e as Error).message);
    return json(res, 500, { error: "Could not save onboarding profile." });
  }

  const redeemed = await store.redeem(orderNumber, email, userId);
  if (!redeemed) {
    return json(res, 409, { error: "This purchase has already been used." });
  }

  if (dxfeedProvisionReady) {
    try {
      await attachDxFeedUserId(orderNumber, userId);
    } catch (e) {
      console.error("[onboarding] dxFeed userId attach failed:", (e as Error).message);
    }
  }

  if (useDatabase) {
    try {
      await createEvaluationAccount(userId);
    } catch (e) {
      console.error("[onboarding] account provisioning failed:", (e as Error).message);
    }
  }

  json(res, 201, {
    ok: true,
    orderNumber: redeemed.orderNumber,
    email: redeemed.email,
  });
}

/**
 * Admin: deactivate a trader's subscription — delete purchase rows, suspend the
 * user + account, and clear IP/session locks so login is blocked.
 */
export async function handleDeactivateSubscription(
  userId: string,
  users: UserStore,
): Promise<{ ok: boolean; purchasesRemoved: number; error?: string }> {
  if (!userId) return { ok: false, purchasesRemoved: 0, error: "user id required" };

  if (useDatabase) {
    const result = await adminDeactivateSubscription(userId);
    if (!result.ok) return { ok: false, purchasesRemoved: 0, error: "trader not found" };
    return { ok: true, purchasesRemoved: result.purchasesRemoved };
  }

  const removed = await getPurchaseStore().deleteByUserId(userId);
  const ok = await users.deactivateUser(userId);
  if (!ok) return { ok: false, purchasesRemoved: removed, error: "trader not found" };
  return { ok: true, purchasesRemoved: removed };
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1" || v === "on";
  return false;
}

function isDxFeedAlreadyExistsError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("already has a subscription") ||
    m.includes("already exists") ||
    m.includes("user already") ||
    m.includes("email already") ||
    m.includes("duplicate")
  );
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "***";
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}***@${domain}`;
}
