/**
 * Watch Volumetrica Trading Rules and write RuleTemplate only when content changes.
 *
 * Uses existing DXFEED_API_KEY + DATABASE_URL (no new env vars).
 * Does not delete templates; upserts by Reference name when a change is detected.
 * Webhook path still works; this covers orgs where Trading Rules webhooks never fire.
 */
import { createHash } from "node:crypto";
import { config, useDatabase } from "../config.js";
import { propfirm } from "./propfirm.js";
import {
  extractTradingRulesFromBody,
  normalizeTradingRule,
  syncTradingRulesFromBody,
  type DxFeedTradingRulePayload,
} from "./trading-rules-sync.js";

/** How often to check Volumetrica for rule edits (fixed — no extra env). */
const POLL_MS = 60_000;

let lastFingerprint = "";
let inflight = false;
let timer: ReturnType<typeof setInterval> | null = null;

function fingerprintRules(rules: DxFeedTradingRulePayload[]): string {
  const normalized = rules
    .map((r) => normalizeTradingRule(r))
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .map((n) => ({
      reference: n.reference,
      label: n.label ?? "",
      phase: n.phase,
      accountSize: n.accountSize ?? 0,
      fields: n.fields,
    }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Call after a webhook/REST sync so the watcher does not immediately re-apply the same set. */
export function noteTradingRulesFingerprintFromBody(body: unknown): void {
  const rules = extractTradingRulesFromBody(body);
  if (rules.length === 0) return;
  lastFingerprint = fingerprintRules(rules);
}

async function pollOnce(reason: string): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const remote = await propfirm.getTradingRules();
    const wrapped = { data: remote };
    const rules = extractTradingRulesFromBody(wrapped);
    if (rules.length === 0) {
      console.warn(
        `[dxfeed rules] watch (${reason}) — remote returned 0 parseable rules; RuleTemplate unchanged`,
      );
      return;
    }

    const fp = fingerprintRules(rules);
    if (fp === lastFingerprint) {
      return; // no change on Volumetrica — stay quiet
    }

    console.log(
      `[dxfeed rules] watch (${reason}) — Volumetrica rules changed ` +
        `(${rules.length} rule(s)); writing RuleTemplate`,
    );
    console.log(
      "[dxfeed rules] watch refs:",
      rules.map((r) => r.reference ?? r.Reference ?? r.ruleId ?? r.RuleId ?? "?").join(", "),
    );

    const results = await syncTradingRulesFromBody(wrapped);
    const applied = results.filter((r) => r.applied).length;
    lastFingerprint = fp;
    console.log(`[dxfeed rules] watch — RuleTemplate sync applied ${applied}/${results.length}`);
  } catch (err) {
    console.warn(`[dxfeed rules] watch (${reason}) error:`, (err as Error).message);
  } finally {
    inflight = false;
  }
}

/**
 * Start background watch: sync RuleTemplate only when Volumetrica trading rules change.
 * No-op without database + DXFEED_API_KEY.
 */
export function startTradingRulesWatch(): () => void {
  if (!useDatabase) {
    console.log("[dxfeed rules] watch off — DATABASE_URL not set");
    return () => {};
  }
  if (!config.dxfeed.apiKey) {
    console.log("[dxfeed rules] watch off — DXFEED_API_KEY not set");
    return () => {};
  }
  if (timer) return () => stopTradingRulesWatch();

  console.log(
    `[dxfeed rules] watch on — check every ${POLL_MS / 1000}s; ` +
      "RuleTemplate updated only when Volumetrica rules change (no DXFEED_RULE_MAP)",
  );

  void pollOnce("startup");
  timer = setInterval(() => void pollOnce("poll"), POLL_MS);

  return () => stopTradingRulesWatch();
}

export function stopTradingRulesWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
