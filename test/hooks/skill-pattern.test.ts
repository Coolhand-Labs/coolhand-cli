import { isSkillPattern, resolveSkill, skillLabel, skillMatchesPattern } from '../../src/hooks/adapters/shared.js';

/** The `--skill` matcher both agents' adapters share. */

describe('skillLabel', () => {
  it('is the declared name, else the last segment of the skill directory (a plugin path, a trailing slash, Windows separators)', () => {
    expect(skillLabel({ name: 'Pretty Name', dir: '/w/skills/qa-dir' })).toBe('Pretty Name');
    expect(skillLabel({ dir: '/home/me/.claude/plugins/cache/x/1.0.0/skills/qa-spike' })).toBe('qa-spike');
    expect(skillLabel({ dir: '/w/skills/qa-spike/' })).toBe('qa-spike');
    expect(skillLabel({ dir: 'C:\\work\\skills\\qa-spike' })).toBe('qa-spike');
  });
});

describe('skillMatchesPattern and resolveSkill', () => {
  const invoked = [{ name: 'acme-first', dir: '/s/acme-first' }, { dir: '/s/acme-second' }, { name: 'other', dir: '/s/other' }];

  it('treats a trailing * or a | list as a pattern', () => {
    expect(isSkillPattern('*')).toBe(true);
    expect(isSkillPattern('acme-*')).toBe(true);
    expect(isSkillPattern('acme-first|other')).toBe(true);
    expect(isSkillPattern('*-qa')).toBe(false);
    expect(isSkillPattern('acme')).toBe(false);
  });

  it('matches a prefix pattern on the skill label, and a plain name by name or directory', () => {
    expect(skillMatchesPattern('acme-*', invoked[1])).toBe(true);
    expect(skillMatchesPattern('acme-*', invoked[2])).toBe(false);
    expect(skillMatchesPattern('*', invoked[2])).toBe(true);
    expect(skillMatchesPattern('acme-second', invoked[1])).toBe(true);
    expect(skillMatchesPattern('acme', invoked[0])).toBe(false);
  });

  it('matches any alternative of a | list: a prefix pattern or an exact name, by name or directory', () => {
    expect(skillMatchesPattern('nope-*|other', invoked[2])).toBe(true);
    expect(skillMatchesPattern('nope-*|other', invoked[0])).toBe(false);
    expect(skillMatchesPattern('other|acme-*', invoked[1])).toBe(true);
    expect(skillMatchesPattern('x|acme-second', invoked[1])).toBe(true);
    expect(skillMatchesPattern(' acme-* | other ', invoked[2])).toBe(true);
    expect(skillMatchesPattern('acme|other-*', invoked[0])).toBe(false);
  });

  it('treats an empty alternative as absent, a lone * alternative as any skill, and a mid-string * as literal text', () => {
    expect(skillMatchesPattern('nope||other', invoked[2])).toBe(true);
    expect(skillMatchesPattern('nope||other', invoked[0])).toBe(false);
    expect(skillMatchesPattern('nope|*', invoked[0])).toBe(true);
    expect(skillMatchesPattern('acme*first|x', invoked[0])).toBe(false);
  });

  it('ignores whitespace around a trailing * the same way inside and outside a list', () => {
    expect(isSkillPattern('acme-* ')).toBe(true);
    expect(skillMatchesPattern('acme-* ', invoked[1])).toBe(true);
    expect(skillMatchesPattern(' acme-* |nope', invoked[1])).toBe(true);
  });

  it('matches nothing for a | list with no usable alternative', () => {
    expect(skillMatchesPattern('|', invoked[0])).toBe(false);
    expect(skillMatchesPattern(' | ', invoked[2])).toBe(false);
  });

  it('resolves a | list to the first invoked skill that matches any alternative', () => {
    expect(resolveSkill('nope-*|other', invoked)).toBe('other');
    expect(resolveSkill('other|acme-*', invoked)).toBe('acme-first');
    expect(resolveSkill('nope-*|missing', invoked)).toBeUndefined();
  });

  it('resolves a pattern to the first match, never to the pattern, and a plain name to itself', () => {
    expect(resolveSkill('acme-*', invoked)).toBe('acme-first');
    expect(resolveSkill('*', [invoked[2], invoked[0]])).toBe('other');
    expect(resolveSkill('nope-*', invoked)).toBeUndefined();
    expect(resolveSkill('*', [])).toBeUndefined();
    expect(resolveSkill('acme-second', [])).toBe('acme-second');
  });
});
