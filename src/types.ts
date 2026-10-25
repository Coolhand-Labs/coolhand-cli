import type { HookAgent } from './hooks/types.js';

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
  /** Exact match on `source_application`. */
  sourceApplication?: string;
  /** Exact match on `metadata.project_path`. */
  projectPath?: string;
  /** ISO8601, passed through untouched — the server validates it. */
  since?: string;
  until?: string;
  /** USD floor on per-log cost. `0` is valid and must be sent. */
  minCost?: number;
  /** Server-validated; only `cost_desc` is documented. */
  order?: string;
  includePrompts?: boolean;
  includeTotal?: boolean;
  sort?: string;
  page?: number;
  perPage?: number;
  json?: boolean;
  clientId?: string;
}

export interface SearchTemplatesOptions {
  /** Literal, case-insensitive substring match on the template name. `%` and `_` are escaped
   *  server-side, so they match themselves and must not be escaped again here. */
  search?: string;
  workloadId?: string;
  status?: 'draft' | 'published' | 'failure';
  includeDeprecated?: boolean;
  /** Include the `Unmatched` / `Ignored API Calls` buckets, hidden by default. */
  includeSystem?: boolean;
  includeMetrics?: boolean;
  /** Metrics window: rolling days ending now. */
  daysBack?: number;
  /** ISO8601 metrics window bounds, passed through untouched — the server validates them. */
  since?: string;
  until?: string;
  page?: number;
  perPage?: number;
  json?: boolean;
  clientId?: string;
}

export interface SearchWorkloadsOptions {
  search?: string;
  includeArchived?: boolean;
  includeSystem?: boolean;
  includeTemplates?: boolean;
  includeMetrics?: boolean;
  daysBack?: number;
  since?: string;
  until?: string;
  page?: number;
  perPage?: number;
  json?: boolean;
  clientId?: string;
}

export interface GetTemplateOptions {
  id: string;
  /** `--no-metrics`: send `includeMetrics: false` (the server includes metrics by default). */
  noMetrics?: boolean;
  daysBack?: number;
  since?: string;
  until?: string;
  json?: boolean;
  clientId?: string;
}

/** Options shared by every help center read. They work with no stored client. */
export interface HelpCenterReadOptions {
  json?: boolean;
  clientId?: string;
  /** Overrides the stored client's server. The stored key is only sent when this matches it. */
  baseUrl?: string;
}

export interface SearchHelpArticlesOptions extends HelpCenterReadOptions {
  query?: string;
  category?: string;
  page?: number;
  perPage?: number;
}

export interface GetHelpArticleOptions extends HelpCenterReadOptions {
  slug: string;
}

export type ListHelpCategoriesOptions = HelpCenterReadOptions;

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

export interface UploadClientFileOptions {
  /** Local path of the file to upload (positional arg). */
  filePath: string;
  clientId?: string;
  json?: boolean;
  /** Size and validate the file without uploading. */
  dryRun?: boolean;
  /** Display name for the client file; defaults to the file's basename. */
  name?: string;
  fileType?: 'slide_deck' | 'report' | 'document';
  description?: string;
}

export type ClientFileStatusOption = 'draft' | 'published' | 'archived';

export interface ListClientFilesOptions {
  status?: ClientFileStatusOption;
  fileType?: 'slide_deck' | 'report' | 'document';
  page?: number;
  perPage?: number;
  json?: boolean;
  clientId?: string;
}

export interface DownloadClientFileOptions {
  id: string;
  /** Destination path (a directory keeps the server-provided filename); defaults to that filename in the cwd. */
  output?: string;
  /** Overwrite an existing destination file. */
  force?: boolean;
  json?: boolean;
  clientId?: string;
}

export interface UpdateClientFileOptions {
  id: string;
  status: ClientFileStatusOption;
  json?: boolean;
  clientId?: string;
}

export interface MapClaudeProjectsOptions {
  clientId?: string;
  json?: boolean;
  /** Build and size the map without uploading. */
  dryRun?: boolean;
  /** Override for the search root (--root); defaults to the home directory. */
  root?: string;
  /** Also write the generated markdown report to this local path, for inspection. */
  output?: string;
  /** Skip the confirmation prompt when --output already exists. */
  force?: boolean;
}

export interface SyncSkillsOptions {
  clientId?: string;
  json?: boolean;
  /** Scan, dedupe, and report counts without uploading or touching skills-state.json. */
  dryRun?: boolean;
  /** Search only this path (recursively) instead of the 3 default roots (--root). */
  root?: string;
  /** Restrict the default scan to these sourceKinds: authored, installed, claude-code (--source, repeatable). */
  sources?: string[];
  /** Only upload skills whose name matches one of these (--skill, repeatable). */
  skills?: string[];
  /** Never upload skills whose name matches one of these (--exclude-skill, repeatable). */
  excludeSkills?: string[];
  /** Bypass the unchanged-content skip in skills-state.json; re-upload every matched skill. */
  force?: boolean;
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

export interface LinkFeedbackOptions {
  optimizationId: string;
  feedbackIds: string[];
  file?: string;
  note?: string;
  json?: boolean;
  clientId?: string;
}

export interface GetFeedbackOptions {
  id: string;
  json?: boolean;
  clientId?: string;
}

export interface SearchReferencedFilesOptions {
  filePathContains?: string;
  createdAtGteq?: string;
  createdAtLteq?: string;
  page?: number;
  perPage?: number;
  json?: boolean;
  clientId?: string;
}

export interface ListReferencedFileSessionsOptions {
  /** Exact file_path to look up. Required — checked in the CLI flag layer, not left to the
   *  server's 422, since this is a flag the CLI's own parser can validate before any request. */
  filePath: string;
  page?: number;
  perPage?: number;
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

export interface CaptureTurnOptions {
  agent: HookAgent;
  /** Name of the skill that enabled the hook; sent as metadata. */
  skill?: string;
  /** Public ingest key. Falls back to COOLHAND_API_KEY. */
  apiKey?: string;
  baseUrl?: string;
  /** Attribute turns to the anonymous machine id instead of the git email. */
  anonymous?: boolean;
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
