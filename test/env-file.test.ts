import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';
import { writeEnvKey } from '../src/env-file.js';
import { CliError } from '../src/errors.js';

async function makeTmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `coolhand-env-test-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

describe('writeEnvKey', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmpDir();
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test('creates a new file when missing', async () => {
    const target = path.join(dir, '.env');
    const result = await writeEnvKey(target, 'COOLHAND_API_KEY', 'ch_pub_value');
    expect(result.created).toBe(true);
    expect(result.replaced).toBe(false);
    const contents = await fs.readFile(target, 'utf8');
    expect(contents).toContain('COOLHAND_API_KEY=ch_pub_value');
  });

  test('replaces an existing key without duplicating', async () => {
    const target = path.join(dir, '.env');
    await fs.writeFile(target, 'FOO=bar\nCOOLHAND_API_KEY=old\nBAZ=qux\n');
    const result = await writeEnvKey(target, 'COOLHAND_API_KEY', 'ch_pub_new');
    expect(result.created).toBe(false);
    expect(result.replaced).toBe(true);
    const contents = await fs.readFile(target, 'utf8');
    expect(contents).toContain('COOLHAND_API_KEY=ch_pub_new');
    expect(contents).not.toContain('COOLHAND_API_KEY=old');
    expect(contents.match(/COOLHAND_API_KEY=/g) ?? []).toHaveLength(1);
    expect(contents).toContain('FOO=bar');
    expect(contents).toContain('BAZ=qux');
  });

  test('preserves comments and surrounding lines', async () => {
    const target = path.join(dir, '.env');
    const original = '# top comment\nFOO=bar\n# inline\nCOOLHAND_API_KEY=old\n\n';
    await fs.writeFile(target, original);
    await writeEnvKey(target, 'COOLHAND_API_KEY', 'ch_pub_new');
    const contents = await fs.readFile(target, 'utf8');
    expect(contents).toContain('# top comment');
    expect(contents).toContain('# inline');
    expect(contents).toContain('COOLHAND_API_KEY=ch_pub_new');
  });

  test('appends when key is missing', async () => {
    const target = path.join(dir, '.env');
    await fs.writeFile(target, 'FOO=bar\n');
    await writeEnvKey(target, 'COOLHAND_API_KEY', 'ch_pub_new');
    const contents = await fs.readFile(target, 'utf8');
    expect(contents).toContain('FOO=bar');
    expect(contents).toContain('COOLHAND_API_KEY=ch_pub_new');
  });

  test('rejects invalid env key', async () => {
    const target = path.join(dir, '.env');
    await expect(writeEnvKey(target, '1BAD', 'v')).rejects.toBeInstanceOf(CliError);
  });
});
