import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomBytes } from 'crypto';

export interface TmpHome {
  dir: string;
  cleanup(): Promise<void>;
}

export async function createTmpHome(): Promise<TmpHome> {
  const dir = path.join(os.tmpdir(), `coolhand-cli-test-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(dir, { recursive: true });
  process.env.COOLHAND_CONFIG_DIR = dir;
  return {
    dir,
    cleanup: async () => {
      delete process.env.COOLHAND_CONFIG_DIR;
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
