import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { AddressInfo } from 'net';
import { CliError } from '../errors.js';
import { safeEqual } from './state.js';
import { SUCCESS_HTML, errorHtml } from './success-page.js';
import type { CallbackResult } from '../types.js';

const LOOPBACK = '127.0.0.1';

export interface StartCallbackServerOptions {
  expectedState: string;
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface CallbackServerHandle {
  port: number;
  result: Promise<CallbackResult>;
  close(): Promise<void>;
}

export async function startCallbackServer(opts: StartCallbackServerOptions): Promise<CallbackServerHandle> {
  let resolveResult!: (value: CallbackResult) => void;
  let rejectResult!: (err: Error) => void;
  const result = new Promise<CallbackResult>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });

  let consumed = false;
  let timer: NodeJS.Timeout | undefined;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res);
  });

  function closeServerSoon(): void {
    setImmediate(() => {
      server.close();
    });
  }

  function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${LOOPBACK}`);

    if (req.method !== 'GET') {
      res.statusCode = 405;
      res.setHeader('Allow', 'GET');
      res.end();
      return;
    }

    if (url.pathname !== '/callback') {
      res.statusCode = 404;
      res.end();
      return;
    }

    if (consumed) {
      res.statusCode = 410;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(errorHtml('This callback has already been processed. You can close this tab.'));
      return;
    }

    const token = url.searchParams.get('token');
    const state = url.searchParams.get('state');
    const accountName = url.searchParams.get('account_name');
    const accountId = url.searchParams.get('account_id');

    if (!state || !safeEqual(state, opts.expectedState)) {
      consumed = true;
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(errorHtml('State parameter mismatch. This may be a forged or stale request.'));
      rejectResult(new CliError('STATE_MISMATCH', 'Callback state did not match the expected value.'));
      closeServerSoon();
      return;
    }

    if (!token || !accountId || !accountName) {
      consumed = true;
      res.statusCode = 400;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(errorHtml('Callback was missing required parameters.'));
      rejectResult(
        new CliError(
          'INVALID_CALLBACK',
          'Callback was missing token, account_id, or account_name. Make sure your Coolhand server is up to date.'
        )
      );
      closeServerSoon();
      return;
    }

    consumed = true;
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(SUCCESS_HTML);
    resolveResult({ token, accountName, accountId });
    closeServerSoon();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, LOOPBACK, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') {
    server.close();
    throw new CliError('INVALID_REDIRECT_URI', 'Could not determine local callback port.');
  }
  const port = address.port;

  timer = setTimeout(() => {
    if (!consumed) {
      consumed = true;
      rejectResult(new CliError('TIMEOUT', `No callback received within ${opts.timeoutMs}ms.`));
      closeServerSoon();
    }
  }, opts.timeoutMs);
  timer.unref?.();

  if (opts.signal) {
    if (opts.signal.aborted) {
      if (!consumed) {
        consumed = true;
        rejectResult(new CliError('TIMEOUT', 'Operation aborted before callback received.'));
        closeServerSoon();
      }
    } else {
      opts.signal.addEventListener(
        'abort',
        () => {
          if (!consumed) {
            consumed = true;
            rejectResult(new CliError('TIMEOUT', 'Operation aborted before callback received.'));
            closeServerSoon();
          }
        },
        { once: true }
      );
    }
  }

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  result.finally(cleanup).catch(() => undefined);

  async function close(): Promise<void> {
    cleanup();
    if (!consumed) {
      consumed = true;
      rejectResult(new CliError('TIMEOUT', 'Callback server closed before receiving a request.'));
    }
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  }

  return { port, result, close };
}
