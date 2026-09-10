import WebSocket from "ws";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { BaseProvider, round, synthBook } from "./provider.js";
import { aggregateCandles } from "./databento-shared.js";
import { INSTRUMENTS, getInstrument, type Category } from "../instruments.js";
import { computeDxFeedDatedSymbol } from "../contract-code.js";
import type { Candle } from "../types.js";

/* ------------------------------------------------------------------ *
 * DxFeedProvider — real-time market data via dxFeed's dxLink WebSocket
 * protocol (https://demo.dxfeed.com/dxlink-ws for the public demo feed).
 *
 * ADDITIVE / ISOLATED: this file is selected only when MARKET_DATA_MODE=dxfeed.
 * It does NOT import or modify any Databento code — Databento (shared/byo) keeps
 * working exactly as before. Drop-in for the SHARED path: MarketHub fans its
 * quotes out to charts and AccountStream consumes the same quotes as marks.
 *
 * dxLink flow (JSON frames over one socket, multiplexed by `channel`):
 *   SETUP → (SETUP + AUTH_STATE) → AUTH? → (AUTH_STATE:AUTHORIZED)
 *     → CHANNEL_REQUEST(FEED) → CHANNEL_OPENED → FEED_SETUP → FEED_SUBSCRIPTION
 *     → FEED_DATA (live) …  + KEEPALIVE every 30s.
 * Live channel (1) carries Quote/Trade/Summary; a second channel (3) is used
 * for on-demand Candle history snapshots (getHistory).
 * ------------------------------------------------------------------ */

const KEEPALIVE_MS = 30_000; // server default timeout is 60s; ping at half
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
const PROTOCOL_VERSION = "1.0.0-tradingbackend";
// Book/quote emit throttles (dxFeed Quote can tick many times/sec).
const BOOK_THROTTLE_MS = 200;
/** Emit at most this often per symbol, but always flush on a tick-sized price move. */
const QUOTE_EMIT_MIN_MS = 100;
// A candle-history snapshot is "done" once no new bars arrive for this long
// AFTER the first bar. Do not arm the idle timer until then — cold snapshots
// often take 1–3s before the first Candle event, and a pre-armed 700ms idle
// was finishing empty (blank charts, volume stuck at 0).
const HISTORY_IDLE_MS = 1_200;
/** Overall cap per candle request. No Candle entitlement → empty after this, then live bars. */
const HISTORY_MAX_MS = 2_500;
/** Cap how far back we ask dxFeed for candles (large windows stall or empty-out). */
const HISTORY_MAX_BARS = 2_500;
/** After an empty Candle snapshot, retry this root no sooner than this (ms). */
const CANDLE_MISS_BACKOFF_MS = 45_000;
const LIVE_BARS_FILE = path.join(process.cwd(), "data", "dxfeed-live-bars.json");
const LIVE_BARS_SAVE_MS = 5_000;

const CHANNEL_FEED = 1; // live Quote/Trade/Summary
const CHANNEL_HIST = 3; // on-demand Candle snapshots
const LIVE_BAR_CAP = 1500; // ~25h of live-built 1-minute bars per symbol

/** CME exchange suffix per root (continuous form: /NQ:XCME). */
const EXCHANGE_BY_ROOT: Record<string, string> = {
  ES: "XCME", MES: "XCME",
  NQ: "XCME", MNQ: "XCME",
  YM: "XCBT", MYM: "XCBT",
  CL: "XNYM", MCL: "XNYM",
  GC: "XCEC", MGC: "XCEC",
};

/**
 * Continuous-futures placeholders. Prefer dated front-month symbols at runtime
 * (see buildDatedSymbolMap) — many entitled endpoints stream trades/candles on
 * /NQU26:XCME while continuous /NQ:XCME only quotes. Override with
 * DXFEED_SYMBOL_MAP JSON when needed.
 */
const CONTINUOUS_SYMBOL_MAP: Record<string, string> = {
  ES: "/ES:XCME", MES: "/MES:XCME",
  NQ: "/NQ:XCME", MNQ: "/MNQ:XCME",
  YM: "/YM:XCBT", MYM: "/MYM:XCBT",
  CL: "/CL:XNYM", MCL: "/MCL:XNYM",
  GC: "/GC:XCEC", MGC: "/MGC:XCEC",
};

/** Demo-feed stand-ins so the plumbing can be exercised without futures entitlement. */
const DEMO_SYMBOL_MAP: Record<string, string> = {
  ES: "SPY", MES: "SPY", NQ: "QQQ", MNQ: "QQQ", YM: "DIA", MYM: "DIA",
  CL: "USO", MCL: "USO", GC: "GLD", MGC: "GLD",
};

/**
 * Micros trade the same price level as their mini — piggyback onto the parent's
 * dxFeed symbol (the proven ES→MES pattern). If the micro contract is silent on
 * the feed, it still gets live chart/quote data from the parent.
 */
const PARENT_OF: Record<string, string> = {
  MES: "ES", MNQ: "NQ", MYM: "YM", MCL: "CL", MGC: "GC",
};
const MICRO_OF: Record<string, string> = {
  ES: "MES", NQ: "MNQ", YM: "MYM", CL: "MCL", GC: "MGC",
};

/** Month codes used when stripping a dated CME root from an eventSymbol. */
const MONTH_CODE_RE = /[FGHJKMNQUVXZ]\d{1,2}$/;

interface SymState {
  price: number;
  bid: number;
  ask: number;
  dayOpen: number;
  prevClose: number;
  high: number;
  low: number;
  volume: number;
  havePrice: boolean;
  /** True once a Trade print has set the price (prefer trades over quote mids). */
  haveTrade: boolean;
}

