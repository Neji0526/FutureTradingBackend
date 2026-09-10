import { signToken, verifyToken, type Role } from "./jwt.js";
import { verifyPassword } from "./password.js";
import { ipsMatch, normalizeIp } from "./client-ip.js";
import { toPublicUser, type PublicUser, type UserStore } from "./users.js";
import { getPurchaseStore } from "../purchases/store.js";
import { useDatabase } from "../config.js";

export interface AuthResult {
  token: string;
  user: PublicUser;
}

export type LoginFailureReason =
  | "invalid_credentials"
  | "suspended"
  | "no_subscription"
  | "ip_mismatch"
  | "session_active";

export type LoginOutcome =
  | { ok: true; result: AuthResult }
  | { ok: false; reason: LoginFailureReason };

/** Authentication use-cases: login, token validation, registration. */
export class AuthService {
  constructor(private readonly users: UserStore) {}

  /**
   * Authenticate with email/password.
   * Traders are bound to the subscription IP and only one active session is allowed.
   */
  async login(email: string, password: string, clientIp?: string): Promise<LoginOutcome> {
    if (!email || !password) return { ok: false, reason: "invalid_credentials" };
    const user = await this.users.findByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      return { ok: false, reason: "invalid_credentials" };
    }
    if (user.status === "SUSPENDED") return { ok: false, reason: "suspended" };

    const ip = normalizeIp(clientIp);

    // Traders: require an active purchase (DB), bound-IP match, and no concurrent session.
    if (user.role === "TRADER") {
      const purchase = await getPurchaseStore().findByUserId(user.id);
      // Production traders are purchase-gated; in-memory demo traders have no purchase row.
      if (useDatabase) {
        if (!purchase || purchase.status !== "REDEEMED") {
          return { ok: false, reason: "no_subscription" };
        }
      } else if (purchase && purchase.status !== "REDEEMED") {
        return { ok: false, reason: "no_subscription" };
      }

      const bound = normalizeIp(user.boundIp ?? purchase?.ip ?? undefined);
      if (bound) {
        if (!ip || !ipsMatch(bound, ip)) {
          return { ok: false, reason: "ip_mismatch" };
        }
      }

      if (user.activeSessionIp) {
        return { ok: false, reason: "session_active" };
      }
    }

    const sessionIp = ip ?? "unknown";
    const sv = await this.users.openSession(user.id, sessionIp);
    if (sv == null) return { ok: false, reason: "invalid_credentials" };

    const fresh = await this.users.findById(user.id);
    if (!fresh) return { ok: false, reason: "invalid_credentials" };

    return {
      ok: true,
      result: {
        token: signToken(this.payload(fresh.id, fresh.email, fresh.role, sv)),
        user: toPublicUser(fresh),
      },
    };
  }

  /** Resolve the user for a valid bearer token (also enforces sessionVersion + status). */
  async me(token: string): Promise<PublicUser | null> {
    const payload = verifyToken(token);
    if (!payload) return null;
    const user = await this.users.findById(payload.sub);
    if (!user) return null;
    if (user.status === "SUSPENDED") return null;
    if ((payload.sv ?? 0) !== user.sessionVersion) return null;
    return toPublicUser(user);
  }

  /** Clear the active session lock so the user can sign in again. */
  async logout(token: string): Promise<boolean> {
    const payload = verifyToken(token);
    if (!payload) return false;
    return this.users.clearSession(payload.sub);
  }

  async register(input: { email: string; password: string; name: string; role?: Role }): Promise<AuthResult> {
    const user = await this.users.create(input);
    // Registration does not open a session — user must log in (which binds IP).
    return {
      token: signToken(this.payload(user.id, user.email, user.role, user.sessionVersion)),
      user: toPublicUser(user),
    };
  }

  /** Self-service password change: verify the current password, then set a new one. */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ ok: boolean; error?: string }> {
    const user = await this.users.findById(userId);
    if (!user) return { ok: false, error: "User not found." };
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      return { ok: false, error: "Current password is incorrect." };
    }
    await this.users.updatePassword(userId, newPassword);
    return { ok: true };
  }

  /** Admin override: set a user's password without knowing the current one. */
  async adminResetPassword(userId: string, newPassword: string): Promise<boolean> {
    return this.users.updatePassword(userId, newPassword);
  }

  private payload(sub: string, email: string, role: Role, sv: number) {
    return { sub, email, role, sv };
  }
}
