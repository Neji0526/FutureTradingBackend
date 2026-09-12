import { useDatabase } from "../config.js";
import { getPool } from "../db/pool.js";

/** Purchase-keyed dxFeed link for Vault onboarding (public."DxFeedAccount"). */

export interface DxFeedLink {
  orderNumber: string;
  userId: string | null;
  email: string;
  dxUserId: string;
  dxAccountId: string | null;
  dxSubscriptionId: string | null;
  accountStatus: number | null;
  subscriptionStatus: number | null;
  agreementSigned: boolean;
  agreementLink: string | null;
  platform: number | null;
}

export type DxFeedLinkInput = DxFeedLink;

const COLS =
  `"orderNumber","userId","email","dxUserId","dxAccountId","dxSubscriptionId","accountStatus","subscriptionStatus","agreementSigned","agreementLink","platform"`;

const memory = new Map<string, DxFeedLink>();

function mapRow(r: Record<string, unknown>): DxFeedLink {
  return {
    orderNumber: String(r.orderNumber),
    userId: (r.userId as string | null) ?? null,
    email: String(r.email),
    dxUserId: String(r.dxUserId),
    dxAccountId: (r.dxAccountId as string | null) ?? null,
    dxSubscriptionId: (r.dxSubscriptionId as string | null) ?? null,
    accountStatus: r.accountStatus == null ? null : Number(r.accountStatus),
    subscriptionStatus: r.subscriptionStatus == null ? null : Number(r.subscriptionStatus),
    agreementSigned: r.agreementSigned === true,
    agreementLink: (r.agreementLink as string | null) ?? null,
    platform: r.platform == null ? null : Number(r.platform),
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
  if (!useDatabase) {
    memory.set(link.orderNumber, { ...link });
    return;
  }
  await getPool().query(
    `INSERT INTO "DxFeedAccount"
       ("orderNumber","userId","email","dxUserId","dxAccountId","dxSubscriptionId",
        "accountStatus","subscriptionStatus","agreementSigned","agreementLink","platform","updatedAt")
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
     ON CONFLICT ("orderNumber") DO UPDATE SET
       "userId" = COALESCE(EXCLUDED."userId", "DxFeedAccount"."userId"),
       "email" = EXCLUDED."email",
       "dxUserId" = EXCLUDED."dxUserId",
       "dxAccountId" = EXCLUDED."dxAccountId",
       "dxSubscriptionId" = EXCLUDED."dxSubscriptionId",
       "accountStatus" = EXCLUDED."accountStatus",
       "subscriptionStatus" = EXCLUDED."subscriptionStatus",
       "agreementSigned" = EXCLUDED."agreementSigned",
       "agreementLink" = EXCLUDED."agreementLink",
       "platform" = EXCLUDED."platform",
       "updatedAt" = now()`,
    [
      link.orderNumber, link.userId, link.email, link.dxUserId, link.dxAccountId,
      link.dxSubscriptionId, link.accountStatus, link.subscriptionStatus,
      link.agreementSigned, link.agreementLink, link.platform,
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