interface HistPending {
  bars: Map<number, Candle>; // time(sec) → bar, deduped
  resolve: (bars: Candle[]) => void;
  idle: NodeJS.Timeout | null;
  cap: NodeJS.Timeout;
  precision: number;
}

export class DxFeedProvider extends BaseProvider {
  readonly name = "dxfeed";
  private ws: WebSocket | null = null;
  private running = false;
  private authorized = false;
  private retries = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private keepaliveTimer: NodeJS.Timeout | null = null;

  private readonly state = new Map<string, SymState>();
  private readonly toDx = new Map<string, string>(); // internal → dxFeed symbol
  // dxFeed symbol → internal symbols. Not 1:1: a micro shares its full-size sibling's
  // dxFeed symbol (e.g. ES & MES both → /ES:XCME), so one dx symbol can map to several.
  private readonly fromDx = new Map<string, string[]>();
  private readonly channelOpen = new Map<number, boolean>();
  private readonly bookEmitAt = new Map<string, number>();
  private readonly quoteEmitAt = new Map<string, number>();
  private readonly lastEmittedPrice = new Map<string, number>();
  // In-flight candle-history requests, keyed by the dxFeed candle symbol ("/ES:XCME{=1m}").
  private readonly hist = new Map<string, HistPending>();
  /**
   * null = unknown; true = at least one product returned Candle history.
   * false = HISTORY channel never delivered Candle events (skip waiting).
   * Never flip to false from a single empty product — only after repeated global misses.
   */
  private candleEntitled: boolean | null = null;
  private candleEmptyStreak = 0;
  /** feedRoot → retry Candle snapshots after this epoch ms (empty-result backoff). */
  private candleMissUntil = new Map<string, number>();
  /** Exchange codes returned by the auth mint (e.g. CMEfod, COMEXfod). Empty = unknown. */
  private entitledExchanges: string[] = [];
  private warnedMissingExchange = new Set<string>();
  /* Live-built 1-minute bars per symbol, oldest first.
   *
   * Candle history is a SEPARATE dxFeed entitlement from streaming quotes, and an
   * endpoint can have one without the other — the public demo host serves live
   * futures quotes but returns no Candle events at all, which leaves getHistory()
   * with nothing to return and the chart blank. Aggregating the trade prints we are
   * already receiving gives a real chart that starts shallow and deepens as it runs.
   * Same approach DatabentoLiveProvider uses to bridge its publication lag. */
  private readonly liveBars = new Map<string, Candle[]>();
  private liveBarsDirty = false;
  private liveBarsSaveTimer: NodeJS.Timeout | null = null;
  private liveBarsSaveSoon: NodeJS.Timeout | null = null;

  /** Static fallback (public demo, or a pre-minted DXFEED_ENDPOINT/TOKEN pair). */
  private readonly staticEndpoint: string;
  private readonly staticToken: string;
  /** What connect() actually uses — overwritten by mintCredentials() each attempt
   *  when auth.login/password are set; otherwise stays equal to the static pair. */
  private activeEndpoint: string;
  private activeToken: string;

