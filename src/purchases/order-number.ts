/**
 * ClickFunnels order numbers often look like "#3327". The leading "#" must never
 * appear raw in a query string (`?order=#3327` — the browser treats `#…` as a
 * fragment and the server sees an empty `order`). Strip it for storage, URLs,
 * and validation so "#3327" and "3327" resolve to the same purchase.
 */
export function normalizeOrderNumber(raw: string): string {
  return String(raw ?? "")
    .trim()
    .replace(/^#+/, "")
    .trim();
}

/** Canonical order id after normalize (no leading #). */
export const ORDER_NUMBER_RE = /^[A-Za-z0-9_-]{4,64}$/;

export function isValidOrderNumber(raw: string): boolean {
  return ORDER_NUMBER_RE.test(normalizeOrderNumber(raw));
}
