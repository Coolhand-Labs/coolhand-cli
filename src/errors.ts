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
  | 'ACCOUNT_NOT_FOUND';

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
