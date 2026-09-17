/**
 * Smoke tests for dxFeed → Vault trading-rule sync (no DB).
 * Run: npx tsx src/dxfeed/trading-rules-sync.test.ts
 */
import {
  extractTradingRulesFromBody,
  normalizeTradingRule,
  resolveTemplateId,
} from "./trading-rules-sync.js";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log("\ndxFeed trading-rules sync\n");

{
  const id = resolveTemplateId("PRIME_50K_EVAL");
  assert(id === "c1_50k", `expected c1_50k, got ${id}`);
  console.log("  ✓ PRIME_50K_EVAL → c1_50k");
}

{
  const id = resolveTemplateId("PRIME_50K_FUND");
  assert(id === "f_50k", `expected f_50k, got ${id}`);
  console.log("  ✓ PRIME_50K_FUND → f_50k");
}

{
  const n = normalizeTradingRule({
    Reference: "PRIME_50K_EVAL",
    Description: "Prime 50K - Evaluation",
    StartBalance: 50_000,
    MaxDD: 2_500,
    DailyDD: 1_250,
    Universe: "5/50",
  });
  assert(n, "normalize should return");
  assert(n!.reference === "PRIME_50K_EVAL", "reference");
  assert(n!.fields.maxDrawdown === 2500, "maxDrawdown");
  assert(n!.fields.maxDailyLoss === 1250, "maxDailyLoss");
  assert(n!.fields.maxContracts === 5, "maxContracts from universe");
  assert(n!.fields.drawdownType === "INTRADAY", "eval → INTRADAY");
  console.log("  ✓ normalize Volumetrica Admin columns");
}

{
  const n = normalizeTradingRule({
    reference: "PRIME_50K_FUND",
    maxDrawdown: 1500,
    dailyDrawdown: 1000,
    profitTarget: 5000,
    universe: "2/20",
  });
  assert(n!.fields.drawdownType === "EOD", "fund → EOD");
  assert(n!.fields.maxContracts === 2, "universe minis");
  console.log("  ✓ fund rule infers EOD drawdown");
}

{
  const rules = extractTradingRulesFromBody({
    category: 6,
    tradingRules: [
      { reference: "PRIME_50K_EVAL", maxDrawdown: 2000 },
      { reference: "PRIME_50K_FUND", maxDrawdown: 1500 },
    ],
  });
  assert(rules.length === 2, `expected 2 rules, got ${rules.length}`);
  console.log("  ✓ extract tradingRules[] from webhook body");
}

console.log("\nAll trading-rules sync checks passed.\n");
