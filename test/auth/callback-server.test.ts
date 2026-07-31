import { startCallbackServer } from '../../src/auth/callback-server.js';
import { CliError } from '../../src/errors.js';

async function get(port: number, pathAndQuery: string, method = 'GET'): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`, { method });
  const body = await res.text();
  return { status: res.status, body };
}

describe('startCallbackServer', () => {
  test('binds to 127.0.0.1 with a non-zero port', async () => {
    const handle = await startCallbackServer({ expectedState: 'abc', timeoutMs: 5000 });
    expect(handle.port).toBeGreaterThan(0);
    await handle.close().catch(() => undefined);
  });

  test('GET /callback with valid params resolves with payload', async () => {
    const handle = await startCallbackServer({ expectedState: 'state123', timeoutMs: 5000 });
    const responsePromise = get(
      handle.port,
      '/callback?token=ch_pub_AAAAAAAAAAAAAAAAAAAA&state=state123&client_name=Acme&client_id=acme'
    );
    const result = await handle.result;
    expect(result).toEqual({ token: 'ch_pub_AAAAAAAAAAAAAAAAAAAA', clientName: 'Acme', clientId: 'acme' });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect(response.body).toContain('Token captured');
    await handle.close().catch(() => undefined);
  });

  test('non-/callback paths return 404 and server stays listening', async () => {
    const handle = await startCallbackServer({ expectedState: 'state1', timeoutMs: 1000 });
    const bad = await get(handle.port, '/something-else');
    expect(bad.status).toBe(404);
    // Then a valid callback still completes.
    const ok = get(
      handle.port,
      '/callback?token=ch_pub_BBBBBBBBBBBBBBBBBBBB&state=state1&client_name=N&client_id=I'
    );
    await expect(handle.result).resolves.toEqual({
      token: 'ch_pub_BBBBBBBBBBBBBBBBBBBB',
      clientName: 'N',
      clientId: 'I',
    });
    await ok;
    await handle.close().catch(() => undefined);
  });

  test('POST /callback returns 405', async () => {
    const handle = await startCallbackServer({ expectedState: 'state1', timeoutMs: 500 });
    const res = await get(handle.port, '/callback?token=x&state=state1&client_name=N&client_id=I', 'POST');
    expect(res.status).toBe(405);
    await handle.close().catch(() => undefined);
    await expect(handle.result).rejects.toBeInstanceOf(CliError);
  });

  test('state mismatch returns 400 and rejects', async () => {
    const handle = await startCallbackServer({ expectedState: 'expected', timeoutMs: 5000 });
    const res = await get(
      handle.port,
      '/callback?token=t&state=wrong&client_name=N&client_id=I'
    );
    expect(res.status).toBe(400);
    await expect(handle.result).rejects.toMatchObject({ code: 'STATE_MISMATCH' });
    await handle.close().catch(() => undefined);
  });

  test('missing both tokens rejects with INVALID_CALLBACK', async () => {
    const handle = await startCallbackServer({ expectedState: 's', timeoutMs: 5000 });
    const res = await get(handle.port, '/callback?state=s&client_name=N&client_id=I');
    expect(res.status).toBe(400);
    await expect(handle.result).rejects.toMatchObject({ code: 'INVALID_CALLBACK' });
    await handle.close().catch(() => undefined);
  });

  test('GET /callback with only private_token resolves with payload', async () => {
    const handle = await startCallbackServer({ expectedState: 'state456', timeoutMs: 5000 });
    const responsePromise = get(
      handle.port,
      '/callback?private_token=ch_priv_AAAAAAAAAAAAAAAAAAAA&state=state456&client_name=Acme&client_id=acme'
    );
    const result = await handle.result;
    expect(result).toEqual({ token: undefined, clientName: 'Acme', clientId: 'acme', private_token: 'ch_priv_AAAAAAAAAAAAAAAAAAAA' });
    const response = await responsePromise;
    expect(response.status).toBe(200);
    await handle.close().catch(() => undefined);
  });

  test('missing client_id rejects with INVALID_CALLBACK', async () => {
    const handle = await startCallbackServer({ expectedState: 's', timeoutMs: 5000 });
    const res = await get(handle.port, '/callback?token=t&state=s&client_name=N');
    expect(res.status).toBe(400);
    await expect(handle.result).rejects.toMatchObject({ code: 'INVALID_CALLBACK' });
    await handle.close().catch(() => undefined);
  });

  test('second valid callback does not re-consume the token', async () => {
    const handle = await startCallbackServer({ expectedState: 's', timeoutMs: 5000 });
    const first = await get(handle.port, '/callback?token=t1&state=s&client_name=N&client_id=I');
    expect(first.status).toBe(200);
    const result = await handle.result;
    expect(result.token).toBe('t1');
    await new Promise((r) => setTimeout(r, 200));
    // After consuming once, either the listener has closed (fetch rejects) or it returns 410.
    // Both satisfy the single-shot invariant; the token must not be re-issued.
    let secondStatus: number | 'rejected';
    try {
      const second = await get(handle.port, '/callback?token=t2&state=s&client_name=N&client_id=I');
      secondStatus = second.status;
    } catch {
      secondStatus = 'rejected';
    }
    expect([410, 'rejected']).toContain(secondStatus);
  });

  test('timeout rejects with TIMEOUT', async () => {
    const handle = await startCallbackServer({ expectedState: 's', timeoutMs: 50 });
    await expect(handle.result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await handle.close().catch(() => undefined);
  });

  test('AbortSignal triggered rejects with TIMEOUT', async () => {
    const ctrl = new AbortController();
    const handle = await startCallbackServer({ expectedState: 's', timeoutMs: 5000, signal: ctrl.signal });
    ctrl.abort();
    await expect(handle.result).rejects.toMatchObject({ code: 'TIMEOUT' });
    await handle.close().catch(() => undefined);
  });
});
