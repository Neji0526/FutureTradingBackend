import { createHash, randomBytes } from "node:crypto";

/** Short-lived, single-use handle that redeems the real dxFeed agreement URL. */

const TICKET_TTL_MS = 30 * 60 * 1000;

interface TicketRecord {
  orderNumber: string;
  emailHash: string;
  url: string;
  expiresAt: number;
}

const byToken = new Map<string, TicketRecord>();
/** Only one live ticket per order — issuing a new one burns the previous. */
const tokenByOrder = new Map<string, string>();

function hashEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

function purgeExpired(): void {
  const now = Date.now();
  for (const [token, rec] of byToken) {
    if (rec.expiresAt <= now) {
      byToken.delete(token);
      if (tokenByOrder.get(rec.orderNumber) === token) tokenByOrder.delete(rec.orderNumber);
    }
  }
}

/**
 * Mint an opaque one-time ticket for opening the agreement.
 * Returns null when there is no URL to protect.
 */
export function issueAgreementOpenTicket(
  orderNumber: string,
  email: string,
  agreementUrl: string | null | undefined,
): string | null {
  const url = agreementUrl?.trim();
  if (!url) return null;

  purgeExpired();
  const prev = tokenByOrder.get(orderNumber);
  if (prev) byToken.delete(prev);

  const token = randomBytes(32).toString("base64url");
  byToken.set(token, {
    orderNumber,
    emailHash: hashEmail(email),
    url,
    expiresAt: Date.now() + TICKET_TTL_MS,
  });
  tokenByOrder.set(orderNumber, token);
  return token;
}

export type ConsumeTicketResult =
  | { ok: true; url: string }
  | { ok: false; reason: "invalid" | "mismatch" | "expired" | "used" };

/** Redeem once — token is deleted whether or not email matches (anti-probe). */
export function consumeAgreementOpenTicket(
  token: string,
  orderNumber: string,
  email: string,
): ConsumeTicketResult {
  purgeExpired();
  const rec = byToken.get(token);
  if (!rec) return { ok: false, reason: "used" };

  byToken.delete(token);
  if (tokenByOrder.get(rec.orderNumber) === token) tokenByOrder.delete(rec.orderNumber);

  if (rec.expiresAt <= Date.now()) return { ok: false, reason: "expired" };
  if (rec.orderNumber !== orderNumber) return { ok: false, reason: "mismatch" };
  if (rec.emailHash !== hashEmail(email)) return { ok: false, reason: "mismatch" };
  return { ok: true, url: rec.url };
}

/** Drop any outstanding open ticket for this order (e.g. after reset). */
export function revokeAgreementOpenTickets(orderNumber: string): void {
  const prev = tokenByOrder.get(orderNumber);
  if (prev) {
    byToken.delete(prev);
    tokenByOrder.delete(orderNumber);
  }
}
