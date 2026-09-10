import type { IncomingMessage, ServerResponse } from "node:http";
import { createEvaluationAccount } from "../trading/repository.js";
import { useDatabase } from "../config.js";
import type { AuthService } from "../auth/service.js";
import { getPurchaseStore } from "./store.js";
import { extractPurchaseFields } from "./extract.js";
import { getOnboardingProfileStore } from "./onboarding-profile.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ORDER_RE = /^[A-Za-z0-9_-]{4,64}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

type JsonFn = (res: ServerResponse, status: number, body: unknown) => void;
type ReadJsonFn = <T>(req: IncomingMessage) => Promise<T | null>;

interface UploadedDocMeta {
  fileName?: string;
  storedPath?: string;
  mimeType?: string;
  size?: number;
}

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
  idType?: string;
  addressType?: string;
  idDocument?: UploadedDocMeta;
  addressDocument?: UploadedDocMeta;
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

  if (!fields.orderNumber || !ORDER_RE.test(fields.orderNumber)) {
    json(res, 400, { error: "Missing or invalid order number in webhook payload." });
    return;
  }
  if (!fields.email || !EMAIL_RE.test(fields.email)) {
    json(res, 400, { error: "Missing or invalid buyer email in webhook payload." });
    return;
  }

  const purchase = await getPurchaseStore().record({
    orderNumber: fields.orderNumber,
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
  if (!ORDER_RE.test(orderNumber)) {
    json(res, 400, { ok: false, reason: "invalid_order" });
    return;
  }

  const purchase = await getPurchaseStore().findByOrderNumber(orderNumber);
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
    // Mask email slightly for the client — full match happens on redeem.
    emailHint: maskEmail(purchase.email),
  });
}

/**
 * Complete onboarding / registration: email must match the purchase, then create
 * the user, store KYC profile + document paths, provision an evaluation account,
 * and burn the order (one account per purchase).
 */
export async function handleOnboardingComplete(
  req: IncomingMessage,
  res: ServerResponse,
  auth: AuthService,
  json: JsonFn,
  readJson: ReadJsonFn,
): Promise<void> {
  const body = (await readJson<OnboardingCompleteBody>(req)) ?? {};

  const orderNumber = body.orderNumber?.trim() ?? "";
  const email = body.email?.trim().toLowerCase() ?? "";
  const password = body.password ?? "";
  const firstName = body.firstName?.trim() ?? "";
  const lastName = body.lastName?.trim() ?? "";
  const name = `${firstName} ${lastName}`.trim();
  const ageRange = body.ageRange?.trim() ?? "";
  const country = body.country?.trim().toUpperCase() ?? "";
  const acceptTerms = asBool(body.acceptTerms);
  const acceptRisk = asBool(body.acceptRisk);
  const idType = body.idType?.trim() ?? "";
  const addressType = body.addressType?.trim() ?? "";
  const idDocument = body.idDocument ?? {};
  const addressDocument = body.addressDocument ?? {};

  if (!ORDER_RE.test(orderNumber)) return json(res, 400, { error: "Invalid order number." });
  if (!EMAIL_RE.test(email)) return json(res, 400, { error: "Invalid email." });
  if (name.length < 2) return json(res, 400, { error: "Please enter your full name." });
  if (password.length < 8) return json(res, 400, { error: "Password must be at least 8 characters." });
  if (!ageRange) return json(res, 400, { error: "Age range is required." });
  if (!COUNTRY_RE.test(country)) return json(res, 400, { error: "Country is required." });
  if (!acceptTerms) return json(res, 400, { error: "You must accept the terms." });
  if (!acceptRisk) return json(res, 400, { error: "You must acknowledge the risk disclosure." });
  if (!idType) return json(res, 400, { error: "Identity document type is required." });
  if (!addressType) return json(res, 400, { error: "Address document type is required." });
  if (!isValidDoc(idDocument)) return json(res, 400, { error: "Identity document upload is required." });
  if (!isValidDoc(addressDocument)) {
    return json(res, 400, { error: "Proof of address upload is required." });
  }

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
      idType,
      addressType,
      idFileName: String(idDocument.fileName),
      idFilePath: String(idDocument.storedPath),
      idMimeType: String(idDocument.mimeType),
      idSize: Number(idDocument.size),
      addressFileName: String(addressDocument.fileName),
      addressFilePath: String(addressDocument.storedPath),
      addressMimeType: String(addressDocument.mimeType),
      addressSize: Number(addressDocument.size),
    });
  } catch (e) {
    console.error("[onboarding] profile save failed:", (e as Error).message);
    return json(res, 500, { error: "Could not save onboarding profile." });
  }

  const redeemed = await store.redeem(orderNumber, email, userId);
  if (!redeemed) {
    // Extremely rare race: order burned between check and redeem.
    return json(res, 409, { error: "This purchase has already been used." });
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

function isValidDoc(doc: UploadedDocMeta): boolean {
  return Boolean(
    doc.fileName?.trim() &&
      doc.storedPath?.trim() &&
      doc.mimeType?.trim() &&
      typeof doc.size === "number" &&
      Number.isFinite(doc.size) &&
      doc.size > 0,
  );
}

function asBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true" || v === "1" || v === "on";
  return false;
}

function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "***";
  const visible = user.slice(0, Math.min(2, user.length));
  return `${visible}***@${domain}`;
}
