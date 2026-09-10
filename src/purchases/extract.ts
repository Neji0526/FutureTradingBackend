/**
 * Pull order number + buyer email out of a ClickFunnels (Classic / CF2) webhook
 * payload. CF payloads vary by funnel version, so we probe common shapes.
 */
export function extractPurchaseFields(payload: unknown): {
  orderNumber: string | null;
  email: string | null;
  productName: string | null;
  ip: string | null;
} {
  const root = asRecord(payload);
  // Our Next relay wraps as { source, receivedAt, data }.
  const data = asRecord(root?.data) ?? root;
  if (!data) return { orderNumber: null, email: null, productName: null, ip: null };

  const contact = asRecord(data.contact) ?? asRecord(data.Contact) ?? asRecord(data.buyer);
  const order =
    asRecord(data.order) ??
    asRecord(data.Order) ??
    asRecord(data.purchase) ??
    asRecord(data.Purchase) ??
    data;

  const email = firstString([
    data.email,
    data.Email,
    data.contact_email,
    data.buyer_email,
    contact?.email,
    contact?.Email,
    order?.email,
  ]);

  const orderNumber = firstString([
    data.order_number,
    data.orderNumber,
    data.order_id,
    data.orderId,
    data.purchase_id,
    data.purchaseId,
    data.id,
    order?.order_number,
    order?.orderNumber,
    order?.id,
    order?.number,
    order?.OrderId,
  ]);

  const productName = firstString([
    data.product_name,
    data.productName,
    data.product,
    order?.product_name,
    order?.productName,
    asRecord(data.products)?.name,
  ]);

  const ip = firstString([
    data.ip,
    data.ip_address,
    data.ipAddress,
    data.client_ip,
    data.clientIp,
    data.buyer_ip,
    data.buyerIp,
    contact?.ip,
    contact?.ip_address,
    contact?.ipAddress,
    contact?.last_ip,
    order?.ip,
    order?.ip_address,
    // Next relay may forward the original client IP explicitly.
    root?.clientIp,
    root?.client_ip,
  ]);

  return {
    orderNumber: orderNumber ? String(orderNumber).trim() : null,
    email: email ? String(email).trim().toLowerCase() : null,
    productName: productName ? String(productName).trim() : null,
    ip: ip ? String(ip).trim() : null,
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
