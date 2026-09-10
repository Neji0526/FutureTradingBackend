import { randomUUID } from "node:crypto";
import { getPool } from "../db/pool.js";
import { useDatabase } from "../config.js";

/** Profile collected during purchase-gated registration / onboarding. */
export interface OnboardingProfile {
  id: string;
  userId: string;
  orderNumber: string;
  ageRange: string;
  country: string;
  acceptTerms: boolean;
  acceptRisk: boolean;
  idType: string;
  addressType: string;
  idFileName: string;
  idFilePath: string;
  idMimeType: string;
  idSize: number;
  addressFileName: string;
  addressFilePath: string;
  addressMimeType: string;
  addressSize: number;
  createdAt: string;
}

export type SaveOnboardingProfileInput = Omit<OnboardingProfile, "id" | "createdAt">;

export interface OnboardingProfileStore {
  save(input: SaveOnboardingProfileInput): Promise<OnboardingProfile>;
}

class MemoryOnboardingStore implements OnboardingProfileStore {
  private readonly byUser = new Map<string, OnboardingProfile>();

  async save(input: SaveOnboardingProfileInput): Promise<OnboardingProfile> {
    const profile: OnboardingProfile = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.byUser.set(input.userId, profile);
    return profile;
  }
}

class PgOnboardingStore implements OnboardingProfileStore {
  async save(input: SaveOnboardingProfileInput): Promise<OnboardingProfile> {
    const pool = getPool();
    const id = randomUUID();
    const result = await pool.query(
      `INSERT INTO "OnboardingProfile" (
         "id","userId","orderNumber","ageRange","country",
         "acceptTerms","acceptRisk","idType","addressType",
         "idFileName","idFilePath","idMimeType","idSize",
         "addressFileName","addressFilePath","addressMimeType","addressSize"
       ) VALUES (
         $1,$2,$3,$4,$5,
         $6,$7,$8,$9,
         $10,$11,$12,$13,
         $14,$15,$16,$17
       )
       ON CONFLICT ("userId") DO UPDATE SET
         "orderNumber" = EXCLUDED."orderNumber",
         "ageRange" = EXCLUDED."ageRange",
         "country" = EXCLUDED."country",
         "acceptTerms" = EXCLUDED."acceptTerms",
         "acceptRisk" = EXCLUDED."acceptRisk",
         "idType" = EXCLUDED."idType",
         "addressType" = EXCLUDED."addressType",
         "idFileName" = EXCLUDED."idFileName",
         "idFilePath" = EXCLUDED."idFilePath",
         "idMimeType" = EXCLUDED."idMimeType",
         "idSize" = EXCLUDED."idSize",
         "addressFileName" = EXCLUDED."addressFileName",
         "addressFilePath" = EXCLUDED."addressFilePath",
         "addressMimeType" = EXCLUDED."addressMimeType",
         "addressSize" = EXCLUDED."addressSize"
       RETURNING *`,
      [
        id,
        input.userId,
        input.orderNumber,
        input.ageRange,
        input.country,
        input.acceptTerms,
        input.acceptRisk,
        input.idType,
        input.addressType,
        input.idFileName,
        input.idFilePath,
        input.idMimeType,
        input.idSize,
        input.addressFileName,
        input.addressFilePath,
        input.addressMimeType,
        input.addressSize,
      ],
    );
    return mapRow(result.rows[0]);
  }
}

function mapRow(row: Record<string, unknown>): OnboardingProfile {
  return {
    id: String(row.id),
    userId: String(row.userId),
    orderNumber: String(row.orderNumber),
    ageRange: String(row.ageRange),
    country: String(row.country),
    acceptTerms: Boolean(row.acceptTerms),
    acceptRisk: Boolean(row.acceptRisk),
    idType: String(row.idType),
    addressType: String(row.addressType),
    idFileName: String(row.idFileName),
    idFilePath: String(row.idFilePath),
    idMimeType: String(row.idMimeType),
    idSize: Number(row.idSize),
    addressFileName: String(row.addressFileName),
    addressFilePath: String(row.addressFilePath),
    addressMimeType: String(row.addressMimeType),
    addressSize: Number(row.addressSize),
    createdAt: new Date(String(row.createdAt)).toISOString(),
  };
}

let store: OnboardingProfileStore | null = null;

export function getOnboardingProfileStore(): OnboardingProfileStore {
  if (!store) store = useDatabase ? new PgOnboardingStore() : new MemoryOnboardingStore();
  return store;
}
