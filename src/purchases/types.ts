/** A ClickFunnels purchase recorded only via the webhook — never from the website UI. */
export type PurchaseStatus = "PAID" | "REDEEMED";

export interface Purchase {
  id: string;
  orderNumber: string;
  email: string;
  status: PurchaseStatus;
  productName: string | null;
  rawPayload: unknown;
  userId: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

export interface RecordPurchaseInput {
  orderNumber: string;
  email: string;
  productName?: string | null;
  rawPayload?: unknown;
}

export interface PurchaseStore {
  /** Insert a paid purchase. Idempotent on orderNumber (returns existing if already present). */
  record(input: RecordPurchaseInput): Promise<Purchase>;
  findByOrderNumber(orderNumber: string): Promise<Purchase | null>;
  /** Mark PAID → REDEEMED and attach userId. Returns null if missing / not PAID / email mismatch. */
  redeem(orderNumber: string, email: string, userId: string): Promise<Purchase | null>;
}
