import { createServer, Server } from 'http';
import { AddressInfo } from 'net';

export interface FakeRailsRedirect {
  token?: string;
  state?: string;
  clientName?: string;
  clientId?: string;
  private_token?: string;
}

export interface FakeRails {
  port: number;
  url: string;
  callbacks: Array<{ redirectUri: string; state: string }>;
  close(): Promise<void>;
}

/**
 * Stands in for the Coolhand Rails server during tests. When the CLI opens
 * `/cli/auth`, this server records the redirect_uri + state and immediately
 * issues a 302 to `${redirectUri}?token=...&state=...&client_name=...&client_id=...`
 * as if a human had clicked through.
 */
export async function startFakeRails(
  responder: (params: { redirectUri: string; state: string }) => FakeRailsRedirect
): Promise<FakeRails> {
  const callbacks: Array<{ redirectUri: string; state: string }> = [];

  const server: Server = createServer((req, res) => {
    const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (reqUrl.pathname !== '/cli/auth') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const redirectUri = reqUrl.searchParams.get('redirect_uri') ?? '';
    const state = reqUrl.searchParams.get('state') ?? '';
    callbacks.push({ redirectUri, state });
    const decision = responder({ redirectUri, state });
    const callbackUrl = new URL(redirectUri);
    if (decision.token !== undefined) {
      callbackUrl.searchParams.set('token', decision.token);
    }
    if (decision.state !== undefined) {
      callbackUrl.searchParams.set('state', decision.state);
    }
    if (decision.clientName !== undefined) {
      callbackUrl.searchParams.set('client_name', decision.clientName);
    }
    if (decision.clientId !== undefined) {
      callbackUrl.searchParams.set('client_id', decision.clientId);
    }
    if (decision.private_token !== undefined) {
      callbackUrl.searchParams.set('private_token', decision.private_token);
    }
    res.statusCode = 302;
    res.setHeader('Location', callbackUrl.toString());
    res.end();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  return {
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
    callbacks,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

/**
 * Drive the consent-page redirect manually by hitting the redirect_uri ourselves.
 * Useful when we don't want to spin up an HTTP server to issue the 302.
 */
export async function deliverCallback(redirectUri: string, params: FakeRailsRedirect): Promise<void> {
  const url = new URL(redirectUri);
  if (params.token !== undefined) {
    url.searchParams.set('token', params.token);
  }
  if (params.state !== undefined) {
    url.searchParams.set('state', params.state);
  }
  if (params.clientName !== undefined) {
    url.searchParams.set('client_name', params.clientName);
  }
  if (params.clientId !== undefined) {
    url.searchParams.set('client_id', params.clientId);
  }
  if (params.private_token !== undefined) {
    url.searchParams.set('private_token', params.private_token);
  }
  await fetch(url.toString(), { method: 'GET' }).catch(() => undefined);
}
