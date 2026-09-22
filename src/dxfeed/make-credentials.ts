import { config } from "../config.js";
import {
  getDxFeedLinkByOrder,
  markCredentialsEmailed,
  upsertDxFeedLink,
  type DxFeedLink,
} from "./store.js";
import { Platform } from "./types.js";

/** Human label for DXFEED_PLATFORM / Subscription.platform. */
export function platformLabel(platform: number | null | undefined): string {
  switch (platform) {
    case Platform.QUANTOWER:
      return "Quantower";
    case Platform.ATAS:
      return "ATAS";
    case Platform.VOLUMETRICA:
    default:
      return "Deepchart";
  }
}

export type MakeNotifyResult = {
  ok: boolean;
  reason?: string;
};

/**
 * POST Volumetrica platform access to the SECOND Make.com webhook
 * (MAKE_PLATFORM_CREDENTIALS_WEBHOOK_URL). Returns whether Make accepted.
 */
export async function notifyMakePlatformCredentials(input: {
  orderNumber: string;
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  /** Override payload source (default: dxfeed-agreement-signed). */
  source?: string;
  /**
   * When true (Vault signup complete), skip the agreementSigned DB gate —
   * onboarding already required a signed agreement before register.
   */
  requireAgreementSigned?: boolean;
}): Promise<MakeNotifyResult> {
  const url = config.make.platformCredentialsWebhookUrl;
  if (!url) {
    const reason = "MAKE_PLATFORM_CREDENTIALS_WEBHOOK_URL unset";
    console.warn(`[make] ${reason} — skipping platform credentials email`);
    return { ok: false, reason };
  }

  const fn = input.firstName?.trim() || "";
  const ln = input.lastName?.trim() || "";

  let namesWereMissing = false;
  try {
    const existing = await getDxFeedLinkByOrder(input.orderNumber);
    namesWereMissing = !existing?.firstName?.trim() || !existing?.lastName?.trim();
    // Persist signup-form names before prepare so Make never greets from email local-part.
    if (existing && (fn || ln)) {
      if (fn) existing.firstName = fn;
      if (ln) existing.lastName = ln;
      await upsertDxFeedLink(existing);
    }
  } catch (err) {
    console.warn(
      `[make] could not persist name for order ${input.orderNumber}:`,
      (err as Error).message.slice(0, 160),
    );
  }

  // Always refresh/create subscription + credentials before send.
  try {
    const { preparePlatformCredentialsAfterAgreement } = await import("./provision.js");
    await preparePlatformCredentialsAfterAgreement(input.orderNumber);
  } catch (err) {
    console.warn(
      `[make] prepare before notify failed order ${input.orderNumber}:`,
      (err as Error).message.slice(0, 240),
    );
  }

  const link = await getDxFeedLinkByOrder(input.orderNumber);
  if (!link) {
    const reason = `no DxFeedAccount for order ${input.orderNumber}`;
    console.warn(`[make] ${reason}`);
    return { ok: false, reason };
  }

  const requireAgreement = input.requireAgreementSigned !== false
    && input.source !== "vault-signup-complete";
  if (requireAgreement && !link.agreementSigned) {
    const reason = `agreement not signed yet for order ${input.orderNumber}`;
    console.log(`[make] ${reason}`);
    return { ok: false, reason };
  }

  // Allow a corrective resend when an earlier Make push had empty first/last name
  // and the signup form has now supplied them.
  const correctiveNameSend = namesWereMissing && Boolean(fn && ln);
  if (link.credentialsEmailedAt && !correctiveNameSend) {
    const reason = `credentials already emailed for order ${input.orderNumber}`;
    console.log(`[make] ${reason}`);
    return { ok: false, reason };
  }

  if (!link.platformUsername || !link.platformPassword) {
    const reason =
      `missing platform username/password for order ${input.orderNumber}` +
      ` (user=${link.platformUsername ? "yes" : "no"} pass=${link.platformPassword ? "yes" : "no"})`;
    console.warn(`[make] ${reason}`);
    return { ok: false, reason };
  }

  const payload = buildCredentialsPayload(link, {
    ...input,
    firstName: fn || link.firstName || undefined,
    lastName: ln || link.lastName || undefined,
  });

  if (!String(payload.first_name ?? "").trim() || !String(payload.last_name ?? "").trim()) {
    const reason =
      `refusing Make send with empty first/last name for order ${input.orderNumber}` +
      ` (pass firstName/lastName from the signup form)`;
    console.warn(`[make] ${reason}`);
    return { ok: false, reason };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  const apiKey = config.make.platformCredentialsApiKey;
  if (apiKey) headers["x-make-apikey"] = apiKey;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const reason = `Make webhook HTTP ${res.status}: ${t.slice(0, 200)}`;
      console.error(`[make] ${reason}`);
      return { ok: false, reason };
    }
    await markCredentialsEmailed(input.orderNumber);
    console.log(
      `[make] platform access emailed (${input.source ?? "dxfeed-agreement-signed"})` +
        ` order ${input.orderNumber}` +
        ` name=${payload.first_name} ${payload.last_name}` +
        (correctiveNameSend ? " (corrective)" : ""),
    );
    return { ok: true };
  } catch (err) {
    const reason = `Make webhook unreachable: ${(err as Error).message}`;
    console.error(`[make] ${reason}`);
    return { ok: false, reason };
  }
}

