import { describe, it, expect } from 'vitest';
import { hashSubject, subjectHint, buildEntry } from './recon-audit';

const NOW = new Date('2026-09-19T12:00:00.000Z');

describe('hashSubject', () => {
  it('is stable and case/whitespace insensitive', () => {
    const a = hashSubject('Jane.Doe@Example.com');
    expect(hashSubject('  jane.doe@example.com  ')).toBe(a);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
  });

  it('separates different subjects', () => {
    expect(hashSubject('a@example.com')).not.toBe(hashSubject('b@example.com'));
  });
});

describe('subjectHint', () => {
  it('keeps the domain but never the local part', () => {
    expect(subjectHint('jane.doe@example.com')).toBe('j***@example.com');
  });

  it('does not leak a short subject', () => {
    expect(subjectHint('ab')).toBe('**');
    expect(subjectHint('abcdef')).toBe('ab***');
  });
});

describe('buildEntry', () => {
  it('never writes the subject in clear', () => {
    const e = buildEntry(
      { tool: 'email', subject: 'jane.doe@example.com', purpose: 'client-authorised', tier: 1 },
      NOW,
    );
    const serialised = JSON.stringify(e);
    expect(serialised).not.toContain('jane.doe@example.com');
    expect(serialised).not.toContain('jane.doe');
    expect(e.subject_sha256).toBe(hashSubject('jane.doe@example.com'));
  });

  it('records the declared purpose and tier', () => {
    const e = buildEntry({ tool: 'exif', subject: 'x', purpose: 'own-asset audit', tier: 2 }, NOW);
    expect(e.purpose).toBe('own-asset audit');
    expect(e.tier).toBe(2);
    expect(e.tool).toBe('exif');
    expect(e.ts).toBe('2026-09-19T12:00:00.000Z');
  });

  it('defaults an empty purpose rather than writing a blank field', () => {
    const e = buildEntry({ tool: 'email', subject: 'x@y.com', purpose: '', tier: 1 }, NOW);
    expect(e.purpose).toBe('unspecified');
  });

  it('supports confirming a suspected subject without storing any', () => {
    // The audit question is "was this address investigated?", which a
    // hash answers. Enumerating subjects from the file must not work.
    const e = buildEntry({ tool: 'email', subject: 'target@corp.com', purpose: 'p', tier: 1 }, NOW);
    expect(e.subject_sha256).toBe(hashSubject('target@corp.com'));
    expect(e.subject_sha256).not.toBe(hashSubject('other@corp.com'));
  });
});
