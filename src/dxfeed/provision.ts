import { randomBytes } from "node:crypto";
import { config, dxfeedProvisionReady } from "../config.js";
import { DxFeedApiError, propfirm } from "./propfirm.js";
import {
  deleteDxFeedLinksByEmail,
  getDxFeedLinkByOrder,
  getDxFeedLinkByUserId,
  getDxFeedLinksByEmail,
  upsertDxFeedLink,
  type DxFeedLink,
  type DxFeedLinkInput,
} from "./store.js";
import {
  AccountMode, Currency, EncryptionMode, UserType,
  type DataFeedProduct, type Platform,
} from "./types.js";

function labelPlatform(platform: number | null | undefined): string {
  switch (platform) {
    case 1:
      return "Quantower";
    case 2:
      return "ATAS";
    case 0:
    default:
      return "Deepchart";
  }
}

/** Platform password (Deepchart / ATAS / Quantower) — shown once via Make email. */
function makePlatformPassword(): string {
  const raw = randomBytes(18).toString("base64").replace(/[+/=]/g, "");
  return `Vt${raw.slice(0, 14)}!9`;
}

function emptyPlatformCreds(): Pick<
  DxFeedLink,
  | "firstName"
  | "lastName"
  | "platformUsername"
  | "platformPassword"
  | "platformLicense"
  | "downloadLink"
  | "loginUrl"
  | "credentialsEmailedAt"
