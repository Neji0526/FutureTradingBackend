import "dotenv/config";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : fallback;
}


export const config = {
  port: num("PORT", 8000),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
  databaseUrl: process.env.DATABASE_URL?.trim() ?? "",

  /**
   * Market-data delivery model — lets us switch between the two licensing models
   * without code changes:
   *  - "shared" (Model A): one master Databento key, fanned out to all users.
   *    Simple, but counts as redistribution (needs a redistribution license).
   *  - "byo"    (Model B): each user brings their own Databento account; the app
   *    streams only data their own license covers (no redistribution).
   *  - "dxfeed" : real-time via dxFeed's dxLink WebSocket feed (additive; leaves
   *    the Databento paths untouched). Selected only when explicitly set.
   * Defaults to "shared" (current behaviour). See README "Market-data models".
   */
  marketDataMode: (
    process.env.MARKET_DATA_MODE === "byo"
      ? "byo"
      : process.env.MARKET_DATA_MODE === "dxfeed"
        ? "dxfeed"
        : "shared"
  ) as "shared" | "byo" | "dxfeed",

  /** dxFeed (dxLink) real-time feed — used only when MARKET_DATA_MODE=dxfeed.
   *  Defaults to the public demo endpoint (four instruments, no entitlement) so
   *  the wiring can be validated with no credentials at all. Set DXFEED_AUTH_LOGIN
   *  / DXFEED_AUTH_PASSWORD to switch to the real, entitled staging/production
   *  feed instead — the provider then mints its own endpoint+token from the auth
   *  service on every (re)connect rather than using DXFEED_ENDPOINT/DXFEED_TOKEN
   *  directly (see providers/dxfeed.ts). */
  dxfeed: {
    endpoint: process.env.DXFEED_ENDPOINT?.trim() || "wss://demo.dxfeed.com/market-data/dxlink-ws",
    token: process.env.DXFEED_TOKEN?.trim() ?? "",

    /** Propfirm REST — per-trader NewUser / NewSubscription + data agreement. */
    propfirmUrl: process.env.DXFEED_PROPFIRM_URL?.trim() || "https://dxfeed.volumetricaprop.com",
    /** x-api-key for Propfirm REST + webhooks. Unset = onboarding agreement skipped. */
    apiKey: process.env.DXFEED_API_KEY?.trim() ?? "",

    /** Volumetrica auth service — mints a real dataEndpoint + dataToken per the
     *  Admin Trading API's "AUTH REQUEST" (v2 path; v1 silently omits the market
     *  data fields even on success — confirmed against staging 2026-08-27). */
    auth: {
      url: process.env.DXFEED_AUTH_URL?.trim() || "https://authdxfeed.volumetricatrading.com/api/v2/auth/token",
      pltfKey: process.env.DXFEED_PLTF_KEY?.trim() ?? "",
      login: process.env.DXFEED_AUTH_LOGIN?.trim() ?? "",
      password: process.env.DXFEED_AUTH_PASSWORD?.trim() ?? "",
      // Sending version 5 gets a 200 with the trading fields only, no market-data
      // ones — 6 is what actually returns dataEndpoint/dataToken (confirmed live).
      apiVersion: num("DXFEED_AUTH_API_VERSION", 6),
      environment: num("DXFEED_AUTH_ENVIRONMENT", 1), // 0 = production, 1 = staging
    },

    /**
     * Map Volumetrica Trading Rule References → Vault RuleTemplate ids.
     * JSON object, e.g. {"PRIME_50K_EVAL":"c1_50k","PRIME_50K_FUND":"f_50k"}
     * Keys are matched case-insensitively after uppercase normalisation.
     */
    ruleMap: (() => {
      const raw = process.env.DXFEED_RULE_MAP?.trim();
      if (!raw) return {} as Record<string, string>;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          if (typeof v === "string" && v.trim()) {
            out[k.trim().toUpperCase()] = v.trim();
            out[k.trim()] = v.trim();
          }
        }
        return out;
      } catch {
        console.warn("[config] DXFEED_RULE_MAP is not valid JSON — ignoring");
        return {} as Record<string, string>;
      }
    })(),

    /** Defaults when provisioning a trader during onboarding (data agreement). */
    provisioning: {
      balance: num("DXFEED_DEFAULT_BALANCE", 50_000),
      ruleId: process.env.DXFEED_DEFAULT_RULE_ID?.trim() ?? "",
      dataFeedProducts: (process.env.DXFEED_DATA_PRODUCTS?.trim() || "0,1,2,3")
        .split(",")
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n)),
      platform: num("DXFEED_PLATFORM", 0),
      /**
       * When platform=0 (Volumetrica): 1=Deepchart®, 2=Deepdom®.
       * Required for volumetricaDownloadLink / license on V2 Subscription.
       */
      volumetricaPlatform: num("DXFEED_VOLUMETRICA_PLATFORM", 1),
      country: process.env.DXFEED_DEFAULT_COUNTRY?.trim() || "US",
      /**
       * Public Vault origin for post-sign redirect back to onboarding
       * (e.g. https://enterthevault.co). Falls back to CORS_ORIGIN when that
       * is a real http(s) origin (not "*").
       */
      onboardingPublicUrl: (
        process.env.ONBOARDING_PUBLIC_URL?.trim()
        || (process.env.CORS_ORIGIN?.trim().startsWith("http")
          ? process.env.CORS_ORIGIN.trim()
          : "")
      ).replace(/\/$/, ""),
      /**
       * Optional static download URLs for Make email when Volumetrica does not
       * return a link. Keys: "0" Deepchart, "1" Quantower, "2" ATAS, "default".
       */
      downloadUrls: {
        "0": process.env.DXFEED_DOWNLOAD_URL_DEEPCHART?.trim() || "",
        "1": process.env.DXFEED_DOWNLOAD_URL_QUANTOWER?.trim() || "",
        "2": process.env.DXFEED_DOWNLOAD_URL_ATAS?.trim() || "",
        default: process.env.DXFEED_DOWNLOAD_URL?.trim() || "",
      } as Record<string, string>,
      /**
       * Fallback when LoginUrl SSO is unavailable. Prefer empty — Make should use
       * the SSO loginUrl from Propsite LoginUrl when present.
       */
      loginUrls: {
        "0": process.env.DXFEED_LOGIN_URL_DEEPCHART?.trim() || "",
        "1": process.env.DXFEED_LOGIN_URL_QUANTOWER?.trim() || "",
        "2": process.env.DXFEED_LOGIN_URL_ATAS?.trim() || "",
        default: process.env.DXFEED_LOGIN_URL?.trim() || "",
      } as Record<string, string>,
      /** Shown in Deepchart desktop: "Use the following server for dxFeed connection". */
      connectionServer: process.env.DXFEED_CONNECTION_SERVER?.trim() || "Propfirm",
    },
  },

  /**
   * Make.com — platform credentials email after dxFeed agreement is signed.
   * Separate from FutureTradingApp MAKE_WEBHOOK_URL (purchase → onboarding link).
   */
  make: {
    platformCredentialsWebhookUrl:
      process.env.MAKE_PLATFORM_CREDENTIALS_WEBHOOK_URL?.trim() || "",
    /** Sent as header x-make-apikey when Make webhook auth is API key. */
    platformCredentialsApiKey:
      process.env.MAKE_PLATFORM_CREDENTIALS_API_KEY?.trim() || "",
  },

  jwt: {
    secret: process.env.JWT_SECRET?.trim() || "dev-insecure-secret-change-me",
    expiresInSec: num("JWT_EXPIRES_IN_SEC", 7 * 24 * 60 * 60), // 7 days
  },

  databento: {
    apiKey: process.env.DATABENTO_API_KEY?.trim() ?? "",
    dataset: process.env.DATABENTO_DATASET?.trim() || "GLBX.MDP3",
    quotePollMs: num("QUOTE_POLL_MS", 1500),
    /** Use the real-time Live TCP feed instead of Historical HTTP polling. */
    live: process.env.DATABENTO_LIVE === "1",
  },

  /** Secret used to encrypt each user's Databento key at rest (Model B / byo).
   *  Any long random string; required only when MARKET_DATA_MODE=byo. */
  marketDataEncKey: process.env.MARKET_DATA_ENC_KEY?.trim() ?? "",

  /** Bootstrap admin (optional). When both are set, the backend ensures an ADMIN
   *  user with this email exists on startup — creating it, or promoting an
   *  existing user of that email to ADMIN. Lets you provision an admin on a fresh
   *  deploy without the seed/CLI. */
  adminEmail: process.env.ADMIN_EMAIL?.trim() ?? "",
  adminPassword: process.env.ADMIN_PASSWORD ?? "",

  /** Auto-seed demo data on a fresh (empty) database at boot. Opt-in because the
   *  seed creates well-known demo credentials — DO NOT enable in production. */
  seedDemo: process.env.SEED_DEMO === "1",
} as const;

if (config.jwt.secret === "dev-insecure-secret-change-me") {
  console.warn("[auth] JWT_SECRET not set — using an insecure dev secret. Set JWT_SECRET in production.");
}

if (config.make.platformCredentialsWebhookUrl) {
  console.log("[make] platform credentials webhook configured");
} else {
  console.warn(
    "[make] MAKE_PLATFORM_CREDENTIALS_WEBHOOK_URL not set — signup will not email Deepchart credentials",
  );
}

/** Use the live Databento feed only when an API key is present. */
export const useDatabento = config.databento.apiKey.length > 0;

/** Use PostgreSQL (pg) for persistence when a connection string is present. */
export const useDatabase = config.databaseUrl.length > 0;

/** Propfirm provisioning + data-agreement gate — only when DXFEED_API_KEY is set. */
export const dxfeedProvisionReady = config.dxfeed.apiKey.length > 0;
