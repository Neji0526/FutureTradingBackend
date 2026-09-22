import { config } from "../config.js";
import {
  getDxFeedLinkByOrder,
  markCredentialsEmailed,
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

/**
 * After dxFeed agreement is signed: POST Volumetrica platform access to Make.com.
 * Includes username/password, license, download link, SSO loginUrl, connection server.
 * Idempotent via credentialsEmailedAt. Non-fatal if Make is down.
 */
export async function notifyMakePlatformCredentials(input: {
  orderNumber: string;
  email: string;
  name: string;
  /** Override payload source (default: dxfeed-agreement-signed). */
  source?: string;
}): Promise<void> {
  const url = config.make.platformCredentialsWebhookUrl;
  if (!url) {
    console.warn(
      "[make] MAKE_PLATFORM_CREDENTIALS_WEBHOOK_URL unset — skipping platform credentials email",
    );
    return;
  }

  const link = await getDxFeedLinkByOrder(input.orderNumber);
  if (!link) {
    console.warn(`[make] no DxFeedAccount for order ${input.orderNumber} — skip credentials email`);
    return;
  }
  if (!link.agreementSigned) {
    console.log(`[make] agreement not signed yet for order ${input.orderNumber} — skip`);
    return;
  }
  if (link.credentialsEmailedAt) {
    console.log(`[make] credentials already emailed for order ${input.orderNumber}`);
    return;
  }
  if (!link.platformUsername || !link.platformPassword) {
    console.warn(
      `[make] missing platform username/password for order ${input.orderNumber} — skip credentials email`,
    );
    return;
  }

  const payload = buildCredentialsPayload(link, input);
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
      console.error(
        `[make] platform credentials webhook rejected HTTP ${res.status}: ${t.slice(0, 400)}`,
      );
      return;
    }
    await markCredentialsEmailed(input.orderNumber);
    console.log(
      `[make] platform access emailed (${input.source ?? "dxfeed-agreement-signed"}) order ${input.orderNumber}`,
    );
  } catch (err) {
    console.error("[make] platform credentials webhook unreachable:", (err as Error).message);
  }
}

/**
 * When agreementSigned flips true: ensure platform creds + license/SSO, then notify Make.
 */
export async function notifyMakeAfterAgreementSigned(orderNumber: string): Promise<void> {
  const { preparePlatformCredentialsAfterAgreement } = await import("./provision.js");
  const prepared = await preparePlatformCredentialsAfterAgreement(orderNumber);
  if (!prepared) return;

  const email = prepared.email;
  const name =
    email.includes("@") ? email.split("@")[0]!.replace(/[._]/g, " ") : "Trader";

  await notifyMakePlatformCredentials({
    orderNumber: prepared.orderNumber,
    email,
    name: name.replace(/\b\w/g, (c) => c.toUpperCase()),
  });
}

export function buildCredentialsPayload(
  link: DxFeedLink,
  input: { orderNumber: string; email: string; name: string; source?: string },
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

  return {
    source: input.source ?? "dxfeed-agreement-signed",
    event: "platform_credentials",
    receivedAt: new Date().toISOString(),
    orderNumber: input.orderNumber,
    order_number: input.orderNumber,
    orderNumberDisplay: `#${input.orderNumber}`,
    email: input.email,
    Email: input.email,
    name: input.name,
    Name: input.name,
    platform,
    Platform: platform,
    platformId,
    // Volumetrica Platforms account (Deepchart / ATAS / Quantower)
    platformUsername: link.platformUsername,
    platformPassword: link.platformPassword,
    username: link.platformUsername,
    password: link.platformPassword,
    // License shown on Volumetrica → Download platform (Deepchart®)
    license,
    License: license,
    platformLicense: license,
    volumetricaLicense: license,
    // Setup installer link when API returns it
    downloadLink,
    download_link: downloadLink,
    // SSO into Volumetrica dashboard (Platforms / license / download) — preferred CTA
    loginUrl,
    login_url: loginUrl,
    platformsUrl: loginUrl,
    // Desktop connection param from Volumetrica UI
    connectionServer,
    dxFeedConnectionServer: connectionServer,
    server: connectionServer,
  };
}