> {
  return {
    firstName: null,
    lastName: null,
    platformUsername: null,
    platformPassword: null,
    platformLicense: null,
    downloadLink: null,
    loginUrl: null,
    credentialsEmailedAt: null,
  };
}

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
    await ensurePlatformCredentials(refreshed, input);
    return (await getDxFeedLinkByOrder(input.orderNumber)) ?? refreshed;
  }

  const recovered = await adoptExistingSubscriptionForOrder(input.orderNumber, email);
  if (recovered?.dxSubscriptionId) {
    const refreshed = (await refreshAgreementStatus(input.orderNumber)) ?? recovered;
    if (!refreshed.agreementSigned) {
      await ensureAgreementRedirect(refreshed, input.orderNumber, redirectUrl);
    }
    await ensurePlatformCredentials(refreshed, input);
    return (await getDxFeedLinkByOrder(input.orderNumber)) ?? refreshed;
  }

  const p = config.dxfeed.provisioning;
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
    ...emptyPlatformCreds(),
  };
  link.email = email;
  link.firstName = firstName;
  link.lastName = lastName;

  // Always ensure a live Volumetrica user exists (V2 User). Stale local dxUserId
  // after Reset causes CreateTradingAccount 404 "User not found".
  await ensureRemotePlatformUser(link, {
    firstName,
    lastName,
    email,
    country,
    orderNumber: input.orderNumber,
  });

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
    // Create account without trading rule here — rule is attached on Complete onboarding
    // via ChangeTradingRuleForAccount (avoids Prepare-agreement failures from bad rule ids).
    if (!link.dxUserId) {
      throw new Error("provisionForOnboarding: missing dxUserId before CreateTradingAccount");
    }
    let acct;
    try {
      acct = await propfirm.createTradingAccount({
        userId: link.dxUserId,
        balance: p.balance,
        currency: Currency.USD,
        enabled: true,
        mode: AccountMode.EVALUATION,
        description: `Vault ${input.orderNumber}`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Remote user vanished — recreate via V2 User and retry once.
      if (/user not found/i.test(msg)) {
        console.warn(
          `[dxfeed] CreateTradingAccount user not found (${link.dxUserId.slice(0, 36)}) — recreate V2 User and retry`,
        );
        link.dxUserId = "";
        await ensureRemotePlatformUser(link, {
          firstName,
          lastName,
          email,
          country,
          orderNumber: input.orderNumber,
          forceRecreate: true,
        });
        acct = await propfirm.createTradingAccount({
          userId: link.dxUserId,
          balance: p.balance,
          currency: Currency.USD,
          enabled: true,
          mode: AccountMode.EVALUATION,
          description: `Vault ${input.orderNumber}`,
        });
      } else {
        throw err;
      }
    }
    if (!acct.accountId) throw new Error("provisionForOnboarding: CreateTradingAccount returned no accountId");
    link.dxAccountId = acct.accountId;
    await upsertDxFeedLink(link);

    const syncId = acct.tradingRuleId?.trim();
    if (syncId) {
      const { syncTradingRuleById } = await import("./trading-rules-sync.js");
      const synced = await syncTradingRuleById(syncId);
      if (synced.applied) {
        console.log(
          `[dxfeed] provision synced RuleTemplate ${synced.templateId} from ruleId=${syncId}`,
        );
      } else {
        console.warn(`[dxfeed] provision rule sync skipped: ${synced.reason ?? "unknown"}`);
      }
    }
  }

  if (!link.dxSubscriptionId) {
    try {
      await ensureV2SubscribedAccount(link, redirectUrl);
      await enrichDownloadAndLogin(link);
      await upsertDxFeedLink(link);
    } catch (err) {
      if (err instanceof DxFeedApiError && /already has a subscription/i.test(err.message)) {
        const remote = await fetchRemoteSubscription(link.dxUserId);
        if (remote?.subscriptionId) {
          applyRemoteSubscription(link, remote);
          try {
            await ensureV2SubscribedAccount(link, redirectUrl);
          } catch (e2) {
            console.warn("[dxfeed] ensureV2 after adopt:", (e2 as Error).message.slice(0, 200));
          }
          await upsertDxFeedLink(link);
          if (!link.agreementSigned) {
            await ensureAgreementRedirect(link, input.orderNumber, redirectUrl);
          }
          return link;
        }
        const again = await adoptExistingSubscriptionForOrder(input.orderNumber, email, link.dxUserId);
        if (again?.dxSubscriptionId) {
          const refreshed = (await refreshAgreementStatus(input.orderNumber)) ?? again;
          try {
            await ensureV2SubscribedAccount(refreshed, redirectUrl);
            await upsertDxFeedLink(refreshed);
          } catch (e2) {
            console.warn("[dxfeed] ensureV2 after recover:", (e2 as Error).message.slice(0, 200));
          }
          if (!refreshed.agreementSigned) {
            await ensureAgreementRedirect(refreshed, input.orderNumber, redirectUrl);
          }
          return (await getDxFeedLinkByOrder(input.orderNumber)) ?? refreshed;
        }
      }
      throw err;
    }
  } else {
    // Existing local subscription id — still ensure V2 Deepchart fields (license/download).
    try {
      await ensureV2SubscribedAccount(link, redirectUrl);
      await enrichDownloadAndLogin(link);
      await upsertDxFeedLink(link);
    } catch (e) {
      console.warn("[dxfeed] ensureV2 existing sub:", (e as Error).message.slice(0, 200));
    }
  }

  await enrichDownloadAndLogin(link);
  await upsertDxFeedLink(link);
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
    const user = await propfirm.createUserV2({
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
    notes.push(`V2 User lookup warn: ${(err as Error).message.slice(0, 160)}`);
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
      const donorCreds = links.find((l) => l.platformUsername && l.platformPassword);
      const link: DxFeedLinkInput = {
        orderNumber: input.orderNumber,
        userId: null,
        email,
        firstName: input.firstName.trim() || donorCreds?.firstName || null,
        lastName: input.lastName.trim() || donorCreds?.lastName || null,
        dxUserId,
        dxAccountId: links.find((l) => l.dxAccountId)?.dxAccountId ?? null,
        dxSubscriptionId: remote.subscriptionId ?? null,
        accountStatus: null,
        subscriptionStatus: remote.status ?? null,
        agreementSigned: false,
        agreementLink: remote.agreementLink ?? null,
        platform: remote.platform ?? null,
        platformUsername: donorCreds?.platformUsername ?? null,
        platformPassword: donorCreds?.platformPassword ?? null,
        platformLicense: donorCreds?.platformLicense ?? remote.license ?? null,
        downloadLink: donorCreds?.downloadLink ?? remote.downloadLink ?? null,
        loginUrl: donorCreds?.loginUrl ?? null,
        credentialsEmailedAt: null,
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
      if (parsed.downloadLink && !link.downloadLink) {
        link.downloadLink = parsed.downloadLink;
      }
      if (parsed.license && !link.platformLicense) {
        link.platformLicense = parsed.license;
      }
      if (parsed.platform != null && link.platform == null) {
        link.platform = parsed.platform;
      }
      await upsertDxFeedLink(link);
      if (!before && link.agreementSigned) {
        console.log(
          `[dxfeed] order ${orderNumber} agreementSigned synced from Propfirm → true`,
        );
        // Trading rule is attached on Complete onboarding (not on sign).
      }
    }
  } catch (err) {
    console.warn("[dxfeed] GetSubscriptionStatus failed:", (err as Error).message);
  }
  return link;
}

/**
 * After dxFeed agreement is signed / onboarding complete:
 * ensure V2 subscribed account (Deepchart license + download), credentials, SSO.
 */
export async function preparePlatformCredentialsAfterAgreement(
  orderNumber: string,
): Promise<DxFeedLink | null> {
  const link = (await refreshAgreementStatus(orderNumber)) ?? (await getDxFeedLinkByOrder(orderNumber));
  if (!link?.dxUserId) return null;

  const email = link.email.trim().toLowerCase();
  // Prefer onboarding-form names stored on the link; email local-part is last-resort only.
  const firstName =
    link.firstName?.trim()
    || email.split("@")[0]?.replace(/[._0-9]+/g, " ").trim().split(/\s+/).filter(Boolean)[0]
    || "Trader";
  const lastName =
    link.lastName?.trim()
    || "Account";
  if (!link.firstName) link.firstName = firstName;
  if (!link.lastName) link.lastName = lastName;

  try {
    await ensureV2SubscribedAccount(link, agreementRedirectUrl(orderNumber));
  } catch (err) {
    console.warn(
      `[dxfeed] ensureV2SubscribedAccount order ${orderNumber}:`,
      (err as Error).message.slice(0, 240),
    );
  }

  await ensurePlatformCredentials(link, {
    orderNumber,
    email,
    firstName,
    lastName,
    country: config.dxfeed.provisioning.country,
  });

  await enrichDownloadAndLogin(link);
  await upsertDxFeedLink(link);
  return (await getDxFeedLinkByOrder(orderNumber)) ?? link;
}

export type PlatformAccessView = {
  ready: boolean;
  platform: string;
  platformId: number | null;
  downloadLink: string | null;
  /** Fresh short-lived Volumetrica SSO URL when available. */
  loginUrl: string | null;
  username: string | null;
  connectionServer: string;
};

/**
 * Dashboard: resolve Deepchart download + one-time login for the signed-in trader.
 * Mints a fresh LoginUrl SSO each call (links expire).
 */
export async function resolvePlatformAccessForTrader(opts: {
  userId: string;
  email: string;
}): Promise<PlatformAccessView | null> {
  if (!dxfeedProvisionReady) return null;

  const email = opts.email.trim().toLowerCase();
  let link =
    (await getDxFeedLinkByUserId(opts.userId))
    ?? (email
      ? (await getDxFeedLinksByEmail(email)).find((l) => l.dxUserId) ?? null
      : null);

  if (!link?.dxUserId) {
    return {
      ready: false,
      platform: labelPlatform(config.dxfeed.provisioning.platform),
      platformId: config.dxfeed.provisioning.platform,
      downloadLink: null,
      loginUrl: null,
      username: null,
      connectionServer: config.dxfeed.provisioning.connectionServer,
    };
  }

  if (!link.userId && opts.userId) {
    link.userId = opts.userId;
  }

  await enrichDownloadAndLogin(link);
  await upsertDxFeedLink(link);

  const downloadLink = link.downloadLink?.trim() || null;
  const loginUrl = link.loginUrl?.trim() || null;
  const ready = Boolean(downloadLink || loginUrl);

  return {
    ready,
    platform: labelPlatform(link.platform ?? config.dxfeed.provisioning.platform),
    platformId: link.platform ?? config.dxfeed.provisioning.platform,
    downloadLink,
    loginUrl,
    username: link.platformUsername?.trim() || null,
    connectionServer: config.dxfeed.provisioning.connectionServer,
  };
}

function subscriptionPayload(userId: string, redirectUrl?: string) {
  const p = config.dxfeed.provisioning;
  return {
    userId,
    dataFeedProducts: p.dataFeedProducts as DataFeedProduct[],
    platform: p.platform as Platform,
    enabled: true,
    ...(p.platform === 0 && p.volumetricaPlatform
      ? { volumetricaPlatform: p.volumetricaPlatform }
      : {}),
    ...(redirectUrl ? { redirectUrl } : {}),
  };
}

function applySubscriptionView(
  link: DxFeedLinkInput,
  view: {
    subscriptionId: string | null;
    status: number | null;
    dxAgreementSigned: boolean;
    dxAgreementLink: string | null;
    platform: number | null;
    volumetricaLicense: string | null;
    volumetricaDownloadLink: string | null;
  },
): void {
  if (view.subscriptionId) link.dxSubscriptionId = view.subscriptionId;
  if (view.status != null) link.subscriptionStatus = view.status;
  link.agreementSigned = view.dxAgreementSigned || link.agreementSigned;
  if (view.dxAgreementLink) link.agreementLink = view.dxAgreementLink;
  if (view.platform != null) link.platform = view.platform;
  if (view.volumetricaDownloadLink) link.downloadLink = view.volumetricaDownloadLink;
  if (view.volumetricaLicense) link.platformLicense = view.volumetricaLicense;
}

/**
 * Create or activate V2 Propsite Subscription so Volumetrica returns
 * volumetricaDownloadLink / license (Deepchart Platforms page).
 */
async function ensureV2SubscribedAccount(
  link: DxFeedLinkInput,
  redirectUrl?: string,
): Promise<void> {
  if (!link.dxUserId) return;
  const payload = subscriptionPayload(link.dxUserId, redirectUrl);

  let view =
    (await propfirm.getSubscriptionV2(link.dxUserId, link.dxSubscriptionId))
    ?? (link.dxSubscriptionId
      ? await propfirm.getSubscriptionV2(null, link.dxSubscriptionId)
      : null)
    ?? (await propfirm.getSubscriptionV2(link.dxUserId, null));

  if (!view) {
    try {
      view = await propfirm.createSubscriptionV2(payload);
      console.log(
        `[dxfeed] V2 Subscription created ${view.subscriptionId} platform=${view.volumetricaPlatform ?? payload.platform}`,
      );
    } catch (err) {
      if (!(err instanceof DxFeedApiError) || !/already has a subscription|already exist/i.test(err.message)) {
        // Fall back to V1 create once, then re-read.
        try {
          const sub = await propfirm.newSubscription(payload);
          link.dxSubscriptionId = sub.subscriptionId;
          link.subscriptionStatus = sub.status;
          link.agreementLink = sub.dxAgreementLink;
          link.agreementSigned = sub.dxAgreementSigned;
          link.platform = sub.platform;
          view = await propfirm.getSubscriptionV2(link.dxUserId, sub.subscriptionId)
            ?? await propfirm.getSubscriptionV2(link.dxUserId, null);
        } catch (e2) {
          if (err instanceof DxFeedApiError) throw err;
          throw e2;
        }
      } else {
        const remote = await fetchRemoteSubscription(link.dxUserId);
        if (remote?.subscriptionId) {
          applyRemoteSubscription(link, remote);
          view = await propfirm.getSubscriptionV2(link.dxUserId, remote.subscriptionId)
            ?? await propfirm.getSubscriptionV2(link.dxUserId, null);
        }
        if (!view) throw err;
      }
    }
  }

  if (!view?.subscriptionId) return;
  const subscriptionId = view.subscriptionId;

  // Ensure Deepchart® product is attached (download link).
  if (!view.volumetricaDownloadLink && payload.volumetricaPlatform) {
    try {
      const updated = await propfirm.updateSubscriptionV2(subscriptionId, payload);
      if (updated) view = updated;
    } catch {
      try {
        await propfirm.updateSubscription(subscriptionId, payload);
        view = await propfirm.getSubscriptionV2(link.dxUserId, subscriptionId) ?? view;
      } catch (e) {
        console.warn("[dxfeed] subscription update volumetricaPlatform:", (e as Error).message.slice(0, 160));
      }
    }
  }

  try {
    const activated = await propfirm.activeSubscriptionV2(subscriptionId);
    if (activated) view = activated;
  } catch {
    try {
      await propfirm.activeSubscription(subscriptionId);
    } catch {
      /* already active */
    }
  }

  view = await propfirm.getSubscriptionV2(link.dxUserId, subscriptionId)
    ?? await propfirm.getSubscriptionV2(null, subscriptionId)
    ?? view;

  applySubscriptionView(link, view);
  await upsertDxFeedLink(link);
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
      ...(p.platform === 0 && p.volumetricaPlatform
        ? { volumetricaPlatform: p.volumetricaPlatform }
        : {}),
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
    firstName: donor?.firstName ?? null,
    lastName: donor?.lastName ?? null,
    dxUserId,
    dxAccountId: donor?.dxAccountId ?? null,
    dxSubscriptionId: subscriptionId,
    accountStatus: donor?.accountStatus ?? null,
    subscriptionStatus,
    agreementSigned,
    agreementLink,
    platform,
    platformUsername: donor?.platformUsername ?? null,
    platformPassword: donor?.platformPassword ?? null,
    platformLicense: donor?.platformLicense ?? null,
    downloadLink: donor?.downloadLink ?? null,
    loginUrl: donor?.loginUrl ?? null,
    credentialsEmailedAt: null,
  };
  await upsertDxFeedLink(link);
  return link;
}

