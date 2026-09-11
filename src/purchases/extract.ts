import { normalizeOrderNumber } from "./order-number.js";

/**
 * Pull order number + buyer email out of a ClickFunnels (Classic / CF2) webhook
 * payload. CF payloads vary by funnel version, so we probe common shapes.
 *
 * Real CF2 `subscription.trial_started` shape (Make / webhook):
 *   data.order_number = "#3327"
 *   data.contact.email_address = "buyer@…"
 *   data.line_items[0].original_product.name = "The Vault"
 */
export function extractPurchaseFields(payload: unknown): {
  orderNumber: string | null;
  email: string | null;
  productName: string | null;
} {
  const root = asRecord(payload);
  // Next relay / Make may wrap as { source, data } or CF event { data, event_type }.
  const data = asRecord(root?.data) ?? root;
  if (!data) return { orderNumber: null, email: null, productName: null };

  const contact =
    asRecord(data.contact) ?? asRecord(data.Contact) ?? asRecord(data.buyer);
  const order =
    asRecord(data.order) ??
    asRecord(data.Order) ??
    asRecord(data.purchase) ??
    asRecord(data.Purchase) ??
    null;

  const email = firstString([
    data.email,
    data.Email,
    data.email_address,
    data.contact_email,
    data.buyer_email,
    contact?.email,
    contact?.Email,
    contact?.email_address,
    order?.email,
    order?.email_address,
  ]);

  // Prefer human order_number ("#3327") over internal numeric id (6830508).
  const rawOrder = firstString([
    data.order_number,
    data.orderNumber,
    order?.order_number,
    order?.orderNumber,
    order?.number,
    data.purchase_id,
    data.purchaseId,
    // Fallbacks — only if CF omitted order_number
    data.order_id,
    data.orderId,
    order?.id,
    order?.OrderId,
    data.id,
  ]);
  const orderNumber = rawOrder ? normalizeOrderNumber(rawOrder) : null;

  const lineItems = Array.isArray(data.line_items) ? data.line_items : [];
  const firstItem = asRecord(lineItems[0]);
  const originalProduct = asRecord(firstItem?.original_product);
  const variant = asRecord(firstItem?.products_variant);

  const productName = firstString([
    data.product_name,
    data.productName,
    data.product,
    data.funnel_name,
    originalProduct?.name,
    variant?.name,
    order?.product_name,
    order?.productName,
    asRecord(data.products)?.name,
  ]);

  return {
    orderNumber: orderNumber || null,
    email: email ? String(email).trim().toLowerCase() : null,
    productName: productName ? String(productName).trim() : null,
  };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function firstString(values: unknown[]): string | null {
  for (const v of values) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}
