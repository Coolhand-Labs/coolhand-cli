import { execFileSync } from 'child_process';
import { promises as fs } from 'fs';
import * as path from 'path';
import { machineId, resolveTesterIdentity } from '../../src/hooks/identity.js';
import { createTmpHome, TmpHome } from '../helpers/tmp-home.js';

describe('resolveTesterIdentity', () => {
  let home: TmpHome;
  const savedUser = process.env.COOLHAND_CAPTURE_USER;

  beforeEach(async () => {
    home = await createTmpHome();
    delete process.env.COOLHAND_CAPTURE_USER;
  });
  afterEach(async () => {
    await home.cleanup();
    if (savedUser === undefined) {
      delete process.env.COOLHAND_CAPTURE_USER;
    } else {
      process.env.COOLHAND_CAPTURE_USER = savedUser;
    }
  });

  it('mints a stable machine id', async () => {
    const first = await machineId();
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await machineId()).toBe(first);
  });

  it('prefers the COOLHAND_CAPTURE_USER override', async () => {
    process.env.COOLHAND_CAPTURE_USER = 'qa-bot';
    expect(await resolveTesterIdentity()).toEqual({ id: 'qa-bot', source: 'env' });
  });

  it('--anonymous wins over the override and never consults git', async () => {
    process.env.COOLHAND_CAPTURE_USER = 'me@example.com';
    const identity = await resolveTesterIdentity({ anonymous: true });
    expect(identity).toEqual({ id: await machineId(), source: 'machine' });
  });

  it('reads the git email from the session working directory', async () => {
    const repo = path.join(home.dir, 'repo');
    await fs.mkdir(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['config', 'user.email', 'repo-local@example.com'], { cwd: repo });
    expect(await resolveTesterIdentity({ cwd: repo })).toEqual({ id: 'repo-local@example.com', source: 'git' });
  });

  it('falls back to the machine id when git is unavailable', async () => {
    const dir = path.join(home.dir, 'plain');
    await fs.mkdir(dir);
    // No git on PATH: deterministic whatever identity the developer's own git config holds.
    const savedPath = process.env.PATH;
    process.env.PATH = dir;
    try {
      expect(await resolveTesterIdentity({ cwd: dir })).toEqual({ id: await machineId(), source: 'machine' });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
