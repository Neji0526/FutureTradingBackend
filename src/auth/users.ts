import { hashPassword } from "./password.js";
import type { Role } from "./jwt.js";

export type UserStatus = "ACTIVE" | "PENDING" | "SUSPENDED";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: Role;
  status: UserStatus;
  /** Set while a session is active; second login is rejected until logout. */
  activeSessionIp: string | null;
  /** Bumped on login / logout / deactivate so old JWTs stop working. */
  sessionVersion: number;
}

/** Public-facing user (never expose the password hash). */
export type PublicUser = Omit<User, "passwordHash">;

export function toPublicUser(u: User): PublicUser {
  const { passwordHash: _omit, ...rest } = u;
  void _omit;
  return rest;
}

/**
 * Storage for users. Implemented in-memory below; swap for a PrismaUserStore
 * (Postgres, per the schema) once DATABASE_URL is provisioned — the AuthService
 * depends only on this interface.
 */
export interface UserStore {
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  create(input: { email: string; password: string; name: string; role?: Role }): Promise<User>;
  /** Set a new password (plaintext; hashed by the store). Returns false if the user is unknown. */
  updatePassword(id: string, newPassword: string): Promise<boolean>;
  /**
   * Open a session: set activeSessionIp and bump sessionVersion.
   * Returns the new sessionVersion, or null if the user is missing.
   */
  openSession(id: string, marker: string): Promise<number | null>;
  /** Clear activeSessionIp and bump sessionVersion (logout / kick). */
  clearSession(id: string): Promise<boolean>;
  /** Suspend + wipe session fields (subscription deactivation). */
  deactivateUser(id: string): Promise<boolean>;
}

/** Seeded in-memory store (demo users). Mirrors the frontend demo accounts. */
export class MemoryUserStore implements UserStore {
  private byId = new Map<string, User>();
  private byEmail = new Map<string, User>();
  private seq = 1;

  constructor() {
    this.seed("Alex Admin", "admin@demo.com", "demo", "ADMIN");
    this.seed("Marvin Weiss", "trader@demo.com", "demo", "TRADER");
  }

  private seed(name: string, email: string, password: string, role: Role) {
    const user: User = {
      id: `u_${this.seq++}`,
      email: email.toLowerCase(),
      passwordHash: hashPassword(password),
      name,
      role,
      status: "ACTIVE",
      activeSessionIp: null,
      sessionVersion: 0,
    };
    this.byId.set(user.id, user);
    this.byEmail.set(user.email, user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.byEmail.get(email.toLowerCase()) ?? null;
  }

  async findById(id: string): Promise<User | null> {
    return this.byId.get(id) ?? null;
  }

  async create(input: { email: string; password: string; name: string; role?: Role }): Promise<User> {
    const email = input.email.toLowerCase();
    if (this.byEmail.has(email)) throw new Error("email already registered");
    const user: User = {
      id: `u_${this.seq++}`,
      email,
      passwordHash: hashPassword(input.password),
      name: input.name,
      role: input.role ?? "TRADER",
      status: "ACTIVE",
      activeSessionIp: null,
      sessionVersion: 0,
    };
    this.byId.set(user.id, user);
    this.byEmail.set(user.email, user);
    return user;
  }

  async updatePassword(id: string, newPassword: string): Promise<boolean> {
    const user = this.byId.get(id);
    if (!user) return false;
    user.passwordHash = hashPassword(newPassword);
    return true;
  }

  async openSession(id: string, marker: string): Promise<number | null> {
    const user = this.byId.get(id);
    if (!user) return null;
    user.activeSessionIp = marker;
    user.sessionVersion += 1;
    return user.sessionVersion;
  }

  async clearSession(id: string): Promise<boolean> {
    const user = this.byId.get(id);
    if (!user) return false;
    user.activeSessionIp = null;
    user.sessionVersion += 1;
    return true;
  }

  async deactivateUser(id: string): Promise<boolean> {
    const user = this.byId.get(id);
    if (!user || user.role !== "TRADER") return false;
    user.status = "SUSPENDED";
    user.activeSessionIp = null;
    user.sessionVersion += 1;
    return true;
  }
}
