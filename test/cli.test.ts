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
});
