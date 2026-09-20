/**
 * ═══════════════════════════════════════════════════════════════
 *  OASIS VISION — Is this address real, and what kind of address is it?
 *
 *  Everything here is keyless. MX comes from Cloudflare's DNS-over-HTTPS
 *  resolver, verified returning `Answer[].data` as "<priority> <host>."
 *  for protonmail.com on 2026-09-19.
 *
 *  What this deliberately does NOT do: SMTP probing. Connecting to a
 *  mail exchanger to ask whether a mailbox exists is rude, frequently
 *  blocked, gets the asking IP listed, and on a catch-all domain tells
 *  you nothing anyway. "deliverable" here means the DOMAIN can receive
 *  mail, never that the mailbox exists — and the wording says so.
 * ═══════════════════════════════════════════════════════════════
 */

import type { ValidityReport, DeliverabilityStatus } from './types';

/**
 * Deliberately stricter than RFC 5322, which permits quoted strings and
 * comments almost nobody uses. An address that fails here is not
 * necessarily illegal — it is one we will not investigate, which we say
 * rather than guessing.
 */
const ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/**
 * Addresses that belong to a function, not a person. Investigating one
 * as though it were an individual is the fastest way to produce a
 * confident, wrong identity.
 */
const ROLE_PREFIXES = new Set([
  'abuse', 'admin', 'administrator', 'billing', 'careers', 'compliance',
  'contact', 'enquiries', 'enquiry', 'feedback', 'finance', 'help',
  'hello', 'hi', 'hr', 'info', 'jobs', 'legal', 'mail', 'marketing',
  'media', 'newsletter', 'noreply', 'no-reply', 'office', 'orders',
  'postmaster', 'press', 'privacy', 'root', 'sales', 'security',
  'support', 'team', 'webmaster', 'www',
]);

/** Consumer mailbox providers. Not suspicious — just not corporate. */
const FREE_PROVIDERS = new Set([
  'aol.com', 'fastmail.com', 'gmail.com', 'gmx.com', 'gmx.de',
  'hotmail.co.uk', 'hotmail.com', 'hotmail.fr', 'icloud.com',
  'live.com', 'mail.com', 'mail.ru', 'me.com', 'msn.com',
  'outlook.com', 'pm.me', 'proton.me', 'protonmail.ch',
  'protonmail.com', 'qq.com', 'tutanota.com', 'web.de',
  'yahoo.co.uk', 'yahoo.com', 'yandex.com', 'yandex.ru', 'zoho.com',
]);

/**
 * Throwaway providers. A small, high-confidence seed rather than a
 * 40k-entry list: a false "disposable" verdict on a real person's
 * address is a worse error than missing an obscure burner domain, and
 * the big public lists are noisy enough to produce those.
 */
const DISPOSABLE_DOMAINS = new Set([
  '0-mail.com', '10minutemail.com', '20minutemail.com', 'anonbox.net',
  'burnermail.io', 'dispostable.com', 'emailondeck.com', 'fakeinbox.com',
  'getairmail.com', 'getnada.com', 'guerrillamail.com', 'inboxbear.com',
  'mail-temporaire.fr', 'mailcatch.com', 'maildrop.cc', 'mailinator.com',
  'mailnesia.com', 'mintemail.com', 'mohmal.com', 'mytemp.email',
  'sharklasers.com', 'spamgourmet.com', 'temp-mail.org', 'tempail.com',
  'tempinbox.com', 'tempmail.net', 'tempmailo.com', 'throwawaymail.com',
  'trashmail.com', 'yopmail.com', 'yopmail.net',
]);

const DOH_ENDPOINT = 'https://cloudflare-dns.com/dns-query';

interface DohAnswer { name: string; type: number; TTL: number; data: string }
interface DohResponse { Status: number; Answer?: DohAnswer[] }

/**
 * MX records for a domain, highest priority first.
 *
 * Throws rather than returning [] on a transport failure: the caller has
 * to be able to tell "this domain has no MX" from "we could not ask",
 * and an empty array cannot carry that difference.
 */
