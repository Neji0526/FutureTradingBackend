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

  if (link.credentialsEmailedAt) {
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
      const reason = `Make webhook HTTP ${res.status}: ${t.slice(0, 200)}`;
      console.error(`[make] ${reason}`);
      return { ok: false, reason };
    }
    await markCredentialsEmailed(input.orderNumber);
    console.log(
      `[make] platform access emailed (${input.source ?? "dxfeed-agreement-signed"}) order ${input.orderNumber}`,
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
export async function notifyMakeAfterAgreementSigned(orderNumber: string): Promise<MakeNotifyResult> {
  const link = await getDxFeedLinkByOrder(orderNumber);
  const email = link?.email ?? "";
  const name = email.includes("@")
    ? email.split("@")[0]!.replace(/[._]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    : "Trader";

  return notifyMakePlatformCredentials({
    orderNumber,
    email: email || "unknown@example.com",
    name,
    source: "dxfeed-agreement-signed",
    requireAgreementSigned: true,
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
    platformUsername: link.platformUsername,
    platformPassword: link.platformPassword,
    username: link.platformUsername,
    password: link.platformPassword,
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
