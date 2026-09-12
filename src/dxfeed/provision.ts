import { config, dxfeedProvisionReady } from "../config.js";
import { DxFeedApiError, propfirm } from "./propfirm.js";
import {
  deleteDxFeedLinksByEmail,
  getDxFeedLinkByOrder,
  getDxFeedLinksByEmail,
  upsertDxFeedLink,
  type DxFeedLink,
  type DxFeedLinkInput,
} from "./store.js";
import {
  AccountMode, Currency, EncryptionMode, IdReference, UserType,
  type DataFeedProduct, type Platform,
} from "./types.js";

export interface OnboardingProvisionInput {
  orderNumber: string;
  email: string;
  firstName: string;
  lastName: string;
  country: string;
}

export interface ResetOnboardingResult {
  clearedLocal: number;
  notes: string[];
  deletedSubscription: boolean;
  /** When Volumetrica would not delete, we force agreement re-sign on the existing sub. */
  agreementLink: string | null;
  agreementSigned: boolean;
}

/** After dxFeed sign, send the trader back to Vault onboarding for this order. */
export function agreementRedirectUrl(orderNumber: string): string | undefined {
  const base = config.dxfeed.provisioning.onboardingPublicUrl;
  if (!base) return undefined;
  return `${base.replace(/\/$/, "")}/onboarding?order=${encodeURIComponent(orderNumber)}&dxSigned=1`;
}

/**
 * Provision Volumetrica identity via DXFEED_API_KEY so the trader can sign the
 * market-data agreement during onboarding. Keyed by orderNumber (user may not
 * exist yet). Safe to retry — resumes after each successful step.
 */
export async function provisionForOnboarding(input: OnboardingProvisionInput): Promise<DxFeedLink> {
  if (!dxfeedProvisionReady) {
    throw new Error("dxFeed provisioning is not configured (set DXFEED_API_KEY).");
  }

  const email = input.email.trim().toLowerCase();
  const redirectUrl = agreementRedirectUrl(input.orderNumber);
  const existing = await getDxFeedLinkByOrder(input.orderNumber);
  if (existing?.dxSubscriptionId) {
    const refreshed = (await refreshAgreementStatus(input.orderNumber)) ?? existing;
    if (!refreshed.agreementSigned) {
      await ensureAgreementRedirect(refreshed, input.orderNumber, redirectUrl);
    }
    return refreshed;
  }

  const recovered = await adoptExistingSubscriptionForOrder(input.orderNumber, email);
  if (recovered?.dxSubscriptionId) {
    const refreshed = (await refreshAgreementStatus(input.orderNumber)) ?? recovered;
    if (!refreshed.agreementSigned) {
      await ensureAgreementRedirect(refreshed, input.orderNumber, redirectUrl);
    }
    return refreshed;
  }

  const p = config.dxfeed.provisioning;
  const ruleId = p.ruleId;
  const country = (input.country.trim().toUpperCase() || p.country).slice(0, 2);
  const firstName = input.firstName.trim() || "Trader";
  const lastName = input.lastName.trim() || "Account";

  const link: DxFeedLinkInput = existing ?? {
    orderNumber: input.orderNumber,
    userId: null,
    email,
    dxUserId: "",
    dxAccountId: null,
    dxSubscriptionId: null,
    accountStatus: null,
    subscriptionStatus: null,
    agreementSigned: false,
    agreementLink: null,
    platform: null,
  };
  link.email = email;

  if (!link.dxUserId) {
    const user = await propfirm.newUser({
      firstName,
      lastName,
      email,
      country,
      extEntityId: input.orderNumber,
      encryptionMode: EncryptionMode.NONE,
      userType: UserType.USER,
    });
    if (!user.userId) throw new Error("provisionForOnboarding: NewUser returned no userId");
    link.dxUserId = user.userId;
    await upsertDxFeedLink(link);
  }

  // Remote already has a sub (local id missing) — recover via GetSubscriptionStatus(userId).
  if (!link.dxSubscriptionId) {
    const remote = await fetchRemoteSubscription(link.dxUserId);
    if (remote?.subscriptionId) {
      applyRemoteSubscription(link, remote);
      await upsertDxFeedLink(link);
      if (!link.agreementSigned) {
        await ensureAgreementRedirect(link, input.orderNumber, redirectUrl);
      }
      return link;
    }
  }

  if (!link.dxAccountId) {
    const acct = await propfirm.createTradingAccount({
      userId: link.dxUserId,
      balance: p.balance,
      currency: Currency.USD,
      enabled: true,
      mode: AccountMode.EVALUATION,
      description: `Vault ${input.orderNumber}`,
      ...(ruleId ? { accountRuleReference: IdReference.APPLICATION, accountRuleId: ruleId } : {}),
    });
    if (!acct.accountId) throw new Error("provisionForOnboarding: CreateTradingAccount returned no accountId");
    link.dxAccountId = acct.accountId;
    await upsertDxFeedLink(link);
  }

  if (!link.dxSubscriptionId) {
    try {
      const sub = await propfirm.newSubscription({
        userId: link.dxUserId,
        dataFeedProducts: p.dataFeedProducts as DataFeedProduct[],
        platform: p.platform as Platform,
        enabled: true,
        ...(redirectUrl ? { redirectUrl } : {}),
      });
      link.dxSubscriptionId = sub.subscriptionId;
      link.subscriptionStatus = sub.status;
      link.agreementLink = sub.dxAgreementLink;
      link.agreementSigned = sub.dxAgreementSigned;
      link.platform = sub.platform;
      await upsertDxFeedLink(link);
    } catch (err) {
      if (err instanceof DxFeedApiError && /already has a subscription/i.test(err.message)) {
        const remote = await fetchRemoteSubscription(link.dxUserId);
        if (remote?.subscriptionId) {
          applyRemoteSubscription(link, remote);
          await upsertDxFeedLink(link);
          if (!link.agreementSigned) {
            await ensureAgreementRedirect(link, input.orderNumber, redirectUrl);
          }
          return link;
        }
        const again = await adoptExistingSubscriptionForOrder(input.orderNumber, email, link.dxUserId);
        if (again?.dxSubscriptionId) {
          const refreshed = (await refreshAgreementStatus(input.orderNumber)) ?? again;
          if (!refreshed.agreementSigned) {
            await ensureAgreementRedirect(refreshed, input.orderNumber, redirectUrl);
          }
          return refreshed;
        }
      }
      throw err;
    }
  }

  return link;
}

