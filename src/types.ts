export interface AccountEntry {
  account_id: string;
  account_name: string;
  api_key: string;
  base_url: string;
  saved_at: string;
}

export interface ConfigFile {
  version: 1;
  default_account_id: string | null;
  accounts: Record<string, AccountEntry>;
}

export interface LoginOptions {
  baseUrl?: string;
  writeEnv?: string;
  json?: boolean;
  accountId?: string;
  timeoutMs?: number;
}

export interface LogoutOptions {
  accountId?: string;
  all?: boolean;
  json?: boolean;
}

export interface StatusOptions {
  accountId?: string;
  json?: boolean;
}

export interface WhoamiOptions {
  accountId?: string;
}

export interface AccountsOptions {
  json?: boolean;
}

export interface CallbackResult {
  token: string;
  accountName: string;
  accountId: string;
}

export interface StatusOutput {
  configured: boolean;
  accounts: Array<{
    account_id: string;
    account_name: string;
    masked_token: string;
    base_url: string;
  }>;
  default_account_id: string | null;
}

export const DEFAULT_BASE_URL = 'https://coolhandlabs.com';
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
