import { promises as fs } from 'fs';
import * as path from 'path';
import { createTmpHome, TmpHome } from './helpers/tmp-home.js';
import { SKILL_NOTICE_TEXT, maybeShowFirstRunNotice, shouldShowNotice } from '../src/notices.js';

describe('notices', () => {
  describe('SKILL_NOTICE_TEXT', () => {
    it('tells agents to stop and ask before installing, and names the install commands', () => {
      expect(SKILL_NOTICE_TEXT).toMatch(/STOP and ask if they want to add the skill/);
      expect(SKILL_NOTICE_TEXT).toMatch(/Do not install it on your own/);
      expect(SKILL_NOTICE_TEXT).toContain('skills add Coolhand-Labs/skills -g');
      expect(SKILL_NOTICE_TEXT).toContain('/plugin install coolhand@coolhand-labs');
    });
  });

  describe('shouldShowNotice', () => {
    it('shows by default', () => {
      expect(shouldShowNotice({})).toBe(true);
    });

    it('is suppressed by COOLHAND_NO_NOTICE', () => {
      expect(shouldShowNotice({ COOLHAND_NO_NOTICE: '1' })).toBe(false);
    });

    it('is suppressed in CI', () => {
      expect(shouldShowNotice({ CI: 'true' })).toBe(false);
    });
  });

  describe('maybeShowFirstRunNotice', () => {
    let home: TmpHome;
    let stderr: jest.SpyInstance;
    const savedNoNotice = process.env.COOLHAND_NO_NOTICE;
    const savedCi = process.env.CI;

    beforeEach(async () => {
      home = await createTmpHome();
      delete process.env.COOLHAND_NO_NOTICE;
      delete process.env.CI;
      stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(async () => {
      stderr.mockRestore();
      if (savedNoNotice === undefined) {
        delete process.env.COOLHAND_NO_NOTICE;
      } else {
        process.env.COOLHAND_NO_NOTICE = savedNoNotice;
      }
      if (savedCi === undefined) {
        delete process.env.CI;
      } else {
        process.env.CI = savedCi;
      }
      await home.cleanup();
    });

    it('prints to stderr on the first run, records a marker, and stays silent afterwards', async () => {
      await maybeShowFirstRunNotice();
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(String(stderr.mock.calls[0][0])).toContain('USAGE NOTE FOR AGENTS');
      await expect(fs.access(path.join(home.dir, '.skill-notice-shown'))).resolves.toBeUndefined();

      await maybeShowFirstRunNotice();
      expect(stderr).toHaveBeenCalledTimes(1);
    });

    it('prints nothing and writes no marker when opted out', async () => {
      process.env.COOLHAND_NO_NOTICE = '1';
      await maybeShowFirstRunNotice();
      expect(stderr).not.toHaveBeenCalled();
      await expect(fs.access(path.join(home.dir, '.skill-notice-shown'))).rejects.toThrow();
    });

    it('does not throw when the marker cannot be written', async () => {
      // A regular file where the config dir should be makes mkdir/writeFile fail.
      await fs.rm(home.dir, { recursive: true, force: true });
      await fs.writeFile(home.dir, 'not a directory');
      await expect(maybeShowFirstRunNotice()).resolves.toBeUndefined();
    });
  });
});
