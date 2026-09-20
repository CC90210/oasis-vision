import { NextResponse } from 'next/server';
import { isRateLimited, getClientIp } from '@/lib/ssrf-guard';

/**
 * OASIS VISION — Card BIN / IIN lookup.
 *
 * The first 6-8 digits of a card identify the issuing bank, the scheme
 * and the issuing country. Keyless via binlist.net (verified answering
 * 200 on 2026-09-19).
 *
 * This deliberately accepts ONLY the BIN. A full card number is never
 * needed to answer the question, so the route refuses to take one
 * rather than becoming a place card numbers get logged.
 */

export const dynamic = 'force-dynamic';

interface BinResponse {
  scheme?: string;
  type?: string;
  brand?: string;
  prepaid?: boolean;
  country?: { name?: string; alpha2?: string; emoji?: string; latitude?: number; longitude?: number };
  bank?: { name?: string; url?: string; phone?: string; city?: string };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = (searchParams.get('bin') || '').replace(/[\s-]/g, '');

  if (!raw) {
    return NextResponse.json({ error: 'Missing bin parameter' }, { status: 400 });
  }
  if (!/^\d+$/.test(raw)) {
    return NextResponse.json({ error: 'BIN must be digits only' }, { status: 400 });
  }
  // Refuse anything long enough to be a real card number.
  if (raw.length > 8) {
    return NextResponse.json(
      {
        error: 'Too many digits',
        detail: 'Submit only the first 6-8 digits. A full card number is never required and will not be accepted.',
      },
      { status: 400 },
    );
  }
  if (raw.length < 6) {
    return NextResponse.json({ error: 'A BIN is at least 6 digits' }, { status: 400 });
  }

  if (isRateLimited(getClientIp(req), 10, 60_000, 'bin')) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  try {
    const res = await fetch(`https://lookup.binlist.net/${raw}`, {
      headers: {
        'Accept-Version': '3',
        'User-Agent': 'OASIS-VISION/1.0 (+https://github.com/CC90210/oasis-vision)',
      },
      signal: AbortSignal.timeout(10000),
    });

    if (res.status === 404) {
      return NextResponse.json({ bin: raw, found: false, detail: 'No issuer record for this BIN.' });
    }
    if (res.status === 429) {
      return NextResponse.json(
        { error: 'Upstream rate limit', detail: 'binlist.net throttles anonymous lookups. Try again shortly.' },
        { status: 429 },
      );
    }
    if (!res.ok) throw new Error(`binlist responded ${res.status}`);

    const d = (await res.json()) as BinResponse;

    // The country centroid is an ISSUER COUNTRY, not a cardholder
    // location. Labelled as such so nobody reads the pin as a person.
    const geo =
      d.country?.latitude !== undefined && d.country?.longitude !== undefined
        ? [{
            lat: d.country.latitude,
            lng: d.country.longitude,
            label: `Issuer country: ${d.country.name ?? 'unknown'}`,
            provenance: 'Country centroid of the issuing bank — NOT a cardholder location',
            kind: 'registration' as const,
          }]
        : [];

    return NextResponse.json({
      bin: raw,
      found: true,
      scheme: d.scheme ?? null,
      type: d.type ?? null,
      brand: d.brand ?? null,
      prepaid: d.prepaid ?? null,
      bank: d.bank?.name ?? null,
      bankUrl: d.bank?.url ?? null,
      bankPhone: d.bank?.phone ?? null,
      country: d.country?.name ?? null,
      countryCode: d.country?.alpha2 ?? null,
      geo,
    });
  } catch (e) {
    console.error('[OASIS] BIN lookup failed:', e);
    return NextResponse.json(
      { error: 'BIN lookup failed', detail: e instanceof Error ? e.message : 'unknown' },
      { status: 502 },
    );
  }
}