  constructor(
    endpoint: string,
    token: string,
    private readonly auth: {
      url: string; pltfKey: string; login: string; password: string;
      apiVersion: number; environment: number;
    },
  ) {
    super();
    this.staticEndpoint = this.activeEndpoint = endpoint;
    this.staticToken = this.activeToken = token;
    /* The demo host DOES serve real CME futures (verified 2026-08-24: /ES:XCME,
     * /CL:XNYM, /6E:XCME all quote live; the rest are silent). So the ETF stand-in
     * swap is no longer automatic — `DXFEED_DEMO=0` opts out explicitly.
     * This matters: the stand-ins are only safe if EVERY instrument uses them. A
     * partial swap would quote YM at DIA's ~450 instead of ~44,000, and a wrong
     * price is far worse than no price — it marks positions and trips risk rules. */
    const isDemo = process.env.DXFEED_DEMO === "1"
      || (process.env.DXFEED_DEMO !== "0" && /demo\.dxfeed\.com/i.test(endpoint));
    let override: Record<string, string> = {};
    if (process.env.DXFEED_SYMBOL_MAP) {
      try {
        override = JSON.parse(process.env.DXFEED_SYMBOL_MAP) as Record<string, string>;
      } catch {
        console.warn("[dxfeed] DXFEED_SYMBOL_MAP is not valid JSON — ignoring");
      }
    }
    const base = isDemo ? DEMO_SYMBOL_MAP : buildDatedSymbolMap();
    for (const inst of INSTRUMENTS) {
      // Micros share the parent's feed symbol (ES/MES pattern) unless overridden.
      const parent = PARENT_OF[inst.symbol];
      const feedRoot = parent ?? inst.symbol;
      const dx = override[inst.symbol] ?? override[feedRoot] ?? base[feedRoot] ?? base[inst.symbol];
      if (!dx) continue;
      this.toDx.set(inst.symbol, dx);
      this.linkDxAlias(dx, inst.symbol);
      // Parent events should also update the micro (and vice versa when same dx).
      if (parent) this.linkDxAlias(dx, parent);
      const micro = MICRO_OF[inst.symbol];
      if (micro) this.linkDxAlias(dx, micro);
      // Also accept continuous-form events (/NQ:XCME) even when subscribed dated.
      const continuous = CONTINUOUS_SYMBOL_MAP[feedRoot] ?? CONTINUOUS_SYMBOL_MAP[inst.symbol];
      if (continuous && continuous !== dx) {
        this.linkDxAlias(continuous, inst.symbol);
        if (parent) this.linkDxAlias(continuous, parent);
        if (micro) this.linkDxAlias(continuous, micro);
      }
      this.state.set(inst.symbol, {
        price: inst.simBase, bid: 0, ask: 0, dayOpen: 0, prevClose: 0,
        high: 0, low: 0, volume: 0, havePrice: false, haveTrade: false,
      });
    }
    if (isDemo) console.log("[dxfeed] DEMO symbol map active (equity/FX stand-ins for futures)");
    else {
      const sample = [...this.toDx.entries()].map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`[dxfeed] symbol map (micros piggyback parents): ${sample}`);
    }
    this.loadLiveBars();
  }

  /** Register eventSymbol → internal root (supports many internals per dx symbol). */
  private linkDxAlias(dx: string, internal: string): void {
    const shared = this.fromDx.get(dx);
    if (shared) {
      if (!shared.includes(internal)) shared.push(internal);
    } else {
      this.fromDx.set(dx, [internal]);
    }
  }

  /**
   * Resolve FEED_DATA eventSymbol → internal roots.
   * Exact match first, then strip candle period, then dated → root fuzzy match
   * so /NQU26:XCME still updates NQ (and MNQ via piggyback) when subscribed dated.
   */
  private resolveEventSymbols(eventSymbol: string): string[] | undefined {
    const expand = (roots: string[]): string[] => {
      const out: string[] = [];
      for (const r of roots) {
        if (this.state.has(r) && !out.includes(r)) out.push(r);
        const micro = MICRO_OF[r];
        if (micro && this.state.has(micro) && !out.includes(micro)) out.push(micro);
        const parent = PARENT_OF[r];
        if (parent && this.state.has(parent) && !out.includes(parent)) out.push(parent);
      }
      return out;
    };

    const exact = this.fromDx.get(eventSymbol);
    if (exact) return expand(exact);

    const base = eventSymbol.replace(/\{=[^}]*\}$/, "");
    const exactBase = this.fromDx.get(base);
    if (exactBase) return expand(exactBase);

    // /NQU26:XCME or NQU26 → root NQ (+ MNQ)
    const bare = base.startsWith("/") ? base.slice(1) : base;
    const product = bare.split(":")[0] ?? bare;
    const root = product.replace(MONTH_CODE_RE, "");
    if (root && this.state.has(root)) return expand([root]);

    return undefined;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void this.connect();
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.reconnectTimer = this.keepaliveTimer = null;
    if (this.liveBarsSaveTimer) clearInterval(this.liveBarsSaveTimer);
    this.liveBarsSaveTimer = null;
    this.saveLiveBars();
    for (const p of this.hist.values()) {
      if (p.idle) clearTimeout(p.idle);
      clearTimeout(p.cap);
      p.resolve([]);
    }
    this.hist.clear();
    this.ws?.close();
    this.ws = null;
  }

  /** Restore 1m bars written on prior runs so charts aren't empty after restart. */
  private loadLiveBars(): void {
    try {
      if (!existsSync(LIVE_BARS_FILE)) return;
      const raw = JSON.parse(readFileSync(LIVE_BARS_FILE, "utf8")) as Record<string, Candle[]>;
      const cutoff = Math.floor(Date.now() / 1000) - LIVE_BAR_CAP * 60;
      let n = 0;
      for (const [sym, bars] of Object.entries(raw)) {
        if (!this.state.has(sym) || !Array.isArray(bars)) continue;
        const kept = bars.filter((b) => b && b.time >= cutoff && b.close > 0).slice(-LIVE_BAR_CAP);
        if (kept.length) {
          this.liveBars.set(sym, kept);
          n += kept.length;
        }
      }
      // Micros share the parent's price stream — keep both buffers filled so MES
      // never looks empty while ES has depth (and the same for MNQ/MYM/MGC/MCL).
      this.syncPiggybackLiveBars();
      if (n) console.log(`[dxfeed] restored ${n} live bars from disk`);
    } catch (err) {
      console.warn("[dxfeed] could not load live bars:", (err as Error).message);
    }
    this.liveBarsSaveTimer = setInterval(() => this.saveLiveBars(), LIVE_BARS_SAVE_MS);
  }

  /** Copy the richer live-bar series across each parent↔micro pair. */
  private syncPiggybackLiveBars(): void {
    for (const [micro, parent] of Object.entries(PARENT_OF)) {
      const a = this.liveBars.get(parent) ?? [];
      const b = this.liveBars.get(micro) ?? [];
      if (a.length >= b.length && a.length) {
        this.liveBars.set(micro, a.map((c) => ({ ...c })));
      } else if (b.length > a.length) {
        this.liveBars.set(parent, b.map((c) => ({ ...c })));
      }
    }
  }

  private saveLiveBars(): void {
    if (!this.liveBarsDirty) return;
    try {
      const dir = path.dirname(LIVE_BARS_FILE);
      mkdirSync(dir, { recursive: true });
      const out: Record<string, Candle[]> = {};
      let n = 0;
      for (const [sym, bars] of this.liveBars) {
        if (bars.length) {
          out[sym] = bars;
          n += bars.length;
        }
      }
      writeFileSync(LIVE_BARS_FILE, JSON.stringify(out));
      this.liveBarsDirty = false;
      if (n > 0) console.log(`[dxfeed] saved ${n} live bars → ${LIVE_BARS_FILE}`);
    } catch (err) {
      console.warn("[dxfeed] could not save live bars:", (err as Error).message);
    }
  }

  // --- connection --------------------------------------------------

  /** Volumetrica's Admin Trading API AUTH REQUEST, asked for market data
   *  (connectOnlyTrading: false). Only the v2 path + apiVersion 6 actually
   *  return dataEndpoint/dataToken — v1 (or version 5) returns HTTP 200 with
   *  only the trading fields, no error, which looks like success and isn't
   *  (confirmed against staging 2026-08-27). On failure, falls back to
   *  whatever endpoint/token were last active (the static pair, first time). */
  private async mintCredentials(): Promise<void> {
    if (!this.auth.login || !this.auth.password) return; // static demo/pre-minted pair
    try {
      const res = await fetch(this.auth.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", PltfKey: this.auth.pltfKey },
        body: JSON.stringify({
          login: this.auth.login,
          password: this.auth.password,
          withDetails: true,
          version: this.auth.apiVersion,
          environment: this.auth.environment,
          connectOnlyTrading: false,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const data = (body.data ?? body) as Record<string, unknown>;
      const endpoint = data.dataEndpoint as string | undefined;
      const token = data.dataToken as string | undefined;
      if (!res.ok || body.success === false || !endpoint || !token) {
        console.warn(
          `[dxfeed] auth request did not return market-data credentials (HTTP ${res.status}) — ` +
            `using the last known endpoint/token. message: ${String(body.message ?? "")}`,
        );
        return;
      }
      this.activeEndpoint = endpoint;
      this.activeToken = token;
      this.entitledExchanges = Array.isArray(data.dataExchanges)
        ? (data.dataExchanges as unknown[]).map((x) => String(x))
        : [];
      const exchanges = this.entitledExchanges.length ? this.entitledExchanges.join(", ") : "?";
      console.log(`[dxfeed] minted market-data credentials — exchanges: ${exchanges}`);
      this.warnMissingExchangeEntitlements();
    } catch (err) {
      console.warn("[dxfeed] auth request failed:", (err as Error).message, "— using the last known endpoint/token");
    }
  }

  /**
   * Map product roots → exchange family keywords we expect in dataExchanges
   * (Volumetrica uses names like CMEfod / CBOTfod / COMEXfod / NYMEXfod).
   */
  private exchangeFamilyForRoot(root: string): string | null {
    const ex = EXCHANGE_BY_ROOT[root];
    if (!ex) return null;
    if (ex === "XCME") return "CME";
    if (ex === "XCBT") return "CBOT";
    if (ex === "XCEC") return "COMEX";
    if (ex === "XNYM") return "NYMEX";
    return null;
  }

  private isRootEntitled(root: string): boolean {
    if (!this.entitledExchanges.length) return true; // unknown → don't block
    const family = this.exchangeFamilyForRoot(root);
    if (!family) return true;
    const hay = this.entitledExchanges.join(" ").toUpperCase();
    return hay.includes(family);
  }

  private warnMissingExchangeEntitlements(): void {
    const needed = [
      ["ES/MES/NQ/MNQ", "ES"],
      ["YM/MYM", "YM"],
      ["GC/MGC", "GC"],
      ["CL/MCL", "CL"],
    ] as const;
    for (const [label, root] of needed) {
      if (this.isRootEntitled(root)) continue;
      if (this.warnedMissingExchange.has(root)) continue;
      this.warnedMissingExchange.add(root);
      const family = this.exchangeFamilyForRoot(root);
      console.warn(
        `[dxfeed] feed has no ${family} entitlement — ${label} will stay empty until that exchange is enabled on the dxFeed account`,
      );
    }
  }

  private async connect(): Promise<void> {
    await this.mintCredentials();
    this.authorized = false;
    this.channelOpen.clear();
    const ws = new WebSocket(this.activeEndpoint);
    this.ws = ws;
    ws.on("open", () => {
      console.log("[dxfeed] socket open →", this.activeEndpoint);
      this.send({ type: "SETUP", channel: 0, version: PROTOCOL_VERSION, keepaliveTimeout: 60, acceptKeepaliveTimeout: 60 });
    });
    ws.on("message", (raw: WebSocket.RawData) => this.onMessage(raw));
    ws.on("error", (err) => console.warn("[dxfeed] socket error:", (err as Error).message));
    ws.on("close", (code) => {
      if (this.ws === ws) this.ws = null;
      if (this.keepaliveTimer) { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }
      if (this.running) this.scheduleReconnect(code);
    });
  }

  private scheduleReconnect(code?: number): void {
    const delay = Math.min(BASE_BACKOFF_MS * 2 ** this.retries, MAX_BACKOFF_MS);
    this.retries += 1;
    console.warn(`[dxfeed] disconnected (code ${code ?? "?"}) — reconnecting in ${delay}ms`);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => void this.connect(), delay);
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  // --- protocol ----------------------------------------------------

  private onMessage(raw: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    switch (msg.type) {
      case "SETUP":
        // Server acked SETUP; AUTH_STATE follows.
        break;
      case "AUTH_STATE":
        this.onAuthState(String(msg.state));
        break;
      case "CHANNEL_OPENED":
        this.onChannelOpened(Number(msg.channel));
        break;
      case "FEED_CONFIG":
        break; // server confirmed FEED_SETUP; subscriptions may proceed
      case "FEED_DATA":
        this.onFeedData(Number(msg.channel), msg.data as unknown[]);
        break;
      case "KEEPALIVE":
        break; // server heartbeat
      case "ERROR":
        console.warn(`[dxfeed] gateway error on channel ${msg.channel}: ${msg.error} — ${msg.message}`);
        break;
      default:
        break;
    }
  }

  private onAuthState(state: string): void {
    if (state === "UNAUTHORIZED") {
      // Real endpoints require a token; the public demo is open (goes straight to
      // AUTHORIZED). Only send AUTH when we actually have a token.
      if (this.activeToken) this.send({ type: "AUTH", channel: 0, token: this.activeToken });
      else console.warn("[dxfeed] server requires auth but no token is available — set DXFEED_TOKEN or DXFEED_AUTH_LOGIN/PASSWORD");
      return;
    }
    if (state === "AUTHORIZED") {
      if (this.authorized) return;
      this.authorized = true;
      this.retries = 0;
      console.log("[dxfeed] authorized — opening feed channels");
      if (!this.keepaliveTimer) {
        this.keepaliveTimer = setInterval(() => this.send({ type: "KEEPALIVE", channel: 0 }), KEEPALIVE_MS);
      }
      // Open the live feed channel and the on-demand history channel.
      this.send({ type: "CHANNEL_REQUEST", channel: CHANNEL_FEED, service: "FEED", parameters: { contract: "AUTO" } });
      this.send({ type: "CHANNEL_REQUEST", channel: CHANNEL_HIST, service: "FEED", parameters: { contract: "HISTORY" } });
    }
  }

  private onChannelOpened(channel: number): void {
    this.channelOpen.set(channel, true);
    if (channel === CHANNEL_FEED) {
      this.send({
        type: "FEED_SETUP",
        channel: CHANNEL_FEED,
        acceptAggregationPeriod: 0.1,
        acceptDataFormat: "FULL",
        acceptEventFields: {
          Quote: ["eventType", "eventSymbol", "bidPrice", "askPrice"],
          Trade: ["eventType", "eventSymbol", "price", "size", "dayVolume"],
          Summary: ["eventType", "eventSymbol", "dayOpenPrice", "dayHighPrice", "dayLowPrice", "prevDayClosePrice"],
        },
      });
      // Subscribe unique feed symbols — dated primary + continuous alias.
      // Micros share the parent's dx symbol, so the Set naturally de-dupes.
      const symbols = new Set<string>();
      for (const [root, dx] of this.toDx) {
        symbols.add(dx);
        const parent = PARENT_OF[root];
        const feedRoot = parent ?? root;
        const continuous = CONTINUOUS_SYMBOL_MAP[feedRoot] ?? CONTINUOUS_SYMBOL_MAP[root];
        if (continuous) symbols.add(continuous);
        // Energy: also subscribe the prior calendar month in case the front month
        // is quiet around roll (CL/MCL are often empty without NYMEX entitlement).
        if (feedRoot === "CL" || feedRoot === "MCL") {
          const prev = previousDatedSymbol("CL", "Energy", "XNYM");
          if (prev) {
            symbols.add(prev);
            this.linkDxAlias(prev, "CL");
            this.linkDxAlias(prev, "MCL");
          }
        }
      }
      const add = [...symbols].flatMap((sym) => [
        { type: "Quote", symbol: sym },
        { type: "Trade", symbol: sym },
        { type: "Summary", symbol: sym },
      ]);
      this.send({ type: "FEED_SUBSCRIPTION", channel: CHANNEL_FEED, add });
      console.log(`[dxfeed] subscribed ${symbols.size} feed symbols (Quote/Trade/Summary)`);
    } else if (channel === CHANNEL_HIST) {
      this.send({
        type: "FEED_SETUP",
        channel: CHANNEL_HIST,
        acceptAggregationPeriod: 0,
        acceptDataFormat: "FULL",
        acceptEventFields: {
          Candle: ["eventType", "eventSymbol", "time", "open", "high", "low", "close", "volume"],
        },
      });
    }
  }

  // --- live data ---------------------------------------------------

  private onFeedData(channel: number, data: unknown[]): void {
    if (!Array.isArray(data)) return;
    for (const ev of data) {
      if (!ev || typeof ev !== "object") continue;
      const e = ev as Record<string, unknown>;
      if (channel === CHANNEL_HIST && e.eventType === "Candle") {
        this.onCandle(e);
        continue;
      }
      const symbols = this.resolveEventSymbols(String(e.eventSymbol));
      if (!symbols) continue;
      for (const symbol of symbols) {
        const st = this.state.get(symbol);
        if (!st) continue;
        switch (e.eventType) {
          case "Trade":
            this.onTrade(symbol, st, e);
            break;
          case "Quote":
            this.onQuote(symbol, st, e);
            break;
          case "Summary":
            this.onSummary(symbol, st, e);
            break;
        }
      }
    }
  }

  private onTrade(symbol: string, st: SymState, e: Record<string, unknown>): void {
    const price = num(e.price);
    if (!Number.isFinite(price) || price <= 0) return;
    const first = !st.havePrice;
    st.price = price;
    st.havePrice = true;
    st.haveTrade = true;
    st.volume = num(e.dayVolume) || st.volume;
    if (st.high) st.high = Math.max(st.high, price);
    if (st.low) st.low = Math.min(st.low, price);
    if (first) console.log(`[dxfeed] first trade ${symbol} @ ${price}`);
    this.recordLiveBar(symbol, price, num(e.size));
    this.emitQuote(symbol, st, num(e.size));
  }

  /** Fold one trade/quote print into the current minute's bar for `symbol`. */
  private recordLiveBar(symbol: string, price: number, size: number): void {
    const minute = Math.floor(Date.now() / 60_000) * 60; // bar time, seconds
    let bars = this.liveBars.get(symbol);
    if (!bars) { bars = []; this.liveBars.set(symbol, bars); }
    const open = bars[bars.length - 1];
    if (open && open.time === minute) {
      open.high = Math.max(open.high, price);
      open.low = Math.min(open.low, price);
      open.close = price;
      open.volume = (open.volume ?? 0) + (Number.isFinite(size) ? size : 0);
      this.liveBarsDirty = true;
      this.scheduleLiveBarsSave();
      return;
    }
    // Out-of-order print for a minute we already closed: drop it rather than
    // append, which would put the series out of order and break the chart.
    if (open && open.time > minute) return;
    bars.push({ time: minute, open: price, high: price, low: price, close: price, volume: Number.isFinite(size) ? size : 0 });
    if (bars.length > LIVE_BAR_CAP) bars.splice(0, bars.length - LIVE_BAR_CAP);
    this.liveBarsDirty = true;
    this.scheduleLiveBarsSave();
  }

  private scheduleLiveBarsSave(): void {
    if (this.liveBarsSaveSoon) return;
    this.liveBarsSaveSoon = setTimeout(() => {
      this.liveBarsSaveSoon = null;
      this.saveLiveBars();
    }, 2_000);
  }

  private onQuote(symbol: string, st: SymState, e: Record<string, unknown>): void {
    const bid = num(e.bidPrice);
    const ask = num(e.askPrice);
    if (bid > 0) st.bid = bid;
    if (ask > 0) st.ask = ask;
    if (st.bid > 0 && st.ask > 0) {
      const mid = (st.bid + st.ask) / 2;
      // ALWAYS advance the mark from BBO. Thin products (NQ/YM/GC on this feed)
      // often quote continuously but trade rarely — updating price only on Trade
      // froze headers/charts while ES (busy prints) still looked live.
      const first = !st.havePrice;
      st.price = mid;
      st.havePrice = true;
      if (first) console.log(`[dxfeed] first quote ${symbol} mid @ ${mid}`);
      if (st.high) st.high = Math.max(st.high, mid);
      if (st.low) st.low = Math.min(st.low, mid);
      this.recordLiveBar(symbol, mid, 0);
    }
    this.emitQuote(symbol, st, 0);
  }

  private onSummary(symbol: string, st: SymState, e: Record<string, unknown>): void {
    st.dayOpen = num(e.dayOpenPrice) || st.dayOpen;
    st.high = num(e.dayHighPrice) || st.high;
    st.low = num(e.dayLowPrice) || st.low;
    st.prevClose = num(e.prevDayClosePrice) || st.prevClose;
    // Never leave price stuck on simBase while Summary has live session levels —
    // that produces fake 24h % moves (seed price vs real prevClose) and a blank chart.
    if (!st.havePrice) {
      const px = st.high || st.dayOpen || st.prevClose;
      if (px > 0) {
        st.price = px;
        st.havePrice = true;
        this.recordLiveBar(symbol, px, 0);
        console.log(`[dxfeed] first summary ${symbol} @ ${px}`);
      }
    }
    this.emitQuote(symbol, st, 0);
  }

  private emitQuote(symbol: string, st: SymState, lastSize: number): void {
    const inst = getInstrument(symbol)!;
    const p = inst.pricePrecision;
    const tick = inst.tickSize;
    const spread = tick;
    const bid = st.bid > 0 ? st.bid : st.price - spread;
    const ask = st.ask > 0 ? st.ask : st.price + spread;
    // Snap to the instrument tick so charts/headers move on real ticks (YM=1, ES=0.25).
    const price = Math.round(st.price / tick) * tick;
    const prev = this.lastEmittedPrice.get(symbol);
    const now = Date.now();
    const elapsed = now - (this.quoteEmitAt.get(symbol) ?? 0);
    const moved = prev == null || Math.abs(price - prev) >= tick * 0.5;
    // Throttle quiet repeats, but never drop a tick-sized move — that is what made
    // NQ/YM/GC charts look frozen next to busy ES trade prints.
    if (!moved && elapsed < QUOTE_EMIT_MIN_MS) return;
    this.quoteEmitAt.set(symbol, now);
    this.lastEmittedPrice.set(symbol, price);
    // Prefer prev-day close for the 24h change baseline; fall back to the day open.
    const base = st.prevClose > 0 ? st.prevClose : st.dayOpen;
    // dayVolume only arrives on Trade events; when those are sparse, sum live 1m bars
    // (parent↔micro twin included) so MNQ/YM headers don't stay at volume=0 while ES looks live.
    const bars = this.richestLiveBars(symbol);
    let volume24h = Math.round(st.volume);
    if (volume24h <= 0 && bars?.length) {
      volume24h = Math.round(bars.reduce((s, b) => s + (b.volume ?? 0), 0));
    }
    let high24 = st.high > 0 ? Math.max(st.high, price) : price;
    let low24 = st.low > 0 ? Math.min(st.low, price) : price;
    if (bars?.length) {
      for (const b of bars) {
        if (b.high > high24) high24 = b.high;
        if (b.low > 0 && b.low < low24) low24 = b.low;
      }
    }
    this.emit("quote", {
      symbol,
      price: round(price, p),
      bid: round(bid, p),
      ask: round(ask, p),
      change24h: base > 0 ? (price - base) / base : 0,
      high24h: round(high24, p),
      low24h: round(low24, p),
      volume24h,
      lastSize,
      ts: now,
    });
    this.maybeEmitBook(symbol, st, tick, p);
  }

  /** dxFeed's Order/depth feed isn't wired yet — emit a synthetic ladder (like the
   *  Databento fallback) so the DOM is populated for watched symbols. */
  private maybeEmitBook(symbol: string, st: SymState, tickSize: number, precision: number): void {
    if (!this.bookSymbols.has(symbol) || !st.havePrice) return;
    const now = Date.now();
    if (now - (this.bookEmitAt.get(symbol) ?? 0) < BOOK_THROTTLE_MS) return;
    this.bookEmitAt.set(symbol, now);
    this.emit("orderbook", synthBook(symbol, st.price, tickSize, precision));
  }

  // --- history (Candle snapshots) ----------------------------------

  async getHistory(symbol: string, resolutionSec: number, count: number): Promise<Candle[]> {
    const inst = getInstrument(symbol);
    const dx = this.toDx.get(symbol);
    if (!inst || !dx) return [];
    const want = Math.min(Math.max(1, count), HISTORY_MAX_BARS);
    let snapshot: Candle[] = [];
    const feedRoot = PARENT_OF[symbol] ?? symbol;
    const missUntil = this.candleMissUntil.get(feedRoot) ?? 0;

    // No exchange entitlement (e.g. CL without NYMEX) — skip Candle wait, live bars only.
    if (!this.isRootEntitled(feedRoot)) {
      if (!this.warnedMissingExchange.has(feedRoot)) {
        this.warnedMissingExchange.add(feedRoot);
        const family = this.exchangeFamilyForRoot(feedRoot);
        console.warn(
          `[dxfeed] skipping candle history for ${symbol}: no ${family} entitlement on this feed`,
        );
      }
      return this.mergeLiveBars(symbol, [], resolutionSec, want);
    }

    // Wait briefly for the HISTORY channel — chart loads often race the socket setup.
    if (!this.channelOpen.get(CHANNEL_HIST)) {
      await waitFor(() => this.channelOpen.get(CHANNEL_HIST) === true, 2_500);
    }

    // Per-root backoff after an empty snapshot — never disable Candle from one product.
    // Once the gateway has proven it never sends Candle events, skip the wait entirely
    // so charts load from live bars in milliseconds (this feed is quote-only).
    if (this.channelOpen.get(CHANNEL_HIST) && this.candleEntitled !== false && Date.now() >= missUntil) {
      const continuous = CONTINUOUS_SYMBOL_MAP[feedRoot] ?? CONTINUOUS_SYMBOL_MAP[symbol];
      const candidates = continuous && continuous !== dx ? [continuous, dx] : [dx];
      // Energy: also try the prior month contract around rolls.
      if (feedRoot === "CL") {
        const prev = previousDatedSymbol("CL", "Energy", "XNYM");
        if (prev && !candidates.includes(prev)) candidates.push(prev);
      }
      const results = await Promise.all(
        candidates.map((sym) => this.candleSnapshot(sym, inst.pricePrecision, resolutionSec, want)),
      );
      for (const bars of results) {
        if (bars.length > snapshot.length) snapshot = bars;
      }
      if (snapshot.length === 0) {
        this.candleMissUntil.set(feedRoot, Date.now() + CANDLE_MISS_BACKOFF_MS);
        this.candleEmptyStreak += 1;
        // After several empty snapshots with zero Candle events ever, stop waiting.
        if (this.candleEntitled !== true && this.candleEmptyStreak >= 3) {
          this.candleEntitled = false;
          console.warn("[dxfeed] no Candle entitlement on this gateway — live bars only for all symbols");
        } else {
          console.warn(
            `[dxfeed] candle snapshot empty for ${symbol} — live bars only (retry ${feedRoot} in ${CANDLE_MISS_BACKOFF_MS / 1000}s)`,
          );
        }
      } else {
        this.candleEntitled = true;
        this.candleEmptyStreak = 0;
        this.candleMissUntil.delete(feedRoot);
        console.log(`[dxfeed] candle snapshot ${symbol}: ${snapshot.length} bars`);
      }
    }
    return this.mergeLiveBars(symbol, snapshot, resolutionSec, want);
  }

  /**
   * Flat session pads stretch the time axis so a handful of real live bars become
   * invisible hairlines (or a blank pane). Prefer an honest short live series —
   * the chart fitContent will zoom to real candles like ES.
   */
  private sessionPadBars(_symbol: string, _resolutionSec: number, _count: number): Candle[] {
    return [];
  }

  /** Ask dxFeed for a Candle snapshot. Empty when the endpoint has no candle
   *  entitlement (the public demo host), which is why mergeLiveBars exists. */
  private candleSnapshot(dx: string, precision: number, resolutionSec: number, count: number): Promise<Candle[]> {
    const candleSymbol = `${dx}{=${candlePeriod(resolutionSec)}}`;
    const existing = this.hist.get(candleSymbol);
    if (existing) return new Promise((res) => { const prev = existing.resolve; existing.resolve = (b) => { prev(b); res(b); }; });

    const fromTime = Date.now() - count * resolutionSec * 1000;
    return new Promise<Candle[]>((resolve) => {
      const pending: HistPending = {
        bars: new Map(),
        resolve,
        precision,
        // Idle timer is armed on the first bar in onCandle — not here.
        idle: null as unknown as NodeJS.Timeout,
        cap: setTimeout(() => this.finishHistory(candleSymbol), HISTORY_MAX_MS),
      };
      this.hist.set(candleSymbol, pending);
      this.send({
        type: "FEED_SUBSCRIPTION",
        channel: CHANNEL_HIST,
        add: [{ type: "Candle", symbol: candleSymbol, fromTime }],
      });
    });
  }

  /** Extend a Candle snapshot with bars we built from live prints.
   *
   *  Serves two cases with one path: an endpoint WITH candle history gets its
   *  publication-lag seam closed, and one WITHOUT (the demo host) gets a chart at
   *  all. Only bars strictly newer than the snapshot are appended, so a real
   *  snapshot always wins where the two overlap.
   *
   *  Micros (MES/MNQ/…) reuse the parent's live-bar buffer when richer, so a
   *  micro chart never lags its mini just because only the parent accumulated bars.
   */
  private mergeLiveBars(symbol: string, snapshot: Candle[], resolutionSec: number, count: number): Candle[] {
    const live = this.richestLiveBars(symbol);
    const pad = (!snapshot.length && resolutionSec >= 60) ? this.sessionPadBars(symbol, resolutionSec, count) : [];
    // The buffer is minute-grained, so it cannot build sub-minute resolutions.
    if (resolutionSec < 60) return snapshot.slice(-count);
    const lastSnapshot = snapshot.length ? snapshot[snapshot.length - 1]!.time : 0;
    const liveAgg = live?.length ? aggregateCandles(live, resolutionSec).filter((c) => c.time > lastSnapshot) : [];
    const padTail = pad.filter((c) => c.time > lastSnapshot && (!liveAgg.length || c.time < liveAgg[0]!.time));
    const merged = [...snapshot, ...padTail, ...liveAgg];
    return merged.slice(-count);
  }

  /** Prefer the denser of this symbol's bars and its parent/micro twin. */
  private richestLiveBars(symbol: string): Candle[] | undefined {
    const own = this.liveBars.get(symbol);
    const twinName = MICRO_OF[symbol] ?? PARENT_OF[symbol];
    const twin = twinName ? this.liveBars.get(twinName) : undefined;
    if ((twin?.length ?? 0) > (own?.length ?? 0)) return twin;
    return own;
  }

  private onCandle(e: Record<string, unknown>): void {
    const candleSymbol = String(e.eventSymbol);
    const pending = this.findHistPending(candleSymbol);
    if (!pending) return;
    const timeSec = Math.floor(num(e.time) / 1000);
    const close = num(e.close);
    // dxFeed emits a synthetic snapshot-boundary event with NaN/empty OHLC (→ 0 here)
    // to mark the end of the history snapshot — skip it so only real bars are returned.
    if (!timeSec || close <= 0) return;
    const p = pending.entry.precision;
    const first = pending.entry.bars.size === 0;
    pending.entry.bars.set(timeSec, {
      time: timeSec,
      open: round(num(e.open), p),
      high: round(num(e.high), p),
      low: round(num(e.low), p),
      close: round(close, p),
      volume: Math.max(0, Math.round(num(e.volume))),
    });
    // Arm / reset idle only after bars are flowing.
    if (pending.entry.idle) clearTimeout(pending.entry.idle);
    pending.entry.idle = setTimeout(() => this.finishHistory(pending.key), HISTORY_IDLE_MS);
    if (first) {
      console.log(`[dxfeed] first candle ${pending.key} @ ${close}`);
    }
  }

  /** Match candle events even when dxFeed rewrites continuous → dated in eventSymbol. */
  private findHistPending(candleSymbol: string): { key: string; entry: HistPending } | null {
    const direct = this.hist.get(candleSymbol);
    if (direct) return { key: candleSymbol, entry: direct };

    const base = candleSymbol.replace(/\{=[^}]*\}$/, "");
    const period = candleSymbol.match(/\{=([^}]*)\}$/)?.[1];
    for (const [key, entry] of this.hist) {
      const keyBase = key.replace(/\{=[^}]*\}$/, "");
      const keyPeriod = key.match(/\{=([^}]*)\}$/)?.[1];
      if (period && keyPeriod && period !== keyPeriod) continue;
      if (keyBase === base) return { key, entry };
      // Same product root (dated vs continuous).
      const a = (base.startsWith("/") ? base.slice(1) : base).split(":")[0] ?? "";
      const b = (keyBase.startsWith("/") ? keyBase.slice(1) : keyBase).split(":")[0] ?? "";
      const rootA = a.replace(MONTH_CODE_RE, "");
      const rootB = b.replace(MONTH_CODE_RE, "");
      if (rootA && rootA === rootB) return { key, entry };
    }
    return null;
  }

  private finishHistory(candleSymbol: string): void {
    const pending = this.hist.get(candleSymbol);
    if (!pending) return;
    if (pending.idle) clearTimeout(pending.idle);
    clearTimeout(pending.cap);
    this.hist.delete(candleSymbol);
    // Stop the snapshot subscription so it doesn't keep streaming live candles.
    this.send({ type: "FEED_SUBSCRIPTION", channel: CHANNEL_HIST, remove: [{ type: "Candle", symbol: candleSymbol }] });
    const bars = [...pending.bars.values()].sort((a, b) => a.time - b.time);
    pending.resolve(bars);
  }
}