/**
 * Clear or re-open Volumetrica subscription for this PAID purchase email so the
 * trader can sign again without repurchase.
 *
 * Why the old reset looked like a no-op: local DxFeedAccount often had no
 * dxSubscriptionId (NewSubscription succeeded on Volumetrica but never stored),
 * so deactivate/delete never ran. We now resolve the id via
 * GetSubscriptionStatus(userId) per Propfirm swagger.
 */
export async function resetForOnboarding(input: OnboardingProvisionInput): Promise<ResetOnboardingResult> {
  if (!dxfeedProvisionReady) {
    throw new Error("dxFeed provisioning is not configured (set DXFEED_API_KEY).");
  }

  const email = input.email.trim().toLowerCase();
  const notes: string[] = [];
  const byOrder = await getDxFeedLinkByOrder(input.orderNumber);
  const byEmail = await getDxFeedLinksByEmail(email);
  const links = uniqueLinks([...(byOrder ? [byOrder] : []), ...byEmail]);

  let dxUserId = links.find((l) => l.dxUserId)?.dxUserId ?? "";
  const subscriptionIds = new Set(
    links.map((l) => l.dxSubscriptionId).filter((id): id is string => Boolean(id)),
  );
  const accountIds = new Set(
    links.map((l) => l.dxAccountId).filter((id): id is string => Boolean(id)),
  );

  try {
    const user = await propfirm.newUser({
      firstName: input.firstName.trim() || "Trader",
      lastName: input.lastName.trim() || "Account",
      email,
      country: (input.country.trim().toUpperCase() || config.dxfeed.provisioning.country).slice(0, 2),
      extEntityId: input.orderNumber,
      encryptionMode: EncryptionMode.NONE,
      userType: UserType.USER,
    });
    if (user.userId) dxUserId = user.userId;
  } catch (err) {
    notes.push(`NewUser lookup warn: ${(err as Error).message.slice(0, 160)}`);
  }

  if (!dxUserId) {
    throw new Error("Could not resolve Volumetrica user for this email; reset aborted.");
  }

  // Discover remote subscription id even when local DB never saved it.
  let remote = await fetchRemoteSubscription(dxUserId);
  if (remote?.subscriptionId) {
    subscriptionIds.add(remote.subscriptionId);
    notes.push(`discovered remote subscription ${remote.subscriptionId}`);
  } else {
    notes.push("no remote subscription found for user");
  }

  let deletedSubscription = false;
  for (const subscriptionId of [...subscriptionIds]) {
    try {
      await propfirm.deactivateSubscription(subscriptionId);
      notes.push(`deactivated subscription ${subscriptionId}`);
    } catch (err) {
      notes.push(`deactivate subscription warn: ${(err as Error).message.slice(0, 160)}`);
    }
    try {
      await propfirm.deleteSubscription(subscriptionId);
      notes.push(`deleted subscription ${subscriptionId}`);
      deletedSubscription = true;
    } catch (err) {
      notes.push(`delete subscription warn: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  remote = await fetchRemoteSubscription(dxUserId);

  // If Volumetrica still has the sub, force re-sign on it (delete is optional per their docs).
  if (remote?.subscriptionId) {
    const p = config.dxfeed.provisioning;
    const redirectUrl = agreementRedirectUrl(input.orderNumber);
    try {
      await propfirm.updateSubscription(remote.subscriptionId, {
        userId: dxUserId,
        dataFeedProducts: p.dataFeedProducts as DataFeedProduct[],
        platform: p.platform as Platform,
        enabled: true,
        forceUserOnboarding: true,
        ...(redirectUrl ? { redirectUrl } : {}),
      });
      notes.push(`forced onboarding on subscription ${remote.subscriptionId}`);
      try {
        await propfirm.activeSubscription(remote.subscriptionId);
        notes.push(`activated subscription ${remote.subscriptionId}`);
      } catch (err) {
        notes.push(`active subscription warn: ${(err as Error).message.slice(0, 160)}`);
      }
      remote = (await fetchRemoteSubscription(dxUserId)) ?? remote;
      deletedSubscription = false;

      await deleteDxFeedLinksByEmail(email);
      const link: DxFeedLinkInput = {
        orderNumber: input.orderNumber,
        userId: null,
        email,
        dxUserId,
        dxAccountId: links.find((l) => l.dxAccountId)?.dxAccountId ?? null,
        dxSubscriptionId: remote.subscriptionId ?? null,
        accountStatus: null,
        subscriptionStatus: remote.status ?? null,
        agreementSigned: false,
        agreementLink: remote.agreementLink ?? null,
        platform: remote.platform ?? null,
      };
      await upsertDxFeedLink(link);
      notes.push("stored refreshed agreement link for re-sign");

      return {
        clearedLocal: links.length,
        notes,
        deletedSubscription,
        agreementLink: link.agreementLink,
        agreementSigned: false,
      };
    } catch (err) {
      throw new Error(
        `Could not clear or re-open Volumetrica subscription ${remote.subscriptionId}: ${(err as Error).message}. ${notes.join(" | ")}`,
      );
    }
  }

  // Subscription gone — remove trading accounts and local rows so Prepare can recreate.
  try {
    const accounts = await propfirm.getUserAccounts(dxUserId);
    for (const acct of accounts ?? []) {
      if (acct.id) accountIds.add(acct.id);
    }
  } catch (err) {
    notes.push(`GetUserAccounts warn: ${(err as Error).message.slice(0, 160)}`);
  }

  for (const accountId of accountIds) {
    try {
      await propfirm.disableTradingAccount(accountId, "Vault onboarding reset", true);
      notes.push(`disabled account ${accountId}`);
    } catch (err) {
      notes.push(`disable account warn: ${(err as Error).message.slice(0, 160)}`);
    }
    try {
      await propfirm.deleteTradingAccount(dxUserId, accountId);
      notes.push(`deleted account ${accountId}`);
    } catch (err) {
      notes.push(`delete account warn: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  await deleteDxFeedLinksByEmail(email);
  notes.push(`cleared local DxFeedAccount rows for ${email}`);

  return {
    clearedLocal: links.length,
    notes,
    deletedSubscription,
    agreementLink: null,
    agreementSigned: false,
  };
}

/** Refresh agreementSigned from Propfirm when the webhook has not arrived yet.
 *  Persists into DxFeedAccount so onboarding UI can show Signed automatically.
 *
 *  Important: Propfirm GetSubscriptionStatus rejects combined query args —
 *  pass userId OR subscriptionId, never both (Swagger: userId must be null
 *  when subscriptionId is sent). Prefer userId so a stale local sub id cannot
 *  block the signed flag sync.
 */
export async function refreshAgreementStatus(orderNumber: string): Promise<DxFeedLink | null> {
  const link = await getDxFeedLinkByOrder(orderNumber);
  if (!link?.dxUserId || !dxfeedProvisionReady) return link;

  try {
    // userId-only — same path Reset uses to discover remote signed state.
    let raw = await propfirm.getSubscriptionStatus(link.dxUserId, null);
    let parsed = parseSubscriptionStatus(raw);

    // Fallback: subscriptionId alone if userId query returned nothing useful.
    if (!parsed?.subscriptionId && link.dxSubscriptionId) {
      raw = await propfirm.getSubscriptionStatus(null, link.dxSubscriptionId);
      parsed = parseSubscriptionStatus(raw);
    }

    if (parsed) {
      const before = link.agreementSigned;
      if (parsed.subscriptionId) link.dxSubscriptionId = parsed.subscriptionId;
      if (parsed.status != null) link.subscriptionStatus = parsed.status;
      if (typeof parsed.agreementSigned === "boolean") {
        link.agreementSigned = parsed.agreementSigned;
      }
      if (parsed.agreementLink !== undefined) {
        link.agreementLink = parsed.agreementLink ?? link.agreementLink;
      }
      await upsertDxFeedLink(link);
      if (!before && link.agreementSigned) {
        console.log(
          `[dxfeed] order ${orderNumber} agreementSigned synced from Propfirm → true`,
        );
      }
    }
  } catch (err) {
    console.warn("[dxfeed] GetSubscriptionStatus failed:", (err as Error).message);
  }
  return link;
}

async function ensureAgreementRedirect(
  link: DxFeedLinkInput,
  orderNumber: string,
  redirectUrl?: string,
): Promise<void> {
  const url = redirectUrl ?? agreementRedirectUrl(orderNumber);
  if (!url || !link.dxSubscriptionId || !link.dxUserId) return;
  const p = config.dxfeed.provisioning;
  try {
    await propfirm.updateSubscription(link.dxSubscriptionId, {
      userId: link.dxUserId,
      dataFeedProducts: p.dataFeedProducts as DataFeedProduct[],
      platform: p.platform as Platform,
      enabled: true,
      redirectUrl: url,
    });
  } catch (err) {
    console.warn("[dxfeed] ensureAgreementRedirect:", (err as Error).message.slice(0, 200));
  }
}

async function adoptExistingSubscriptionForOrder(
  orderNumber: string,
  email: string,
  knownDxUserId?: string,
): Promise<DxFeedLink | null> {
  const candidates = await getDxFeedLinksByEmail(email);
  const donor = candidates.find((l) => l.dxSubscriptionId)
    ?? candidates.find((l) => l.dxUserId);
  if (!donor?.dxSubscriptionId && !knownDxUserId && !donor?.dxUserId) return null;

  const dxUserId = donor?.dxUserId || knownDxUserId || "";
  if (!dxUserId) return null;

  let subscriptionId = donor?.dxSubscriptionId ?? null;
  let agreementLink = donor?.agreementLink ?? null;
  let agreementSigned = donor?.agreementSigned ?? false;
  let subscriptionStatus = donor?.subscriptionStatus ?? null;
  let platform = donor?.platform ?? null;

  if (!subscriptionId) {
    const remote = await fetchRemoteSubscription(dxUserId);
    if (!remote?.subscriptionId) return null;
    subscriptionId = remote.subscriptionId;
    agreementLink = remote.agreementLink ?? agreementLink;
    if (typeof remote.agreementSigned === "boolean") agreementSigned = remote.agreementSigned;
    if (remote.status != null) subscriptionStatus = remote.status;
    if (remote.platform != null) platform = remote.platform;
  }

  const link: DxFeedLinkInput = {
    orderNumber,
    userId: null,
    email,
    dxUserId,
    dxAccountId: donor?.dxAccountId ?? null,
    dxSubscriptionId: subscriptionId,
    accountStatus: donor?.accountStatus ?? null,
    subscriptionStatus,
    agreementSigned,
    agreementLink,
    platform,
  };
  await upsertDxFeedLink(link);
  return link;
}

async function fetchRemoteSubscription(dxUserId: string): Promise<{
  subscriptionId?: string;
  status?: number;
  agreementSigned?: boolean;
  agreementLink?: string | null;
  platform?: number | null;
} | null> {
  try {
    const raw = await propfirm.getSubscriptionStatus(dxUserId, null);
    return parseSubscriptionStatus(raw);
  } catch (err) {
    console.warn("[dxfeed] fetchRemoteSubscription:", (err as Error).message.slice(0, 200));
    return null;
  }
}

function applyRemoteSubscription(
  link: DxFeedLinkInput,
  remote: {
    subscriptionId?: string;
    status?: number;
    agreementSigned?: boolean;
    agreementLink?: string | null;
    platform?: number | null;
  },
): void {
  if (remote.subscriptionId) link.dxSubscriptionId = remote.subscriptionId;
  if (remote.status != null) link.subscriptionStatus = remote.status;
  if (typeof remote.agreementSigned === "boolean") link.agreementSigned = remote.agreementSigned;
  if (remote.agreementLink !== undefined) link.agreementLink = remote.agreementLink ?? link.agreementLink;
  if (remote.platform != null) link.platform = remote.platform;
}

function uniqueLinks(links: DxFeedLink[]): DxFeedLink[] {
  const seen = new Set<string>();
  const out: DxFeedLink[] = [];
  for (const link of links) {
    if (seen.has(link.orderNumber)) continue;
    seen.add(link.orderNumber);
    out.push(link);
  }
  return out;
}

function parseSubscriptionStatus(raw: unknown): {
  subscriptionId?: string;
  status?: number;
  agreementSigned?: boolean;
  agreementLink?: string | null;
  platform?: number | null;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested = (o.subscription && typeof o.subscription === "object"
    ? o.subscription
    : o.data && typeof o.data === "object"
      ? o.data
      : o) as Record<string, unknown>;

  const subscriptionId = nested.subscriptionId ?? o.subscriptionId;
  const status = nested.status ?? nested.subscriptionStatus ?? o.status;
  const agreementSignedRaw =
    nested.dxAgreementSigned ?? nested.agreementSigned ?? o.dxAgreementSigned ?? o.agreementSigned;
  const agreementSigned =
    typeof agreementSignedRaw === "boolean"
      ? agreementSignedRaw
      : agreementSignedRaw === 1 || agreementSignedRaw === "1" || agreementSignedRaw === "true"
        ? true
        : agreementSignedRaw === 0 || agreementSignedRaw === "0" || agreementSignedRaw === "false"
          ? false
          : undefined;
  const agreementLink = (nested.dxAgreementLink ?? nested.agreementLink ?? o.dxAgreementLink) as
    | string
    | null
    | undefined;
  const platform = nested.platform ?? o.platform;

  return {
    subscriptionId: typeof subscriptionId === "string" && subscriptionId ? subscriptionId : undefined,
    status: typeof status === "number" ? status : undefined,
    agreementSigned,
    agreementLink,
    platform: typeof platform === "number" ? platform : null,
  };
}