export async function lookupMx(domain: string, timeoutMs = 6000): Promise<string[]> {
  const url = `${DOH_ENDPOINT}?name=${encodeURIComponent(domain)}&type=MX`;
  const res = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`DoH responded ${res.status}`);

  const body = (await res.json()) as DohResponse;
  // Status 0 = NOERROR, 3 = NXDOMAIN. Anything else is a resolver
  // problem we should not read as "no mail exchanger".
  if (body.Status !== 0 && body.Status !== 3) {
    throw new Error(`DoH status ${body.Status}`);
  }
  if (!body.Answer) return [];

  return body.Answer
    .filter((a) => a.type === 15)
    .map((a) => {
      // "10 mailsec.protonmail.ch." -> { priority: 10, host: ... }
      const [prio, ...rest] = a.data.trim().split(/\s+/);
      return { priority: Number(prio), host: rest.join(' ').replace(/\.$/, '') };
    })
    .filter((m) => m.host.length > 0 && Number.isFinite(m.priority))
    .sort((a, b) => a.priority - b.priority)
    .map((m) => m.host);
}

/** Split an address without trusting it. Returns null when unusable. */
export function splitAddress(email: string): { localPart: string; domain: string } | null {
  const trimmed = email.trim();
  if (!ADDRESS.test(trimmed)) return null;
  const at = trimmed.lastIndexOf('@');
  return {
    localPart: trimmed.slice(0, at),
    domain: trimmed.slice(at + 1).toLowerCase(),
  };
}

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_DOMAINS.has(domain.toLowerCase());
}

export function isFreeProvider(domain: string): boolean {
  return FREE_PROVIDERS.has(domain.toLowerCase());
}

/**
 * Role accounts are matched on the part before any plus-tag or
 * separator, so `support+eu@` and `support.eu@` both count.
 */
export function isRoleAccount(localPart: string): boolean {
  const base = localPart.toLowerCase().split('+')[0];
  if (ROLE_PREFIXES.has(base)) return true;
  const head = base.split(/[._-]/)[0];
  return ROLE_PREFIXES.has(head);
}

/**
 * Decide deliverability from what we actually established.
 *
 * `mxChecked` is the honesty switch: without it, "no MX found" and "we
 * never looked" collapse into the same answer, and the analyst cannot
 * tell which they are reading.
 */
export function gradeDeliverability(input: {
  syntaxValid: boolean;
  mx: string[];
  mxChecked: boolean;
  disposable: boolean;
}): { status: DeliverabilityStatus; reasoning: string } {
  if (!input.syntaxValid) {
    return { status: 'undeliverable', reasoning: 'Address does not parse as a valid mailbox.' };
  }
  if (!input.mxChecked) {
    return { status: 'unknown', reasoning: 'MX lookup did not complete, so the domain was never checked.' };
  }
  if (input.mx.length === 0) {
    return { status: 'undeliverable', reasoning: 'Domain publishes no MX record, so it cannot receive mail.' };
  }
  if (input.disposable) {
    return {
      status: 'risky',
      reasoning: `Domain accepts mail (${input.mx.length} MX) but is a known disposable provider.`,
    };
  }
  return {
    status: 'deliverable',
    reasoning: `Domain accepts mail (${input.mx.length} MX). The mailbox itself was not probed.`,
  };
}

/**
 * Full validity report. Never throws — an MX failure degrades the
 * report to `unknown` and is reported through `mxChecked`, because a
 * dead resolver should not abort an otherwise useful investigation.
 */
export async function checkValidity(email: string): Promise<ValidityReport> {
  const parts = splitAddress(email);

  if (!parts) {
    return {
      syntaxValid: false,
      domain: '',
      localPart: '',
      mx: [],
      mxChecked: false,
      disposable: false,
      roleAccount: false,
      freeProvider: false,
      status: 'undeliverable',
      reasoning: 'Address does not parse as a valid mailbox.',
    };
  }

  const { localPart, domain } = parts;
  let mx: string[] = [];
  let mxChecked = false;

  try {
    mx = await lookupMx(domain);
    mxChecked = true;
  } catch (e) {
    // Logged, not swallowed: a silent catch here would make a dead
    // resolver look like a domain with no mail exchanger.
    console.error(`[OASIS] email-intel: MX lookup failed for ${domain}:`, e instanceof Error ? e.message : e);
  }

  const disposable = isDisposableDomain(domain);
  const { status, reasoning } = gradeDeliverability({ syntaxValid: true, mx, mxChecked, disposable });

  return {
    syntaxValid: true,
    domain,
    localPart,
    mx,
    mxChecked,
    disposable,
    roleAccount: isRoleAccount(localPart),
    freeProvider: isFreeProvider(domain),
    status,
    reasoning,
  };
}
