import { getPool } from "../db/pool.js";
import { hashPassword } from "./password.js";
import type { Role } from "./jwt.js";
import type { User, UserStore } from "./users.js";

interface UserRow {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: Role;
  status: User["status"];
  boundIp: string | null;
  activeSessionIp: string | null;
  sessionVersion: number | string;
}

const COLS = `"id","email","passwordHash","name","role","status","boundIp","activeSessionIp","sessionVersion"`;

/** PostgreSQL-backed user store (pure-JS `pg`). Reads/writes the "User" table. */
export class PgUserStore implements UserStore {
  async findByEmail(email: string): Promise<User | null> {
    const { rows } = await getPool().query<UserRow>(
      `SELECT ${COLS} FROM "User" WHERE "email" = $1`,
      [email.toLowerCase()],
    );
    return rows[0] ? this.map(rows[0]) : null;
  }

  async findById(id: string): Promise<User | null> {
    const { rows } = await getPool().query<UserRow>(`SELECT ${COLS} FROM "User" WHERE "id" = $1`, [id]);
    return rows[0] ? this.map(rows[0]) : null;
  }

  async create(input: { email: string; password: string; name: string; role?: Role }): Promise<User> {
    try {
      const { rows } = await getPool().query<UserRow>(
        `INSERT INTO "User" ("email","passwordHash","name","role")
         VALUES ($1,$2,$3,$4)
         RETURNING ${COLS}`,
        [input.email.toLowerCase(), hashPassword(input.password), input.name, input.role ?? "TRADER"],
      );
      return this.map(rows[0]!);
    } catch (err) {
      // 23505 = unique_violation (email already exists)
      if ((err as { code?: string }).code === "23505") throw new Error("email already registered");
      throw err;
    }
  }

  async updatePassword(id: string, newPassword: string): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE "User" SET "passwordHash" = $1, "updatedAt" = now() WHERE "id" = $2`,
      [hashPassword(newPassword), id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async setBoundIp(id: string, ip: string | null): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE "User" SET "boundIp" = $2, "updatedAt" = now() WHERE "id" = $1`,
      [id, ip],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async openSession(id: string, ip: string): Promise<number | null> {
    const { rows } = await getPool().query<{ sessionVersion: number | string }>(
      `UPDATE "User"
       SET "activeSessionIp" = $2,
           "sessionVersion" = COALESCE("sessionVersion", 0) + 1,
           "updatedAt" = now()
       WHERE "id" = $1
       RETURNING "sessionVersion"`,
      [id, ip],
    );
    if (!rows[0]) return null;
    return Number(rows[0].sessionVersion);
  }

  async clearSession(id: string): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE "User"
       SET "activeSessionIp" = NULL,
           "sessionVersion" = COALESCE("sessionVersion", 0) + 1,
           "updatedAt" = now()
       WHERE "id" = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async deactivateUser(id: string): Promise<boolean> {
    const res = await getPool().query(
      `UPDATE "User"
       SET "status" = 'SUSPENDED',
           "boundIp" = NULL,
           "activeSessionIp" = NULL,
           "sessionVersion" = COALESCE("sessionVersion", 0) + 1,
           "updatedAt" = now()
       WHERE "id" = $1 AND "role" = 'TRADER'`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private map(r: UserRow): User {
    return {
      id: r.id,
      email: r.email,
      passwordHash: r.passwordHash,
      name: r.name ?? "",
      role: r.role,
      status: r.status,
      boundIp: r.boundIp ?? null,
      activeSessionIp: r.activeSessionIp ?? null,
      sessionVersion: Number(r.sessionVersion ?? 0),
    };
  }
}
