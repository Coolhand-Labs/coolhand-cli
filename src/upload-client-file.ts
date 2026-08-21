import { promises as fs } from 'fs';
import * as path from 'path';
import { Coolhand, type CoolhandClientFileResponse } from 'coolhand-node';
import { CliError } from './errors.js';
import { loadConfig, resolveClientForDryRun } from './config.js';

/** Matches coolhand-node's own documented `uploadClientFile` guidance ("File contents, up to
 *  20MB") — checked client-side so an oversize file fails fast with an actionable message
 *  locally rather than hang on a slow upload only to be rejected server-side. */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_UPLOAD_MB = MAX_UPLOAD_BYTES / (1024 * 1024);

export interface UploadClientFilePayload {
  filePath: string;
  /** Display name for the client file; defaults to the file's basename. */
  name?: string;
  fileType?: 'slide_deck' | 'report' | 'document';
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface UploadClientFileResult {
  status: 'uploaded' | 'dry-run';
  sizeBytes: number;
  response: CoolhandClientFileResponse | null;
}

/**
 * Read a local file and upload it as a Coolhand client file via `Coolhand#uploadClientFile`
 * (public-key tier — same trust tier as log ingestion). Shared core used by both the
 * `upload-client-file` command and `map-claude-projects` (which uploads a generated markdown
 * report through the same path rather than duplicating auth/upload logic).
 *
 * Resolution mirrors `log-request.ts`: `resolveClientForDryRun` tolerates "no clients configured
 * at all" only when `opts.dryRun` is set, so `--dry-run` works fully logged-out.
 */
export async function uploadClientFile(
  payload: UploadClientFilePayload,
  opts: { clientId?: string; dryRun?: boolean } = {}
): Promise<UploadClientFileResult> {
  const cfg = await loadConfig();
  const entry = await resolveClientForDryRun(cfg, opts.clientId);

  if (!entry && !opts.dryRun) {
    throw new CliError('NOT_CONFIGURED', 'Not logged in. Run `coolhand login` to authenticate.');
  }
  if (entry && !entry.api_key) {
    throw new CliError(
      'NOT_CONFIGURED',
      'This client has no public API key — file upload requires the public key. Run `coolhand login` to re-authenticate.'
    );
  }

  let stat;
  try {
    stat = await fs.stat(payload.filePath);
  } catch (err) {
    throw new CliError('INVALID_ARGS', `Cannot read "${payload.filePath}": ${(err as Error).message}`);
  }
  if (!stat.isFile()) {
    throw new CliError('INVALID_ARGS', `"${payload.filePath}" is not a file.`);
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    const mb = (stat.size / (1024 * 1024)).toFixed(1);
    throw new CliError(
      'INVALID_ARGS',
      `"${payload.filePath}" is ${mb}MB, exceeding the ${MAX_UPLOAD_MB}MB client_files upload cap.`
    );
  }

  if (!entry) {
    // Dry run with no resolvable client — report the size but never attempt a network call.
    return { status: 'dry-run', sizeBytes: stat.size, response: null };
  }

  let coolhand: Coolhand;
  try {
    coolhand = new Coolhand({ apiKey: entry.api_key as string, baseUrl: entry.base_url, silent: true, dryRun: opts.dryRun });
  } catch (err) {
    throw new CliError('INVALID_BASE_URL', `Invalid base_url for client: ${entry.base_url} (${(err as Error).message})`);
  }

  const file = await fs.readFile(payload.filePath);
  const name = payload.name ?? path.basename(payload.filePath);
  const filename = path.basename(payload.filePath);

  const response = await coolhand.uploadClientFile({
    name,
    filename,
    file,
    ...(payload.fileType && { file_type: payload.fileType }),
    ...(payload.description && { description: payload.description }),
    ...(payload.metadata && { metadata: payload.metadata }),
  });

  if (opts.dryRun) {
    // The SDK's own dryRun option short-circuits uploadClientFile to null before any network
    // call — checked here (before the null-means-failure check below) so that expected result
    // is never misreported as a failed upload.
    return { status: 'dry-run', sizeBytes: stat.size, response: null };
  }
  if (response === null) {
    throw new CliError('UPLOAD_ERROR', `Upload of "${payload.filePath}" failed.`);
  }
  return { status: 'uploaded', sizeBytes: stat.size, response };
}
