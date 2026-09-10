import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { useDatabase } from "../config.js";
import type { Purchase, PurchaseStore, RecordPurchaseInput, PurchaseStatus } from "./types.js";

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeOrder(orderNumber: string): string {
  return orderNumber.trim();
}

function normalizeIp(ip: string | null | undefined): string | null {
  const v = ip?.trim();
  return v ? v : null;
}

/** In-memory store used when DATABASE_URL is unset (local / mock). */
class MemoryPurchaseStore implements PurchaseStore {
  private readonly byOrder = new Map<string, Purchase>();

  async record(input: RecordPurchaseInput): Promise<Purchase> {
    const orderNumber = normalizeOrder(input.orderNumber);
    const existing = this.byOrder.get(orderNumber);
    if (existing) {
      // Fill in IP if a later webhook/onboarding provides one.
      if (!existing.ip && normalizeIp(input.ip)) {
        const updated = { ...existing, ip: normalizeIp(input.ip) };
        this.byOrder.set(orderNumber, updated);
        return updated;
      }
      return existing;
    }

    const purchase: Purchase = {
      id: randomUUID(),
      orderNumber,
      email: normalizeEmail(input.email),
      status: "PAID",
      productName: input.productName?.trim() || null,
      ip: normalizeIp(input.ip),
      rawPayload: input.rawPayload ?? null,
      userId: null,
      createdAt: new Date().toISOString(),
      redeemedAt: null,
    };
    this.byOrder.set(orderNumber, purchase);
    return purchase;
  }

  async findByOrderNumber(orderNumber: string): Promise<Purchase | null> {
    return this.byOrder.get(normalizeOrder(orderNumber)) ?? null;
  }

  async findByUserId(userId: string): Promise<Purchase | null> {
    for (const p of this.byOrder.values()) {
      if (p.userId === userId) return p;
    }
    return null;
  }

  async redeem(orderNumber: string, email: string, userId: string, ip?: string | null): Promise<Purchase | null> {
    const purchase = this.byOrder.get(normalizeOrder(orderNumber));
    if (!purchase) return null;
    if (purchase.status !== "PAID") return null;
    if (purchase.email !== normalizeEmail(email)) return null;

    const redeemed: Purchase = {
      ...purchase,
      status: "REDEEMED",
      userId,
      ip: normalizeIp(ip) ?? purchase.ip,
      redeemedAt: new Date().toISOString(),
    };
    this.byOrder.set(purchase.orderNumber, redeemed);
    return redeemed;
  }

  async deleteByUserId(userId: string): Promise<number> {
    let n = 0;
    for (const [key, p] of this.byOrder) {
      if (p.userId === userId) {
        this.byOrder.delete(key);
        n++;
      }
    }
    return n;
  }
}

/** Postgres-backed store — source of truth in production. */
class PgPurchaseStore implements PurchaseStore {
  async record(input: RecordPurchaseInput): Promise<Purchase> {
    const pool = getPool();
    const orderNumber = normalizeOrder(input.orderNumber);
    const email = normalizeEmail(input.email);
    const productName = input.productName?.trim() || null;
    const ip = normalizeIp(input.ip);
    const raw = JSON.stringify(input.rawPayload ?? null);

    const existing = await pool.query(
      `SELECT * FROM "Purchase" WHERE "orderNumber" = $1 LIMIT 1`,
      [orderNumber],
    );
    if (existing.rows[0]) {
      const row = mapRow(existing.rows[0]);
      if (!row.ip && ip) {
        const updated = await pool.query(
          `UPDATE "Purchase" SET "ip" = $2, "updatedAt" = now() WHERE "orderNumber" = $1 RETURNING *`,
          [orderNumber, ip],
        );
        return mapRow(updated.rows[0]);
      }
      return row;
    }

    const inserted = await pool.query(
      `INSERT INTO "Purchase" ("id","orderNumber","email","status","productName","ip","rawPayload")
       VALUES ($1,$2,$3,'PAID',$4,$5,$6::jsonb)
       RETURNING *`,
      [randomUUID(), orderNumber, email, productName, ip, raw],
    );
    return mapRow(inserted.rows[0]);
  }

  async findByOrderNumber(orderNumber: string): Promise<Purchase | null> {
    const pool = getPool();
    const result = await pool.query(`SELECT * FROM "Purchase" WHERE "orderNumber" = $1 LIMIT 1`, [
      normalizeOrder(orderNumber),
    ]);
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async findByUserId(userId: string): Promise<Purchase | null> {
    const pool = getPool();
    const result = await pool.query(
      `SELECT * FROM "Purchase" WHERE "userId" = $1 ORDER BY "redeemedAt" DESC NULLS LAST LIMIT 1`,
      [userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async redeem(orderNumber: string, email: string, userId: string, ip?: string | null): Promise<Purchase | null> {
    const pool = getPool();
    const nextIp = normalizeIp(ip);
    const result = await pool.query(
      `UPDATE "Purchase"
       SET "status" = 'REDEEMED',
           "userId" = $3,
           "ip" = COALESCE($4, "ip"),
           "redeemedAt" = now(),
           "updatedAt" = now()
       WHERE "orderNumber" = $1
         AND lower("email") = lower($2)
         AND "status" = 'PAID'
       RETURNING *`,
      [normalizeOrder(orderNumber), normalizeEmail(email), userId, nextIp],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async deleteByUserId(userId: string): Promise<number> {
    const pool = getPool();
    const result = await pool.query(`DELETE FROM "Purchase" WHERE "userId" = $1`, [userId]);
    return result.rowCount ?? 0;
  }
}

function mapRow(row: Record<string, unknown>): Purchase {
  return {
    id: String(row.id),
    orderNumber: String(row.orderNumber),
    email: String(row.email),
    status: row.status as PurchaseStatus,
    productName: row.productName == null ? null : String(row.productName),
    ip: row.ip == null ? null : String(row.ip),
    rawPayload: row.rawPayload ?? null,
    userId: row.userId == null ? null : String(row.userId),
    createdAt: new Date(String(row.createdAt)).toISOString(),
    redeemedAt: row.redeemedAt == null ? null : new Date(String(row.redeemedAt)).toISOString(),
  };
}

let store: PurchaseStore | null = null;

export function getPurchaseStore(): PurchaseStore {
  if (!store) store = useDatabase ? new PgPurchaseStore() : new MemoryPurchaseStore();
  return store;
}
