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
  // Persisted enabled feature groups (issue #57); optional so older config files stay valid.
  feature_flags?: string[];
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
    masked_private_key: string;
    base_url: string;
  }>;
  default_client_id: string | null;
}

export interface ListWorkloadsOptions {
  search?: string;
  page?: number;
  perPage?: number;
  includeArchived?: boolean;
  includeSystem?: boolean;
  includeTemplates?: boolean;
  json?: boolean;
  clientId?: string;
}

export interface GetWorkloadOptions {
  id: string;
  json?: boolean;
  clientId?: string;
}

export interface UpdateWorkloadOptions {
  id: string;
  name?: string;
  description?: string;
  json?: boolean;
  clientId?: string;
}

export interface FetchLogOptions {
  logId: string;
  section?: 'full' | 'beginning' | 'end';
  maxChars?: number;
  searchQuery?: string;
  includeThinking?: boolean;
  json?: boolean;
  clientId?: string;
}

export interface SearchLogsOptions {
  templateId?: string;
  workloadId?: string;
  systemPromptContains?: string;
  userPromptContains?: string;
  model?: string;
  sourceApi?: string;
  sourceApiResult?: string;
  unmatchedOnly?: boolean;
  daysBack?: number;
  includePrompts?: boolean;
  sort?: string;
  page?: number;
  perPage?: number;
  json?: boolean;
  clientId?: string;
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
  full?: boolean;
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
  /** Raw --since value (date or Nh/Nd/Nw shorthand); parsed in the command so bad input
   *  surfaces as a CliError rather than a crash in the flag layer. */
  since?: string;
  /** Raw --until value, same formats as since. */
  until?: string;
  /** Override for the Claude Code scan root (--projects-dir). */
  projectsDir?: string;
  /** Only upload sessions whose project folder matches one of these (--project, repeatable). */
  projects?: string[];
  /** Never upload sessions whose project folder matches one of these (--exclude-project). */
  excludeProjects?: string[];
}

export interface SearchFeedbackOptions {
  sentiment?: 'positive' | 'negative' | 'neutral';
  search?: string;
  creatorId?: string;
  workloadId?: string;
  /** Only feedback linked to an LLM request log. Mutually exclusive with `unmatched`. */
  matched?: boolean;
  /** Only feedback not linked to an LLM request log. Mutually exclusive with `matched`. */
  unmatched?: boolean;
  since?: string;
  sortBy?: 'created_at' | 'updated_at';
  sortDir?: 'asc' | 'desc';
  page?: number;
  perPage?: number;
  json?: boolean;
  clientId?: string;
}

export interface GetFeedbackOptions {
  id: string;
  json?: boolean;
  clientId?: string;
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

export interface MonitorOptions {
  // The CLI to spawn behind the proxy.
  command: string;
  // Arguments to forward verbatim to that CLI.
  args: string[];
  clientId?: string;
}

export const DEFAULT_BASE_URL = 'https://coolhandlabs.com';
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
