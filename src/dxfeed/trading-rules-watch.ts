/**
 * REST auto-sync of Volumetrica Trading Rules → RuleTemplate.
 *
 * Does NOT use webhooks for rules. Polls Propfirm API V2 only for the catalog:
 *   GET /api/v2/Propsite/TradingRule/List
 * (all other Propsite actions stay on V1.)
 *
 * Writes RuleTemplate only when remote content changes (add/update).
 * Removes dxFeed-sourced templates when a previously synced rule UUID
 * is no longer returned by TradingRule/List (delete).
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
import {
  deleteDxFeedRuleTemplateByRuleId,
  listDxFeedSyncedRuleIds,
} from "../trading/admin-repository.js";

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
      dxRuleId: n.dxRuleId ?? "",
      label: n.label ?? "",
      phase: n.phase,
      accountSize: n.accountSize ?? 0,
      fields: n.fields,
    }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

/** Keep watch fingerprint in sync after a manual REST pull/upsert. */
export function noteTradingRulesFingerprintFromBody(body: unknown): void {
  const rules = extractTradingRulesFromBody(body);
  if (rules.length === 0) return;
  lastFingerprint = fingerprintRules(rules);
}

async function pollOnce(reason: string): Promise<void> {
  if (inflight) return;
  inflight = true;
  try {
    const knownIds = useDatabase ? await listDxFeedSyncedRuleIds() : [];
    const { rules, missingRuleIds } = await propfirm.fetchTradingRulesFromRest(knownIds);

    for (const missing of missingRuleIds) {
      if (!useDatabase) break;
      await deleteDxFeedRuleTemplateByRuleId(missing);
    }

    const wrapped = { data: rules };
    const parsed = extractTradingRulesFromBody(wrapped);
    if (parsed.length === 0 && missingRuleIds.length === 0) {
      if (reason === "startup") {
        console.warn(
          "[dxfeed rules] REST watch — 0 rules from V2 TradingRule/List. " +
            "Confirm DXFEED_API_KEY can read organization trading rules.",
        );
      }
      return;
    }

    const fp = fingerprintRules(parsed) + `|del:${missingRuleIds.slice().sort().join(",")}`;
    if (fp === lastFingerprint) return;

    if (parsed.length > 0) {
      console.log(
        `[dxfeed rules] REST watch (${reason}) — change detected ` +
          `(${parsed.length} rule(s)); writing RuleTemplate`,
      );
      console.log(
        "[dxfeed rules] REST refs:",
        parsed
          .map((r) => r.organizationReferenceId ?? r.reference ?? r.Reference ?? r.ruleId ?? "?")
          .join(", "),
      );
      const results = await syncTradingRulesFromBody(wrapped);
      const applied = results.filter((r) => r.applied).length;
      console.log(`[dxfeed rules] REST watch — applied ${applied}/${results.length}`);
    }

    lastFingerprint = fp;
  } catch (err) {
    console.warn(`[dxfeed rules] REST watch (${reason}) error:`, (err as Error).message);
  } finally {
    inflight = false;
  }
}

/** Start REST polling auto-sync (no webhook). */
export function startTradingRulesWatch(): () => void {
  if (!useDatabase) {
    console.log("[dxfeed rules] REST watch off — DATABASE_URL not set");
    return () => {};
  }
  if (!config.dxfeed.apiKey) {
    console.log("[dxfeed rules] REST watch off — DXFEED_API_KEY not set");
    return () => {};
  }
  if (timer) return () => stopTradingRulesWatch();

  console.log(
    `[dxfeed rules] REST watch on — every ${POLL_MS / 1000}s via V2 TradingRule/List ` +
      "(not webhook); sync RuleTemplate on add/update/delete",
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