/**
 * When agreementSigned flips true: ensure platform creds + license/SSO, then notify Make.
 */
export async function notifyMakeAfterAgreementSigned(
  orderNumber: string,
  names?: { firstName?: string; lastName?: string },
): Promise<MakeNotifyResult> {
  const link = await getDxFeedLinkByOrder(orderNumber);
  const email = link?.email ?? "";
  const firstName = names?.firstName?.trim() || link?.firstName?.trim() || "";
  const lastName = names?.lastName?.trim() || link?.lastName?.trim() || "";
  const name = [firstName, lastName].filter(Boolean).join(" ")
    || (email.includes("@")
      ? email.split("@")[0]!.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "Trader");

  return notifyMakePlatformCredentials({
    orderNumber,
    email: email || "unknown@example.com",
    name,
    firstName: firstName || undefined,
    lastName: lastName || undefined,
    source: "dxfeed-agreement-signed",
    requireAgreementSigned: true,
  });
}

export function buildCredentialsPayload(
  link: DxFeedLink,
  input: {
    orderNumber: string;
    email: string;
    name: string;
    firstName?: string;
    lastName?: string;
    source?: string;
  },
): Record<string, unknown> {
  const platformId = link.platform ?? config.dxfeed.provisioning.platform;
  const platform = platformLabel(platformId);
  const key = String(platformId);
  const downloads = config.dxfeed.provisioning.downloadUrls;
  const logins = config.dxfeed.provisioning.loginUrls;
  const connectionServer = config.dxfeed.provisioning.connectionServer;

  const downloadLink =
    link.downloadLink
    || downloads[key]
    || downloads.default
    || "";
  const loginUrl =
    link.loginUrl
    || logins[key]
    || logins.default
    || downloadLink
    || "";
  const license = link.platformLicense || "";

  const firstName = (input.firstName ?? link.firstName ?? "").trim();
  const lastName = (input.lastName ?? link.lastName ?? "").trim();
  const name = [firstName, lastName].filter(Boolean).join(" ") || input.name.trim();
  const username = link.platformUsername || "";
  const password = link.platformPassword || "";

  return {
    source: input.source ?? "dxfeed-agreement-signed",
    event: "platform_credentials",
    receivedAt: new Date().toISOString(),
    orderNumber: input.orderNumber,
    order_number: input.orderNumber,
    orderNumberDisplay: `#${input.orderNumber}`,
    email: input.email,
    Email: input.email,
    name,
    Name: name,
    firstName,
    FirstName: firstName,
    first_name: firstName,
    lastName,
    LastName: lastName,
    last_name: lastName,
    platform,
    Platform: platform,
    platformId,
    platformUsername: username,
    platformPassword: password,
    platform_username: username,
    platform_password: password,
    username,
    password,
    license,
    License: license,
    platformLicense: license,
    volumetricaLicense: license,
    downloadLink,
    download_link: downloadLink,
    loginUrl,
    login_url: loginUrl,
    platformsUrl: loginUrl,
    connectionServer,
    dxFeedConnectionServer: connectionServer,
    server: connectionServer,
  };
}
