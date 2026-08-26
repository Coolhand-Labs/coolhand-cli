export enum ExitCode {
  OK = 0,
  USER_ERROR = 1,
  INTERNAL = 2,
  ABORTED = 130,
}

export type ErrorCode =
  | 'TIMEOUT'
  | 'STATE_MISMATCH'
  | 'INVALID_CALLBACK'
  | 'BROWSER_FAILED'
  | 'CONFIG_WRITE_FAILED'
  | 'CONFIG_READ_FAILED'
  | 'NOT_CONFIGURED'
  | 'INVALID_REDIRECT_URI'
  | 'INVALID_BASE_URL'
  | 'INVALID_ARGS'
  | 'WRITE_ENV_FAILED'
  | 'CLIENT_NOT_FOUND'
  | 'NO_PRIVATE_KEY'
  | 'MCP_ERROR'
  | 'INGEST_ERROR'
  | 'FEEDBACK_ERROR'
  | 'LOG_ERROR'
  | 'TEMPLATE_ERROR'
  | 'CERT_FILE_INSECURE'
  | 'UPLOAD_ERROR';

export class CliError extends Error {
  public readonly code: ErrorCode;
  public readonly exitCode: number;

  constructor(code: ErrorCode, message: string, exitCode: number = ExitCode.USER_ERROR) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
  }
}
