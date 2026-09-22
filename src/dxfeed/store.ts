import { useDatabase } from "../config.js";
import { getPool } from "../db/pool.js";

/** Purchase-keyed dxFeed link for Vault onboarding (public."DxFeedAccount"). */

export interface DxFeedLink {
  orderNumber: string;
  userId: string | null;
  email: string;
  /** From onboarding form — used in Make.com email greeting. */
  firstName: string | null;
  lastName: string | null;
  dxUserId: string;
  dxAccountId: string | null;
  dxSubscriptionId: string | null;
  accountStatus: number | null;
  subscriptionStatus: number | null;
  agreementSigned: boolean;
  agreementLink: string | null;
  platform: number | null;
  /** Deepchart / ATAS / Quantower login (from NewUser). */
  platformUsername: string | null;
  platformPassword: string | null;
  /** Volumetrica Platforms license key (SubscriptionViewModel.volumetricaLicense). */
  platformLicense: string | null;
  downloadLink: string | null;
  loginUrl: string | null;
  credentialsEmailedAt: string | null;
}

export type DxFeedLinkInput = DxFeedLink;

const COLS =
  `"orderNumber","userId","email","firstName","lastName","dxUserId","dxAccountId","dxSubscriptionId","accountStatus","subscriptionStatus","agreementSigned","agreementLink","platform","platformUsername","platformPassword","platformLicense","downloadLink","loginUrl","credentialsEmailedAt"`;

const memory = new Map<string, DxFeedLink>();

function mapRow(r: Record<string, unknown>): DxFeedLink {
  return {
    orderNumber: String(r.orderNumber),
    userId: (r.userId as string | null) ?? null,
    email: String(r.email),
    firstName: (r.firstName as string | null) ?? null,
    lastName: (r.lastName as string | null) ?? null,
    dxUserId: String(r.dxUserId),
    dxAccountId: (r.dxAccountId as string | null) ?? null,
    dxSubscriptionId: (r.dxSubscriptionId as string | null) ?? null,
    accountStatus: r.accountStatus == null ? null : Number(r.accountStatus),
    subscriptionStatus: r.subscriptionStatus == null ? null : Number(r.subscriptionStatus),
    agreementSigned: r.agreementSigned === true,
    agreementLink: (r.agreementLink as string | null) ?? null,
    platform: r.platform == null ? null : Number(r.platform),
    platformUsername: (r.platformUsername as string | null) ?? null,
    platformPassword: (r.platformPassword as string | null) ?? null,
    platformLicense: (r.platformLicense as string | null) ?? null,
    downloadLink: (r.downloadLink as string | null) ?? null,
    loginUrl: (r.loginUrl as string | null) ?? null,
    credentialsEmailedAt: r.credentialsEmailedAt
      ? new Date(r.credentialsEmailedAt as string).toISOString()
      : null,
  };
}

function emptyExtras(): Pick<
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

export async function getDxFeedLinkByOrder(orderNumber: string): Promise<DxFeedLink | null> {
  if (!useDatabase) return memory.get(orderNumber) ?? null;
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "DxFeedAccount" WHERE "orderNumber" = $1`,
    [orderNumber],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getDxFeedLinksByEmail(email: string): Promise<DxFeedLink[]> {
  const normalized = email.trim().toLowerCase();
  if (!useDatabase) {
    return [...memory.values()].filter((l) => l.email.toLowerCase() === normalized);
  }
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "DxFeedAccount" WHERE lower("email") = lower($1) ORDER BY "updatedAt" DESC`,
    [normalized],
  );
  return rows.map((r) => mapRow(r));
}

export async function deleteDxFeedLinkByOrder(orderNumber: string): Promise<void> {
  if (!useDatabase) {
    memory.delete(orderNumber);
    return;
  }
  await getPool().query(`DELETE FROM "DxFeedAccount" WHERE "orderNumber" = $1`, [orderNumber]);
}

export async function deleteDxFeedLinksByEmail(email: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!useDatabase) {
    for (const [k, v] of memory) {
      if (v.email.toLowerCase() === normalized) memory.delete(k);
    }
    return;
  }
  await getPool().query(`DELETE FROM "DxFeedAccount" WHERE lower("email") = lower($1)`, [normalized]);
}

