import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as mockttp from 'mockttp';
import { getOrCreateCA, getCertPath } from '../../src/proxy/certs.js';

jest.mock('mockttp', () => ({
  generateCACertificate: jest.fn().mockResolvedValue({
    key: '---fake-key---',
    cert: '---fake-cert---',
  }),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coolhand-certs-test-'));
  (mockttp.generateCACertificate as jest.Mock).mockClear();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('getOrCreateCA', () => {
  test('generates and persists a new cert pair when no files exist', async () => {
    const ca = await getOrCreateCA(tmpDir);

    expect(ca.key).toBe('---fake-key---');
    expect(ca.cert).toBe('---fake-cert---');
    expect(mockttp.generateCACertificate).toHaveBeenCalledTimes(1);

    expect(fs.readFileSync(path.join(tmpDir, 'ca-key.pem'), 'utf8')).toBe('---fake-key---');
    expect(fs.readFileSync(path.join(tmpDir, 'ca-cert.pem'), 'utf8')).toBe('---fake-cert---');
  });

  test('key file written with mode 0o600', async () => {
    await getOrCreateCA(tmpDir);
    const stat = fs.statSync(path.join(tmpDir, 'ca-key.pem'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  test('directory created with mode 0o700', async () => {
    const subDir = path.join(tmpDir, 'new-subdir');
    await getOrCreateCA(subDir);
    const stat = fs.statSync(subDir);
    expect(stat.mode & 0o777).toBe(0o700);
  });

  test('returns existing certs without regenerating', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ca-key.pem'), '---existing-key---', { mode: 0o600 });
    fs.writeFileSync(path.join(tmpDir, 'ca-cert.pem'), '---existing-cert---', { mode: 0o644 });

    const ca = await getOrCreateCA(tmpDir);

    expect(ca.key).toBe('---existing-key---');
    expect(ca.cert).toBe('---existing-cert---');
    expect(mockttp.generateCACertificate).not.toHaveBeenCalled();
  });

  test('warns to stderr and regenerates when only cert file is missing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ca-key.pem'), '---existing-key---', { mode: 0o600 });

    const stderrWrites: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderrWrites.push(String(s));
      return true;
    });

    const ca = await getOrCreateCA(tmpDir);
    (process.stderr.write as jest.Mock).mockRestore();

    expect(ca.key).toBe('---fake-key---');
    expect(mockttp.generateCACertificate).toHaveBeenCalledTimes(1);
    expect(stderrWrites.some(s => s.includes('incomplete'))).toBe(true);
  });

  test('warns to stderr and regenerates when only key file is missing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'ca-cert.pem'), '---existing-cert---', { mode: 0o644 });

    const stderrWrites: string[] = [];
    jest.spyOn(process.stderr, 'write').mockImplementation((s) => {
      stderrWrites.push(String(s));
      return true;
    });

    const ca = await getOrCreateCA(tmpDir);
    (process.stderr.write as jest.Mock).mockRestore();

    expect(ca.key).toBe('---fake-key---');
    expect(stderrWrites.some(s => s.includes('incomplete'))).toBe(true);
  });

  test('no warning emitted when neither cert file exists (fresh install)', async () => {
    const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await getOrCreateCA(tmpDir);
    stderrSpy.mockRestore();

    expect(stderrSpy).not.toHaveBeenCalled();
  });

  test('no temp files left on disk after successful generation', async () => {
    await getOrCreateCA(tmpDir);
    const files = fs.readdirSync(tmpDir);
    expect(files).not.toContain('ca-key.pem.tmp');
    expect(files).not.toContain('ca-cert.pem.tmp');
  });
});

describe('getCertPath', () => {
  test('returns the ca-cert.pem path within the given directory', () => {
    expect(getCertPath('/some/dir')).toBe('/some/dir/ca-cert.pem');
  });
});
