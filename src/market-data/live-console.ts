import type { MarketDataProvider } from "../providers/provider.js";
import type { Quote } from "../types.js";
import { INSTRUMENTS } from "../instruments.js";
import { isMarketOpen } from "../trading/market-hours.js";

export interface MarketLiveRow {
  symbol: string;
  name: string;
  state: "live" | "thin" | "flat" | "stale" | "missing" | "closed" | "blocked";
  price: number | null;
  bid: number | null;
  ask: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  change24h: number | null;
  ageSec: number | null;
  ts: number | null;
  /** Exchange family when known (CME, CBOT, …). */
  exchange: string | null;
  /** False when gateway listed exchanges and this root is absent. */
  entitled: boolean;
  /** Operator/trader-facing reason (missing NYMEX, no candles, …). */
  reason: string | null;
}

/** Align with dxFeed stale resubscribe — thin products often tick >5s apart. */
const STALE_AGE_MS = 30_000;

/**
 * Backend market live console — prints every instrument's quote health to stdout
 * on an interval so it appears in Railway (or any host) API/deploy logs.
 *
 * Enable/tune with:
 *   MARKET_LIVE_CONSOLE=1          (default on)
 *   MARKET_LIVE_CONSOLE=0          (disable)
 *   MARKET_LIVE_CONSOLE_MS=15000   (interval, default 15s)
 */
let sharedLatest: Map<string, Quote> = new Map();
let sharedProvider: MarketDataProvider | null = null;

export function startMarketLiveConsole(provider: MarketDataProvider): () => void {
  const disabled =
    process.env.MARKET_LIVE_CONSOLE === "0" ||
    process.env.MARKET_LIVE_CONSOLE === "false";
  if (disabled) {
    console.log("[market-console] disabled (MARKET_LIVE_CONSOLE=0)");
    return () => {};
  }

  const intervalMs = Math.max(
    5_000,
    Number(process.env.MARKET_LIVE_CONSOLE_MS) || 15_000,
  );

  sharedProvider = provider;
  sharedLatest = new Map();

  const onQuote = (q: Quote) => {
    if (!q?.symbol || !(q.price > 0)) return;
    sharedLatest.set(q.symbol, q);
  };
  provider.on("quote", onQuote);

  const tick = () => {
    const rows = buildLiveRows(provider, sharedLatest);
    printLiveTable(provider.name, rows);
  };

  // First print after the feed has a moment to warm up.
  const warmup = setTimeout(tick, 8_000);
  const timer = setInterval(tick, intervalMs);
  console.log(
    `[market-console] logging all markets every ${intervalMs / 1000}s → Railway/API stdout`,
  );

  return () => {
    clearTimeout(warmup);
    clearInterval(timer);
    provider.off("quote", onQuote);
    if (sharedProvider === provider) sharedProvider = null;
  };
}

/** Snapshot used by GET /api/market/live-state. */
export function getMarketLiveState(): {
  provider: string;
  at: string;
  marketOpen: boolean;
  exchanges: string[];
  candleEntitled: boolean | null;
  markets: MarketLiveRow[];
} {
  const provider = sharedProvider;
  const latest = new Map(sharedLatest);
  if (provider) {
    for (const inst of INSTRUMENTS) {
      if (latest.has(inst.symbol)) continue;
      const snap = provider.getQuoteSnapshot(inst.symbol);
      if (snap) latest.set(inst.symbol, snap);
    }
  }
  const feed = provider?.getFeedStatus?.();
  return {
    provider: provider?.name ?? "none",
    at: new Date().toISOString(),
    marketOpen: isMarketOpen(),
    exchanges: feed?.exchanges ?? [],
    candleEntitled: feed?.candleEntitled ?? null,
    markets: provider ? buildLiveRows(provider, latest) : [],
  };
}

