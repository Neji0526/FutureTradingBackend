import type { IncomingMessage } from "node:http";

/**
 * Best-effort client IP from proxy headers or the socket.
 * Used for audit logs (e.g. login ActivityLog), not for access control.
 */
export function clientIp(req: IncomingMessage): string | undefined {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return normalizeIp(fwd.split(",")[0]!.trim());
  if (Array.isArray(fwd) && fwd[0]) return normalizeIp(fwd[0].split(",")[0]!.trim());
  const real = req.headers["x-real-ip"];
  if (typeof real === "string" && real) return normalizeIp(real.trim());
  return normalizeIp(req.socket.remoteAddress ?? undefined);
}

/** Strip IPv6-mapped IPv4 prefix so "::ffff:1.2.3.4" matches "1.2.3.4". */
export function normalizeIp(ip: string | null | undefined): string | undefined {
  if (!ip) return undefined;
  const trimmed = ip.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("::ffff:")) return trimmed.slice(7);
  return trimmed;
}
