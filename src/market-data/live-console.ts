import type { MarketDataProvider } from "../providers/provider.js";
import type { Quote } from "../types.js";
import { INSTRUMENTS } from "../instruments.js";

export interface MarketLiveRow {
  symbol: string;
  name: string;
  state: "live" | "thin" | "flat" | "stale" | "missing";
  price: number | null;
  bid: number | null;
  ask: number | null;
  high24h: number | null;
  low24h: number | null;
  volume24h: number | null;
  change24h: number | null;
  ageSec: number | null;
  ts: number | null;
}

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
  return {
    provider: provider?.name ?? "none",
    at: new Date().toISOString(),
    markets: provider ? buildLiveRows(provider, latest) : [],
  };
}

function buildLiveRows(
  provider: MarketDataProvider,
  latest: Map<string, Quote>,
): MarketLiveRow[] {
  const now = Date.now();
  return INSTRUMENTS.map((inst) => {
    const q = latest.get(inst.symbol) ?? provider.getQuoteSnapshot(inst.symbol);
    if (!q) {
      return {
        symbol: inst.symbol,
        name: inst.name,
        state: "missing",
        price: null,
        bid: null,
        ask: null,
        high24h: null,
        low24h: null,
        volume24h: null,
        change24h: null,
        ageSec: null,
        ts: null,
      };
    }
    const ageMs = now - (q.ts || now);
    const flat =
      q.high24h === q.low24h && q.high24h === q.price && (q.volume24h ?? 0) === 0;
    const stale = ageMs > 5_000;
    let state: MarketLiveRow["state"] = "thin";
    if (flat) state = "flat";
    else if (stale) state = "stale";
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
    };
  });
}

function printLiveTable(providerName: string, rows: MarketLiveRow[]): void {
  const counts = { live: 0, thin: 0, flat: 0, stale: 0, missing: 0 };
  for (const r of rows) counts[r.state] += 1;

  const lines: string[] = [];
  lines.push("");
  lines.push("========== MARKET LIVE STATE ==========");
  lines.push(
    `provider=${providerName}  at=${new Date().toISOString()}  ` +
      `live=${counts.live} thin=${counts.thin} flat=${counts.flat} stale=${counts.stale} missing=${counts.missing}`,
  );
  lines.push(
    pad("SYM", 5) +
      pad("STATE", 9) +
      pad("LAST", 12) +
      pad("BID", 12) +
      pad("ASK", 12) +
      pad("HIGH", 12) +
      pad("LOW", 12) +
      pad("VOL24H", 10) +
      pad("AGE", 7),
  );
  lines.push("-".repeat(91));
  for (const r of rows) {
    lines.push(
      pad(r.symbol, 5) +
        pad(r.state, 9) +
        pad(fmt(r.price), 12) +
        pad(fmt(r.bid), 12) +
        pad(fmt(r.ask), 12) +
        pad(fmt(r.high24h), 12) +
        pad(fmt(r.low24h), 12) +
        pad(r.volume24h == null ? "—" : String(Math.round(r.volume24h)), 10) +
        pad(r.ageSec == null ? "—" : `${r.ageSec}s`, 7),
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
