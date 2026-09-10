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

/** In-memory store used when DATABASE_URL is unset (local / mock). */
class MemoryPurchaseStore implements PurchaseStore {
  private readonly byOrder = new Map<string, Purchase>();

  async record(input: RecordPurchaseInput): Promise<Purchase> {
    const orderNumber = normalizeOrder(input.orderNumber);
    const existing = this.byOrder.get(orderNumber);
    if (existing) return existing;

    const purchase: Purchase = {
      id: randomUUID(),
      orderNumber,
      email: normalizeEmail(input.email),
      status: "PAID",
      productName: input.productName?.trim() || null,
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

  async redeem(orderNumber: string, email: string, userId: string): Promise<Purchase | null> {
    const purchase = this.byOrder.get(normalizeOrder(orderNumber));
    if (!purchase) return null;
    if (purchase.status !== "PAID") return null;
    if (purchase.email !== normalizeEmail(email)) return null;

    const redeemed: Purchase = {
      ...purchase,
      status: "REDEEMED",
      userId,
      redeemedAt: new Date().toISOString(),
    };
    this.byOrder.set(purchase.orderNumber, redeemed);
    return redeemed;
  }
}

/** Postgres-backed store — source of truth in production. */
class PgPurchaseStore implements PurchaseStore {
  async record(input: RecordPurchaseInput): Promise<Purchase> {
    const pool = getPool();
    const orderNumber = normalizeOrder(input.orderNumber);
    const email = normalizeEmail(input.email);
    const productName = input.productName?.trim() || null;
    const raw = JSON.stringify(input.rawPayload ?? null);

    const existing = await pool.query(
      `SELECT * FROM "Purchase" WHERE "orderNumber" = $1 LIMIT 1`,
      [orderNumber],
    );
    if (existing.rows[0]) return mapRow(existing.rows[0]);

    const inserted = await pool.query(
      `INSERT INTO "Purchase" ("id","orderNumber","email","status","productName","rawPayload")
       VALUES ($1,$2,$3,'PAID',$4,$5::jsonb)
       RETURNING *`,
      [randomUUID(), orderNumber, email, productName, raw],
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

  async redeem(orderNumber: string, email: string, userId: string): Promise<Purchase | null> {
    const pool = getPool();
    const result = await pool.query(
      `UPDATE "Purchase"
       SET "status" = 'REDEEMED',
           "userId" = $3,
           "redeemedAt" = now(),
           "updatedAt" = now()
       WHERE "orderNumber" = $1
         AND lower("email") = lower($2)
         AND "status" = 'PAID'
       RETURNING *`,
      [normalizeOrder(orderNumber), normalizeEmail(email), userId],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }
}

function mapRow(row: Record<string, unknown>): Purchase {
  return {
    id: String(row.id),
    orderNumber: String(row.orderNumber),
    email: String(row.email),
    status: row.status as PurchaseStatus,
    productName: row.productName == null ? null : String(row.productName),
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
