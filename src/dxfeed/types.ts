/* Subset of Volumetrica Propfirm API types for onboarding data-agreement
 * provisioning. Aligned with SignalBackend (live Swagger). */

export const Platform = { VOLUMETRICA: 0, QUANTOWER: 1, ATAS: 2 } as const;
export type Platform = (typeof Platform)[keyof typeof Platform];

export const Currency = { EUR: 0, USD: 1 } as const;
export type Currency = (typeof Currency)[keyof typeof Currency];

export const EncryptionMode = { NONE: 0, AES256: 1 } as const;
export type EncryptionMode = (typeof EncryptionMode)[keyof typeof EncryptionMode];

export const UserType = { USER: 0, SYSTEM: 1 } as const;
export type UserType = (typeof UserType)[keyof typeof UserType];

export const SystemAccess = { READ_ONLY: 0, LIQUIDATION: 1, FULL_TRADING: 2 } as const;
export type SystemAccess = (typeof SystemAccess)[keyof typeof SystemAccess];

export const AccountStatus = {
  INITIALIZED: 0,
  ENABLED: 1,
  CHALLENGE_SUCCESS: 2,
  CHALLENGE_FAILED: 4,
  DISABLED: 8,
} as const;

export const AccountMode = {
  EVALUATION: 0,
  SIM_FUNDED: 1,
  FUNDED: 2,
  LIVE: 3,
  TRIAL: 4,
  CONTEST: 5,
  TRAINING: 100,
} as const;
export type AccountMode = (typeof AccountMode)[keyof typeof AccountMode];

export const IdReference = { APPLICATION: 0, ORGANIZATION: 1, ORGANIZATION_OWNER: 2 } as const;
export type IdReference = (typeof IdReference)[keyof typeof IdReference];

export const DataFeedProduct = {
  CME_L1: 0, CBOT_L1: 1, COMEX_L1: 2, NYMEX_L1: 3,
  CME_L2: 4, CBOT_L2: 5, COMEX_L2: 6, NYMEX_L2: 7,
  EUREX_L1: 8, EUREX_L2: 9,
} as const;
export type DataFeedProduct = (typeof DataFeedProduct)[keyof typeof DataFeedProduct];

export interface NewUserInput {
  firstName: string;
  lastName: string;
  email: string;
  country: string;
  username?: string;
  extEntityId?: string;
  encryptionMode?: EncryptionMode;
  userType?: UserType;
  systemAccess?: SystemAccess;
}

export interface NewTradingAccountInput {
  userId: string;
  balance: number;
  currency: Currency;
  accountRuleReference?: IdReference;
  accountRuleId?: string;
  enabled?: boolean;
  mode?: AccountMode;
  description?: string;
}

export interface NewSubscriptionInput {
  userId: string;
  dataFeedProducts: DataFeedProduct[];
  platform: Platform;
  enabled?: boolean;
  /** When true, Volumetrica re-opens market-data agreement onboarding for the user. */
  forceUserOnboarding?: boolean;
  /** Where dxFeed redirects the browser after the trader signs the agreement. */
  redirectUrl?: string;
}

export interface UserResult {
  userId: string;
  username: string | null;
  password: string | null;
  encryptionMode: EncryptionMode;
}

export interface NewTradingAccountResult {
  accountId: string;
  header: string | null;
  tradingRuleId: string | null;
}

export interface SubscriptionResult {
  subscriptionId: string | null;
  confirmationId: string | null;
  status: number;
  dxAgreementLink: string | null;
  dxAgreementSigned: boolean;
  platform: Platform;
  userId: string | null;
}
