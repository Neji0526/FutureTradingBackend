/* Account progression ladder. Passing one tier's profit target advances to the next.
   dxFeed / Volumetrica PRIME_50K_* References are the source of truth for the 50k path.
   Legacy seed ids (c1_50k, …) remain mapped so older accounts still advance until remapped. */

/** Legacy seed template id → dxFeed organization Reference (RuleTemplate.id after sync). */
export const LEGACY_TO_PRIME: Record<string, string> = {
  c1_50k: "PRIME_50K_EVAL_PHASE1",
  c2_50k: "PRIME_50K_EVAL_PHASE2",
  f_50k: "PRIME_50K_FUND",
  PRIME_50K_EVAL: "PRIME_50K_EVAL_PHASE1",
};

export const NEXT_TIER: Record<string, string> = {
  // dxFeed SoT — 50k Prime path
  PRIME_50K_EVAL_PHASE1: "PRIME_50K_EVAL_PHASE2",
  PRIME_50K_EVAL_PHASE2: "PRIME_50K_FUND",
  PRIME_50K_EVAL: "PRIME_50K_EVAL_PHASE2",
  // Legacy seed ids → next PRIME step (accounts should be remapped onto PRIME)
  c1_50k: "PRIME_50K_EVAL_PHASE2",
  c2_50k: "PRIME_50K_FUND",
  f_50k: "f_100k",
  // Larger funded scaling (local seed; unchanged)
  c1_100k: "c2_100k",
  c2_100k: "f_100k",
  f_100k: "f_250k",
  f_250k: "f_500k",
  f_500k: "f_1m",
};

/** The tier an account advances to on approval, or null if it's at the top / untiered. */
export function nextTierFor(templateId: string | null): string | null {
  if (!templateId) return null;
  return NEXT_TIER[templateId] ?? null;
}

/** True once an account is on a funded tier (vs still in a challenge phase). */
export function isFundedTier(templateId: string | null): boolean {
  if (!templateId) return false;
  if (templateId.startsWith("f_")) return true;
  const u = templateId.toUpperCase();
  return u.includes("FUND") && !u.includes("EVAL");
}