/**
 * Ensure Deepchart / ATAS / Quantower username+password exist on the link.
 * Uses V2 Propsite/User; recreates when local dxUserId is stale on Volumetrica.
 */
async function ensurePlatformCredentials(
  link: DxFeedLinkInput,
  input: OnboardingProvisionInput,
): Promise<void> {
  const country = (input.country.trim().toUpperCase() || config.dxfeed.provisioning.country).slice(0, 2);
  await ensureRemotePlatformUser(link, {
    firstName: input.firstName.trim() || "Trader",
    lastName: input.lastName.trim() || "Account",
    email: input.email.trim().toLowerCase(),
    country,
    orderNumber: input.orderNumber,
  });
  await enrichDownloadAndLogin(link);
  await upsertDxFeedLink(link);
}

/**
 * Verify/create Volumetrica user via V2 APIs before CreateTradingAccount / subscription.
 * @see https://dxfeed.volumetricaprop.com/swagger/index.html — GET/POST/PUT /api/v2/Propsite/User
 */
async function ensureRemotePlatformUser(
  link: DxFeedLinkInput,
  opts: {
    firstName: string;
    lastName: string;
    email: string;
    country: string;
    orderNumber: string;
    forceRecreate?: boolean;
  },
): Promise<void> {
  if (link.dxUserId && !opts.forceRecreate) {
    const remote = await propfirm.getUserV2(link.dxUserId);
    if (remote) {
      if (!link.platformUsername || !link.platformPassword) {
        await createOrRefreshPlatformUser(link, {
          firstName: opts.firstName,
          lastName: opts.lastName,
          email: opts.email,
          country: opts.country,
          orderNumber: opts.orderNumber,
          forceNewPassword: true,
        });
      }
      return;
    }
    console.warn(
      `[dxfeed] local dxUserId ${link.dxUserId.slice(0, 36)} not found on Volumetrica — creating new V2 user`,
    );
    link.dxUserId = "";
    // Stale account id cannot be reused under a new user.
    link.dxAccountId = null;
  }

  await createOrRefreshPlatformUser(link, {
    firstName: opts.firstName,
    lastName: opts.lastName,
    email: opts.email,
    country: opts.country,
    orderNumber: opts.orderNumber,
    forceNewPassword: Boolean(link.dxUserId),
  });
}

