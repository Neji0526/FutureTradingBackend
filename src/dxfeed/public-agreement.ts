import { issueAgreementOpenTicket } from "./open-ticket.js";

/**
 * Client-facing agreement payload — never includes the raw dxFeed URL or
 * internal subscription status codes. When `mintTicket` is true and a URL
 * exists, issues a one-time `openTicket` the browser redeems via /open.
 */
export function publicAgreementFields(opts: {
  orderNumber: string;
  email: string;
  agreementSigned: boolean;
  agreementLink: string | null | undefined;
  mintTicket: boolean;
  ready?: boolean;
  required?: boolean;
}): Record<string, unknown> {
  const required = opts.required !== false;
  const signed = opts.agreementSigned === true || !required;
  const hasUrl = Boolean(opts.agreementLink?.trim()) && !signed;
  const openTicket =
    opts.mintTicket && hasUrl
      ? issueAgreementOpenTicket(opts.orderNumber, opts.email, opts.agreementLink)
      : null;

  return {
    ok: true,
    required,
    agreementSigned: signed,
    hasLink: hasUrl,
    /** Opaque one-time handle — redeem via POST .../dxfeed-agreement/open */
    openTicket: openTicket ?? undefined,
    ready: opts.ready ?? true,
    /** Hint for UI copy — Vault enforces single redeem of this ticket. */
    openOnce: true,
  };
}
