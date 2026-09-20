import { describe, it, expect } from 'vitest';
import {
  splitAddress,
  isRoleAccount,
  isDisposableDomain,
  isFreeProvider,
  gradeDeliverability,
} from './validity';

describe('splitAddress', () => {
  it('splits a normal address and lowercases only the domain', () => {
    expect(splitAddress('Jane.Doe@Example.COM')).toEqual({
      localPart: 'Jane.Doe',
      domain: 'example.com',
    });
  });

  it('rejects addresses we will not investigate', () => {
    for (const bad of ['', 'plainstring', 'no@tld', 'two@@at.com', 'trailing@dot.com.', '@nolocal.com']) {
      expect(splitAddress(bad), bad).toBeNull();
    }
  });
});

describe('isRoleAccount', () => {
  it('matches role mailboxes including tagged and separated forms', () => {
    expect(isRoleAccount('support')).toBe(true);
    expect(isRoleAccount('support+eu')).toBe(true);
    expect(isRoleAccount('support.eu')).toBe(true);
    expect(isRoleAccount('no-reply')).toBe(true);
  });

  it('does not flag a person whose name starts like a role word', () => {
    // "infosec" must not match "info"; the check is on whole segments.
    expect(isRoleAccount('infosec')).toBe(false);
    expect(isRoleAccount('jane.doe')).toBe(false);
  });
});

describe('domain classification', () => {
  it('knows disposable and free providers apart', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('gmail.com')).toBe(false);
    expect(isFreeProvider('gmail.com')).toBe(true);
    expect(isFreeProvider('acme-corp.com')).toBe(false);
  });
});

describe('gradeDeliverability', () => {
  it('separates "no MX" from "never checked" — the honesty switch', () => {
    const noMx = gradeDeliverability({ syntaxValid: true, mx: [], mxChecked: true, disposable: false });
    expect(noMx.status).toBe('undeliverable');
    expect(noMx.reasoning).toMatch(/publishes no MX/i);

    const notChecked = gradeDeliverability({ syntaxValid: true, mx: [], mxChecked: false, disposable: false });
    expect(notChecked.status).toBe('unknown');
    expect(notChecked.reasoning).toMatch(/did not complete/i);
  });

  it('never claims the mailbox itself exists', () => {
    const ok = gradeDeliverability({
      syntaxValid: true,
      mx: ['mail.protonmail.ch'],
      mxChecked: true,
      disposable: false,
    });
    expect(ok.status).toBe('deliverable');
    expect(ok.reasoning).toMatch(/mailbox itself was not probed/i);
  });

  it('marks a disposable domain risky even when it accepts mail', () => {
    const r = gradeDeliverability({
      syntaxValid: true,
      mx: ['mail.mailinator.com'],
      mxChecked: true,
      disposable: true,
    });
    expect(r.status).toBe('risky');
  });

  it('is undeliverable when syntax fails, whatever else is true', () => {
    const r = gradeDeliverability({ syntaxValid: false, mx: ['x'], mxChecked: true, disposable: false });
    expect(r.status).toBe('undeliverable');
  });
});
