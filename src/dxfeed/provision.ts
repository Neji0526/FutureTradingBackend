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
  const existing = await getDxFeedLinkByOrder(input.orderNumber);
  if (existing?.dxSubscriptionId) {
    return (await refreshAgreementStatus(input.orderNumber)) ?? existing;
  }

  // Same email already provisioned on another/partial row — reuse instead of NewSubscription.
  const recovered = await adoptExistingSubscriptionForOrder(input.orderNumber, email);
  if (recovered?.dxSubscriptionId) {
    return (await refreshAgreementStatus(input.orderNumber)) ?? recovered;
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
      });
      link.dxSubscriptionId = sub.subscriptionId;
      link.subscriptionStatus = sub.status;
      link.agreementLink = sub.dxAgreementLink;
      link.agreementSigned = sub.dxAgreementSigned;
      link.platform = sub.platform;
      await upsertDxFeedLink(link);
    } catch (err) {
      if (err instanceof DxFeedApiError && /already has a subscription/i.test(err.message)) {
        const again = await adoptExistingSubscriptionForOrder(input.orderNumber, email, link.dxUserId);
        if (again?.dxSubscriptionId) {
          return (await refreshAgreementStatus(input.orderNumber)) ?? again;
        }
      }
      throw err;
    }
  }

  return link;
}

/**
 * Clear Volumetrica subscription/accounts for this purchase email and local
 * DxFeedAccount rows, so the same PAID order can Prepare + sign again
 * (no repurchase).
 */
export async function resetForOnboarding(input: OnboardingProvisionInput): Promise<{
  clearedLocal: number;
  notes: string[];
}> {
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

  // Resolve dx user via upsert-by-email when local rows are incomplete.
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

  for (const subscriptionId of subscriptionIds) {
    try {
      await propfirm.deactivateSubscription(subscriptionId);
      notes.push(`deactivated subscription ${subscriptionId}`);
    } catch (err) {
      notes.push(`deactivate subscription warn: ${(err as Error).message.slice(0, 160)}`);
    }
    try {
      await propfirm.deleteSubscription(subscriptionId);
      notes.push(`deleted subscription ${subscriptionId}`);
    } catch (err) {
      notes.push(`delete subscription warn: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  if (dxUserId) {
    try {
      const accounts = await propfirm.getUserAccounts(dxUserId);
      for (const acct of accounts ?? []) {
        if (acct.id) accountIds.add(acct.id);
      }
    } catch (err) {
      notes.push(`GetUserAccounts warn: ${(err as Error).message.slice(0, 160)}`);
    }
  }

  for (const accountId of accountIds) {
    try {
      await propfirm.disableTradingAccount(accountId, "Vault onboarding reset", true);
      notes.push(`disabled account ${accountId}`);
    } catch (err) {
      notes.push(`disable account warn: ${(err as Error).message.slice(0, 160)}`);
    }
    if (dxUserId) {
      try {
        await propfirm.deleteTradingAccount(dxUserId, accountId);
        notes.push(`deleted account ${accountId}`);
      } catch (err) {
        notes.push(`delete account warn: ${(err as Error).message.slice(0, 160)}`);
      }
    }
  }

  await deleteDxFeedLinksByEmail(email);
  notes.push(`cleared local DxFeedAccount rows for ${email}`);

  return { clearedLocal: links.length, notes };
}

/** Refresh agreementSigned from Propfirm when the webhook has not arrived yet. */
export async function refreshAgreementStatus(orderNumber: string): Promise<DxFeedLink | null> {
  const link = await getDxFeedLinkByOrder(orderNumber);
  if (!link?.dxUserId || !link.dxSubscriptionId || !dxfeedProvisionReady) return link;

  try {
    const raw = await propfirm.getSubscriptionStatus(link.dxUserId, link.dxSubscriptionId);
    const parsed = parseSubscriptionStatus(raw);
    if (parsed) {
      if (parsed.status != null) link.subscriptionStatus = parsed.status;
      if (typeof parsed.agreementSigned === "boolean") link.agreementSigned = parsed.agreementSigned;
      if (parsed.agreementLink !== undefined) {
        link.agreementLink = parsed.agreementLink ?? link.agreementLink;
      }
      await upsertDxFeedLink(link);
    }
  } catch (err) {
    console.warn("[dxfeed] GetSubscriptionStatus failed:", (err as Error).message);
  }
  return link;
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
  if (!donor?.dxSubscriptionId) return null;

  const link: DxFeedLinkInput = {
    orderNumber,
    userId: null,
    email,
    dxUserId: donor.dxUserId || knownDxUserId || "",
    dxAccountId: donor.dxAccountId,
    dxSubscriptionId: donor.dxSubscriptionId,
    accountStatus: donor.accountStatus,
    subscriptionStatus: donor.subscriptionStatus,
    agreementSigned: donor.agreementSigned,
    agreementLink: donor.agreementLink,
    platform: donor.platform,
  };
  if (!link.dxUserId) return null;
  await upsertDxFeedLink(link);
  return link;
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
  status?: number;
  agreementSigned?: boolean;
  agreementLink?: string | null;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nested = (o.subscription && typeof o.subscription === "object"
    ? o.subscription
    : o) as Record<string, unknown>;

  const status = nested.status ?? nested.subscriptionStatus ?? o.status;
  const agreementSigned = nested.dxAgreementSigned ?? nested.agreementSigned ?? o.dxAgreementSigned;
  const agreementLink = (nested.dxAgreementLink ?? nested.agreementLink ?? o.dxAgreementLink) as
    | string
    | null
    | undefined;

  return {
    status: typeof status === "number" ? status : undefined,
    agreementSigned: typeof agreementSigned === "boolean" ? agreementSigned : undefined,
    agreementLink,
  };
}
