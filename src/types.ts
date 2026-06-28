export interface ClientEntry {
  client_id: string;
  client_name: string;
  api_key?: string;
  private_key?: string;
  base_url: string;
  saved_at: string;
}

export interface ConfigFile {
  version: 1;
  default_client_id: string | null;
  clients: Record<string, ClientEntry>;
}

export interface LoginOptions {
  baseUrl?: string;
  writeEnv?: string;
  json?: boolean;
  clientId?: string;
  timeoutMs?: number;
  scope?: 'private';
}

export interface LogoutOptions {
  clientId?: string;
  all?: boolean;
  json?: boolean;
}

export interface StatusOptions {
  clientId?: string;
  json?: boolean;
}

export interface WhoamiOptions {
  clientId?: string;
}

export interface ClientsOptions {
  json?: boolean;
}

export interface CallbackResult {
  token?: string;
  clientName: string;
  clientId: string;
  private_token?: string;
}

export interface StatusOutput {
  configured: boolean;
  clients: Array<{
    client_id: string;
    client_name: string;
    masked_token: string;
    base_url: string;
  }>;
  default_client_id: string | null;
}

export interface SearchOptimizationsOptions {
  status?: string;
  type?: string;
  category?: string;
  query?: string;
  from?: string;
  to?: string;
  page?: number;
  perPage?: number;
  templateId?: string;
  workloadId?: string;
  daysBack?: number;
  sortBy?: string;
  json?: boolean;
  clientId?: string;
}

export interface GetOptimizationOptions {
  id: string;
  json?: boolean;
  clientId?: string;
}

export interface CloseOptimizationOptions {
  id: string;
  reason: string;
  json?: boolean;
  clientId?: string;
}

export interface UpdateOptimizationOptions {
  id: string;
  title?: string;
  analysis?: string;
  plan?: string;
  json?: boolean;
  clientId?: string;
}

export interface AnalyzeClaudeSessionsOptions {
  dryRun?: boolean;
  clientId?: string;
  json?: boolean;
}

export interface ComplaintBoxOptions {
  complaint: string;
  agentName: string;
  thinking?: string;
  logId?: number;
  json?: boolean;
  clientId?: string;
}

export interface ClaudeOptions {
  // Arguments to forward verbatim to the Claude CLI.
  args: string[];
  clientId?: string;
}

export const DEFAULT_BASE_URL = 'https://coolhandlabs.com';
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