function buildLiveRows(
  provider: MarketDataProvider,
  latest: Map<string, Quote>,
): MarketLiveRow[] {
  const now = Date.now();
  const open = isMarketOpen();
  const feed = provider.getFeedStatus?.();
  const bySym = new Map(feed?.symbols.map((s) => [s.symbol, s]) ?? []);

  return INSTRUMENTS.map((inst) => {
    const meta = bySym.get(inst.symbol);
    const entitled = meta?.entitled ?? true;
    const exchange = meta?.exchange ?? null;
    const reason = meta?.reason ?? null;

    if (!entitled) {
      return {
        symbol: inst.symbol,
        name: inst.name,
        state: "blocked",
        price: null,
        bid: null,
        ask: null,
        high24h: null,
        low24h: null,
        volume24h: null,
        change24h: null,
        ageSec: null,
        ts: null,
        exchange,
        entitled: false,
        reason,
      };
    }

    const q = latest.get(inst.symbol) ?? provider.getQuoteSnapshot(inst.symbol);
    if (!q) {
      return {
        symbol: inst.symbol,
        name: inst.name,
        state: open ? "missing" : "closed",
        price: null,
        bid: null,
        ask: null,
        high24h: null,
        low24h: null,
        volume24h: null,
        change24h: null,
        ageSec: null,
        ts: null,
        exchange,
        entitled: true,
        reason: open
          ? (reason ?? "No quote yet — waiting for feed or check gateway entitlements")
          : "Market closed (CME Globex session)",
      };
    }

    const ageMs = now - (q.ts || now);
    const flat =
      q.high24h === q.low24h && q.high24h === q.price && (q.volume24h ?? 0) === 0;
    let state: MarketLiveRow["state"] = "thin";
    if (!open) state = "closed";
    else if (flat) state = "flat";
    else if (ageMs > STALE_AGE_MS) state = "stale";
    else if ((q.volume24h ?? 0) > 0) state = "live";

    return {
      symbol: inst.symbol,
      name: inst.name,
      state,
      price: q.price,
      bid: q.bid,
      ask: q.ask,
      high24h: q.high24h,
      low24h: q.low24h,
      volume24h: q.volume24h,
      change24h: q.change24h,
      ageSec: Number((ageMs / 1000).toFixed(1)),
      ts: q.ts,
      exchange,
      entitled: true,
      reason: state === "stale" ? "Feed quiet — backend will resubscribe" : reason,
    };
  });
}

function printLiveTable(providerName: string, rows: MarketLiveRow[]): void {
  const counts = {
    live: 0,
    thin: 0,
    flat: 0,
    stale: 0,
    missing: 0,
    closed: 0,
    blocked: 0,
  };
  for (const r of rows) counts[r.state] += 1;

  const feed = sharedProvider?.getFeedStatus?.();
  const lines: string[] = [];
  lines.push("");
  lines.push("========== MARKET LIVE STATE ==========");
  lines.push(
    `provider=${providerName}  at=${new Date().toISOString()}  marketOpen=${isMarketOpen()}  ` +
      `live=${counts.live} thin=${counts.thin} flat=${counts.flat} stale=${counts.stale} ` +
      `missing=${counts.missing} blocked=${counts.blocked} closed=${counts.closed}`,
  );
  if (feed) {
    const ex = feed.exchanges.length ? feed.exchanges.join(",") : "(unknown)";
    lines.push(
      `exchanges=${ex}  candleEntitled=${feed.candleEntitled === null ? "?" : feed.candleEntitled}`,
    );
  }
  lines.push(
    pad("SYM", 5) +
      pad("STATE", 9) +
      pad("EX", 7) +
      pad("LAST", 12) +
      pad("VOL24H", 10) +
      pad("AGE", 7) +
      "REASON",
  );
  lines.push("-".repeat(100));
  for (const r of rows) {
    lines.push(
      pad(r.symbol, 5) +
        pad(r.state, 9) +
        pad(r.exchange ?? "—", 7) +
        pad(fmt(r.price), 12) +
        pad(r.volume24h == null ? "—" : String(Math.round(r.volume24h)), 10) +
        pad(r.ageSec == null ? "—" : `${r.ageSec}s`, 7) +
        (r.reason ?? ""),
    );
  }
  lines.push("=======================================");
  lines.push("");
  console.log(lines.join("\n"));
}

function pad(s: string, n: number): string {
  const t = s.length > n ? s.slice(0, n) : s;
  return t + " ".repeat(Math.max(0, n - t.length));
}

function fmt(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1000) return n.toFixed(2);
  return String(n);
}
