import { parseArgs, run } from '../src/cli.js';
import { createTmpHome, TmpHome } from './helpers/tmp-home.js';

describe('parseArgs', () => {
  test('extracts subcommand and flags', () => {
    const parsed = parseArgs(['login', '--base-url', 'https://x', '--json']);
    expect(parsed.command).toBe('login');
    expect(parsed.flags['base-url']).toBe('https://x');
    expect(parsed.flags.json).toBe(true);
  });

  test('supports = syntax', () => {
    const parsed = parseArgs(['login', '--base-url=https://x']);
    expect(parsed.flags['base-url']).toBe('https://x');
  });

  test('captures positional arguments', () => {
    const parsed = parseArgs(['clients', 'use', 'acme']);
    expect(parsed.command).toBe('clients');
    expect(parsed.positional).toEqual(['use', 'acme']);
  });

  test('treats short flag as boolean', () => {
    const parsed = parseArgs(['--version']);
    expect(parsed.flags.version).toBe(true);
  });

  test('does not consume positional id after boolean flag', () => {
    const parsed = parseArgs(['get-optimization', '--json', 'opt-1']);
    expect(parsed.command).toBe('get-optimization');
    expect(parsed.flags.json).toBe(true);
    expect(parsed.positional).toEqual(['opt-1']);
  });

  test('preserves multi-word positional text', () => {
    const parsed = parseArgs(['add-optimization-comment', 'opt-1', 'looks', 'good']);
    expect(parsed.command).toBe('add-optimization-comment');
    expect(parsed.positional).toEqual(['opt-1', 'looks', 'good']);
  });
});

describe('run', () => {
  let home: TmpHome;
  beforeEach(async () => {
    home = await createTmpHome();
  });
  afterEach(async () => {
    await home.cleanup();
  });

  test('--version exits 0', async () => {
    const code = await run(['--version']);
    expect(code).toBe(0);
  });

  test('unknown command exits with USER_ERROR', async () => {
    const code = await run(['frobnicate']);
    expect(code).toBe(1);
  });

  test('status with no config exits 1', async () => {
    const code = await run(['status', '--json']);
    expect(code).toBe(1);
  });

  test('help exits 0', async () => {
    const code = await run(['help']);
    expect(code).toBe(0);
  });

  test('login --write-env without path returns INVALID_ARGS', async () => {
    const code = await run(['login', '--write-env']);
    expect(code).toBe(1);
  });

  test('get-optimization without id returns exit 1', async () => {
    const code = await run(['get-optimization']);
    expect(code).toBe(1);
  });

  test('close-optimization without id returns exit 1', async () => {
    const code = await run(['close-optimization']);
    expect(code).toBe(1);
  });

  test('close-optimization with id but no reason returns exit 1', async () => {
    const code = await run(['close-optimization', 'abc-123']);
    expect(code).toBe(1);
  });

  test('update-optimization without id returns exit 1', async () => {
    const code = await run(['update-optimization']);
    expect(code).toBe(1);
  });

  test('add-optimization-comment without comment returns exit 1', async () => {
    const code = await run(['add-optimization-comment', 'abc-123']);
    expect(code).toBe(1);
  });
});