async function createOrRefreshPlatformUser(
  link: DxFeedLinkInput,
  opts: {
    firstName: string;
    lastName: string;
    email: string;
    country: string;
    orderNumber: string;
    forceNewPassword: boolean;
  },
): Promise<void> {
  const password = makePlatformPassword();
  const body = {
    firstName: opts.firstName,
    lastName: opts.lastName,
    email: opts.email,
    country: opts.country,
    extEntityId: opts.orderNumber,
    encryptionMode: EncryptionMode.NONE,
    userType: UserType.USER,
    passwordToSet: password,
    ...(opts.forceNewPassword ? { forceNewPassword: true } : {}),
  };

  let user: Awaited<ReturnType<typeof propfirm.createUserV2>>;
  if (link.dxUserId && opts.forceNewPassword) {
    try {
      user = await propfirm.updateUserV2(link.dxUserId, body);
    } catch (err) {
      if (err instanceof DxFeedApiError && (err.status === 404 || /not found/i.test(err.message))) {
        link.dxUserId = "";
        link.dxAccountId = null;
        user = await propfirm.createUserV2({ ...body, forceNewPassword: false });
      } else {
        throw err;
      }
    }
  } else {
    user = await propfirm.createUserV2(body);
  }

  if (!user.userId && !link.dxUserId) {
    throw new Error("provisionForOnboarding: V2 User returned no userId");
  }
  if (user.userId) link.dxUserId = user.userId;
  link.platformUsername = user.username?.trim() || opts.email;
  link.platformPassword =
    (user.encryptionMode === EncryptionMode.NONE ? user.password : null)?.trim() || password;
  await upsertDxFeedLink(link);
}