/** Prefer dated front-month CME symbols — continuous often quotes without trades/candles. */
function buildDatedSymbolMap(): Record<string, string> {
  const now = Date.now();
  const map: Record<string, string> = {};
  for (const inst of INSTRUMENTS) {
    const exchange = EXCHANGE_BY_ROOT[inst.symbol];
    if (!exchange) continue;
    map[inst.symbol] = computeDxFeedDatedSymbol(inst.symbol, inst.category as Category, exchange, now);
  }
  return map;
}

/** Prior energy contract (one calendar month back) for roll-window coverage. */
function previousDatedSymbol(root: string, category: Category, exchange: string): string | null {
  const now = Date.now();
  // Step back ~20 days so resolveFrontMonth lands on the previous listing month.
  const earlier = now - 20 * 86_400_000;
  const prev = computeDxFeedDatedSymbol(root, category, exchange, earlier);
  const cur = computeDxFeedDatedSymbol(root, category, exchange, now);
  return prev !== cur ? prev : null;
}

/** Coerce a dxFeed numeric field (may be number, numeric string, or "NaN") to a number. */
function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** resolutionSec → dxFeed candle period string (60→"1m", 3600→"1h", 86400→"1d"). */
function candlePeriod(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  return `${Math.max(1, Math.round(sec / 60))}m`;
}

/** Resolve when `pred` is true, or after `ms` timeout (whichever first). */
function waitFor(pred: () => boolean, ms: number): Promise<void> {
  if (pred()) return Promise.resolve();
  return new Promise((resolve) => {
    const start = Date.now();
    const id = setInterval(() => {
      if (pred() || Date.now() - start >= ms) {
        clearInterval(id);
        resolve();
      }
    }, 50);
  });
}
