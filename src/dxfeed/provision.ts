import { config, dxfeedProvisionReady } from "../config.js";
import { propfirm } from "./propfirm.js";
import {
  getDxFeedLinkByOrder,
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
  if (existing?.dxSubscriptionId) return existing;

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
  }

  return link;
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