/** Pull Volumetrica Platforms license + download + SSO LoginUrl for Make email. */
async function enrichDownloadAndLogin(link: DxFeedLinkInput): Promise<void> {
  if (link.dxUserId) {
    try {
      const view = await propfirm.getSubscriptionV2(link.dxUserId, link.dxSubscriptionId)
        ?? (link.dxSubscriptionId
          ? await propfirm.getSubscriptionV2(null, link.dxSubscriptionId)
          : null)
        ?? (await propfirm.getSubscriptionV2(link.dxUserId, null));
      if (view) applySubscriptionView(link, view);
    } catch {
      /* fall through to V1 parse */
    }
    const remote = await fetchRemoteSubscription(link.dxUserId);
    if (remote) applyRemoteSubscription(link, remote);
  }

  if (!link.downloadLink && link.dxSubscriptionId) {
    // Stable Volumetrica installer URL pattern observed from V2 create response.
    link.downloadLink =
      `${config.dxfeed.propfirmUrl.replace(/\/$/, "")}/download/PlatformSetup/${link.dxSubscriptionId}`;
  }
  if (!link.downloadLink) {
    const key = String(link.platform ?? config.dxfeed.provisioning.platform);
    const urls = config.dxfeed.provisioning.downloadUrls;
    link.downloadLink = urls[key] || urls.default || null;
  }

  if (link.dxUserId) {
    try {
      const sso = await propfirm.getLoginUrl(link.dxUserId, link.dxAccountId);
      if (sso) link.loginUrl = sso;
    } catch {
      /* optional */
    }
  }
  if (!link.loginUrl) {
    const key = String(link.platform ?? config.dxfeed.provisioning.platform);
    const urls = config.dxfeed.provisioning.loginUrls;
    link.loginUrl = urls[key] || urls.default || null;
  }
}

