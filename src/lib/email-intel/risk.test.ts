import { describe, it, expect } from 'vitest';
import { scoreRisk } from './risk';
import type { BreachFinding, AccountFinding, ValidityReport } from './types';

const validity = (over: Partial<ValidityReport> = {}): ValidityReport => ({
  syntaxValid: true,
  domain: 'example.com',
  localPart: 'jane',
  mx: ['mail.example.com'],
  mxChecked: true,
  disposable: false,
  roleAccount: false,
  freeProvider: false,
  status: 'deliverable',
  reasoning: '',
  ...over,
});

const breach = (name: string, classes: string[]): BreachFinding => ({
  name, date: '2021-01-01', classes, source: 'XposedOrNot',
});

const account = (status: AccountFinding['status'], platform = 'GitHub'): AccountFinding => ({
  platform, url: null, status, evidence: '',
});

describe('scoreRisk', () => {
  it('scores a clean subject at minimal with nothing invented', () => {
    const r = scoreRisk({ breaches: [], accounts: [], validity: validity() });
    expect(r.score).toBe(0);
    expect(r.band).toBe('minimal');
    expect(r.drivers).toEqual([]);
  });

  it('every point is attributable — a score always names its drivers', () => {
    const r = scoreRisk({
      breaches: [breach('Acme', ['Passwords', 'Email addresses'])],
      accounts: [],
      validity: validity(),
    });
    expect(r.score).toBeGreaterThan(0);
    expect(r.drivers.length).toBeGreaterThan(0);
    expect(r.drivers[0]).toMatch(/password|credential/i);
  });

  it('ranks credential exposure above everything else', () => {
    const creds = scoreRisk({
      breaches: [breach('Acme', ['Passwords'])],
      accounts: [],
      validity: validity(),
    });
    const trivial = scoreRisk({
      breaches: [breach('Forum', ['Usernames'])],
      accounts: [],
      validity: validity(),
    });
    expect(creds.score).toBeGreaterThan(trivial.score);
    expect(creds.nextAction).toMatch(/rotate/i);
  });

  it('a blocked source adds no points but is stated as incomplete coverage', () => {
    const r = scoreRisk({ breaches: [], accounts: [account('blocked')], validity: validity() });
    expect(r.score).toBe(0);
    expect(r.drivers.some((d) => /refused to answer/i.test(d))).toBe(true);
    expect(r.nextAction).toMatch(/re-run/i);
  });

  it('does not report an all-clear when a source never answered', () => {
    const clean = scoreRisk({ breaches: [], accounts: [account('not_found')], validity: validity() });
    const blocked = scoreRisk({ breaches: [], accounts: [account('blocked')], validity: validity() });
    expect(clean.nextAction).not.toMatch(/re-run/i);
    expect(blocked.nextAction).toMatch(/re-run/i);
  });

  it('flags a shared role mailbox', () => {
    const r = scoreRisk({ breaches: [], accounts: [], validity: validity({ roleAccount: true }) });
    expect(r.drivers.some((d) => /role mailbox/i.test(d))).toBe(true);
  });

  it('stays inside 0-100 under heavy exposure', () => {
    const many = Array.from({ length: 30 }, (_, i) => breach(`B${i}`, ['Passwords', 'Credit card']));
    const r = scoreRisk({
      breaches: many,
      accounts: Array.from({ length: 12 }, () => account('found')),
      validity: validity({ roleAccount: true, disposable: true }),
    });
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.band).toBe('critical');
  });
});
