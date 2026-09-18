/**
 * Smoke tests for dxFeed → Vault trading-rule sync (no DB).
 * Run: npx tsx src/dxfeed/trading-rules-sync.test.ts
 */
import {
  extractTradingRulesFromBody,
  normalizeTradingRule,
  referenceAsTemplateId,
  resolveTemplateId,
} from "./trading-rules-sync.js";

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}

console.log("\ndxFeed trading-rules sync\n");

{
  const id = resolveTemplateId("PRIME_50K_EVAL_PHASE1");
  assert(id === "PRIME_50K_EVAL_PHASE1", `expected same name, got ${id}`);
  console.log("  ✓ Reference is used as template id");
}

{
  const id = resolveTemplateId("PRIME_50K_EVAL_PHASE2");
  assert(id === "PRIME_50K_EVAL_PHASE2", `got ${id}`);
  console.log("  ✓ PHASE2 Reference preserved");
}

{
  const id = referenceAsTemplateId("PRIME_50K_FUND");
  assert(id === "PRIME_50K_FUND", `got ${id}`);
  console.log("  ✓ FUND Reference preserved");
}

{
  const n = normalizeTradingRule({
    Reference: "PRIME_50K_EVAL_PHASE1",
    Description: "50K - Evaluation (Phase 1)",
    StartBalance: 50_000,
    MaxDD: 2_000,
    DailyDD: 1_000,
    Universe: "5/50",
  });
  assert(n, "normalize should return");
  assert(n!.reference === "PRIME_50K_EVAL_PHASE1", "reference");
  assert(n!.phase === "Challenge Phase 1", `phase ${n!.phase}`);
  assert(n!.fields.maxDrawdown === 2000, "maxDrawdown");
  assert(n!.fields.maxDailyLoss === 1000, "maxDailyLoss");
  assert(n!.fields.maxContracts === 5, "maxContracts from universe");
  assert(n!.fields.drawdownType === "INTRADAY", "eval → INTRADAY");
  console.log("  ✓ normalize PHASE1 Admin columns");
}

{
  const n = normalizeTradingRule({
    reference: "PRIME_50K_FUND",
    maxDrawdown: 1500,
    dailyDrawdown: 1000,
    universe: "2/20",
  });
  assert(n!.fields.drawdownType === "EOD", "fund → EOD");
  assert(n!.phase === "Funded", `phase ${n!.phase}`);
  console.log("  ✓ fund rule infers EOD + Funded phase");
}

{
  const rules = extractTradingRulesFromBody({
    category: 6,
    tradingRules: [
      { reference: "PRIME_50K_EVAL_PHASE1", maxDrawdown: 2000 },
      { reference: "NEW_100K_EVAL", maxDrawdown: 4000 },
    ],
  });
  assert(rules.length === 2, `expected 2 rules, got ${rules.length}`);
  console.log("  ✓ extract tradingRules[] including newly added refs");
}

{
  const emptyNotify = extractTradingRulesFromBody({ category: 6, event: 1 });
  assert(emptyNotify.length === 0, "bare TRADING_RULES notify must not invent a rule");
  console.log("  ✓ bare category/event webhook extracts 0 (pull-fallback path)");
}

{
  const nested = extractTradingRulesFromBody({
    data: [{ Reference: "NESTED_50K", MaxDD: 2000, DailyDD: 1000, StartBalance: 50_000 }],
  });
  assert(nested.length === 1, `expected 1 nested rule, got ${nested.length}`);
  const n = normalizeTradingRule(nested[0]!);
  assert(n?.reference === "NESTED_50K", `ref ${n?.reference}`);
  console.log("  ✓ extract data[] with PascalCase Admin columns");
}

console.log("\nAll trading-rules sync checks passed.\n");