async function fetchRemoteSubscription(dxUserId: string): Promise<{
  subscriptionId?: string;
  status?: number;
  agreementSigned?: boolean;
  agreementLink?: string | null;
  platform?: number | null;
  downloadLink?: string | null;
  license?: string | null;
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
    downloadLink?: string | null;
    license?: string | null;
  },
): void {
  if (remote.subscriptionId) link.dxSubscriptionId = remote.subscriptionId;
  if (remote.status != null) link.subscriptionStatus = remote.status;
  if (typeof remote.agreementSigned === "boolean") link.agreementSigned = remote.agreementSigned;
  if (remote.agreementLink !== undefined) link.agreementLink = remote.agreementLink ?? link.agreementLink;
  if (remote.platform != null) link.platform = remote.platform;
  if (remote.downloadLink) link.downloadLink = remote.downloadLink;
  if (remote.license) link.platformLicense = remote.license;
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
  downloadLink?: string | null;
  license?: string | null;
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
  const downloadRaw =
    nested.volumetricaDownloadLink
    ?? nested.downloadLink
    ?? nested.platformDownloadUrl
    ?? nested.downloadUrl
    ?? o.volumetricaDownloadLink
    ?? o.downloadLink;
  const downloadLink =
    typeof downloadRaw === "string" && downloadRaw.startsWith("http") ? downloadRaw : null;
  const licenseRaw =
    nested.volumetricaLicense ?? nested.license ?? o.volumetricaLicense ?? o.license;
  const license =
    typeof licenseRaw === "string" && licenseRaw.trim() ? licenseRaw.trim() : null;

  return {
    subscriptionId: typeof subscriptionId === "string" && subscriptionId ? subscriptionId : undefined,
    status: typeof status === "number" ? status : undefined,
    agreementSigned,
    agreementLink,
    platform: typeof platform === "number" ? platform : null,
    downloadLink,
    license,
  };
}