export async function getLinkByDxUserId(dxUserId: string): Promise<DxFeedLink | null> {
  if (!useDatabase) {
    for (const link of memory.values()) {
      if (link.dxUserId === dxUserId) return link;
    }
    return null;
  }
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "DxFeedAccount" WHERE "dxUserId" = $1`,
    [dxUserId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getLinkBySubscriptionId(dxSubscriptionId: string): Promise<DxFeedLink | null> {
  if (!useDatabase) {
    for (const link of memory.values()) {
      if (link.dxSubscriptionId === dxSubscriptionId) return link;
    }
    return null;
  }
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "DxFeedAccount" WHERE "dxSubscriptionId" = $1`,
    [dxSubscriptionId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function getLinkByAccountId(dxAccountId: string): Promise<DxFeedLink | null> {
  if (!useDatabase) {
    for (const link of memory.values()) {
      if (link.dxAccountId === dxAccountId) return link;
    }
    return null;
  }
  const { rows } = await getPool().query(
    `SELECT ${COLS} FROM "DxFeedAccount" WHERE "dxAccountId" = $1`,
    [dxAccountId],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function upsertDxFeedLink(link: DxFeedLinkInput): Promise<void> {
  const row: DxFeedLink = {
    ...emptyExtras(),
    ...link,
  };
  if (!useDatabase) {
    memory.set(row.orderNumber, { ...row });
    return;
  }
  await getPool().query(
    `INSERT INTO "DxFeedAccount"
       ("orderNumber","userId","email","firstName","lastName","dxUserId","dxAccountId","dxSubscriptionId",
        "accountStatus","subscriptionStatus","agreementSigned","agreementLink","platform",
        "platformUsername","platformPassword","platformLicense","downloadLink","loginUrl","credentialsEmailedAt","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,now())
     ON CONFLICT ("orderNumber") DO UPDATE SET
       "userId" = COALESCE(EXCLUDED."userId", "DxFeedAccount"."userId"),
       "email" = EXCLUDED."email",
       "firstName" = COALESCE(EXCLUDED."firstName", "DxFeedAccount"."firstName"),
       "lastName" = COALESCE(EXCLUDED."lastName", "DxFeedAccount"."lastName"),
       "dxUserId" = EXCLUDED."dxUserId",
       "dxAccountId" = EXCLUDED."dxAccountId",
       "dxSubscriptionId" = EXCLUDED."dxSubscriptionId",
       "accountStatus" = EXCLUDED."accountStatus",
       "subscriptionStatus" = EXCLUDED."subscriptionStatus",
       "agreementSigned" = EXCLUDED."agreementSigned",
       "agreementLink" = EXCLUDED."agreementLink",
       "platform" = EXCLUDED."platform",
       "platformUsername" = COALESCE(EXCLUDED."platformUsername", "DxFeedAccount"."platformUsername"),
       "platformPassword" = COALESCE(EXCLUDED."platformPassword", "DxFeedAccount"."platformPassword"),
       "platformLicense" = COALESCE(EXCLUDED."platformLicense", "DxFeedAccount"."platformLicense"),
       "downloadLink" = COALESCE(EXCLUDED."downloadLink", "DxFeedAccount"."downloadLink"),
       "loginUrl" = COALESCE(EXCLUDED."loginUrl", "DxFeedAccount"."loginUrl"),
       "credentialsEmailedAt" = COALESCE(EXCLUDED."credentialsEmailedAt", "DxFeedAccount"."credentialsEmailedAt"),
       "updatedAt" = now()`,
    [
      row.orderNumber, row.userId, row.email, row.firstName, row.lastName,
      row.dxUserId, row.dxAccountId, row.dxSubscriptionId, row.accountStatus, row.subscriptionStatus,
      row.agreementSigned, row.agreementLink, row.platform,
      row.platformUsername, row.platformPassword, row.platformLicense,
      row.downloadLink, row.loginUrl, row.credentialsEmailedAt,
    ],
  );
}

export async function attachDxFeedUserId(orderNumber: string, userId: string): Promise<void> {
  if (!useDatabase) {
    const existing = memory.get(orderNumber);
    if (existing) memory.set(orderNumber, { ...existing, userId });
    return;
  }
  await getPool().query(
    `UPDATE "DxFeedAccount" SET "userId" = $2, "updatedAt" = now() WHERE "orderNumber" = $1`,
    [orderNumber, userId],
  );
}

export async function markCredentialsEmailed(orderNumber: string): Promise<void> {
  const at = new Date().toISOString();
  if (!useDatabase) {
    const existing = memory.get(orderNumber);
    if (existing) memory.set(orderNumber, { ...existing, credentialsEmailedAt: at });
    return;
  }
  await getPool().query(
    `UPDATE "DxFeedAccount" SET "credentialsEmailedAt" = now(), "updatedAt" = now()
     WHERE "orderNumber" = $1`,
    [orderNumber],
  );
}
