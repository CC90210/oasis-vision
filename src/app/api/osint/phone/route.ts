import { NextResponse } from 'next/server';
import { PhoneNumberUtil, PhoneNumberFormat, PhoneNumberType } from 'google-libphonenumber';
import { lookupAreaCode, isNonGeographic } from '@/lib/nanp';

const phoneUtil = PhoneNumberUtil.getInstance();
const REGION_NAMES = new Intl.DisplayNames(['en'], { type: 'region' });

/**
 * OASIS VISION — phone number intelligence.
 *
 * Two things this route used to get wrong, both of which produced confident
 * nonsense rather than an honest gap:
 *
 * 1. It carried a 15-entry area-code table and fell back to a country centroid
 *    for everything else. A 705 number (northeastern Ontario) resolved to
 *    56.13,-106.35 — the geographic centre of Canada, in rural Saskatchewan —
 *    and was drawn on the map as a target pin. An unresolvable number now
 *    returns no coordinate at all.
 *
 * 2. It inferred line type from the first digit of the national number
 *    ("starts with 7, 8 or 9" => MOBILE), which is invented. libphonenumber
 *    ships real per-country type metadata and is already a dependency; it is
 *    now asked instead of guessed.
 *
 * On what the location MEANS: an area code identifies where a number was
 * issued, not where the handset is. Number portability has been mandatory in
 * Canada and the US since 2007. The response says so in `location_basis` so the
 * UI can never present it as a position fix.
 */

/** libphonenumber's numeric enum -> a label worth showing an operator. */
function describeType(t: number): { line_type: string; detail: string } {
  switch (t) {
    case PhoneNumberType.FIXED_LINE: return { line_type: 'LANDLINE', detail: 'Fixed line' };
    case PhoneNumberType.MOBILE: return { line_type: 'MOBILE', detail: 'Mobile' };
    case PhoneNumberType.FIXED_LINE_OR_MOBILE:
      // Real answer for the whole NANP: the plan does not separate them.
      return { line_type: 'FIXED_OR_MOBILE', detail: 'Fixed line or mobile — this numbering plan does not distinguish them' };
    case PhoneNumberType.TOLL_FREE: return { line_type: 'TOLL_FREE', detail: 'Toll-free' };
    case PhoneNumberType.PREMIUM_RATE: return { line_type: 'PREMIUM_RATE', detail: 'Premium rate' };
    case PhoneNumberType.SHARED_COST: return { line_type: 'SHARED_COST', detail: 'Shared cost' };
    case PhoneNumberType.VOIP: return { line_type: 'VOIP', detail: 'VoIP' };
    case PhoneNumberType.PERSONAL_NUMBER: return { line_type: 'PERSONAL', detail: 'Personal number' };
    case PhoneNumberType.PAGER: return { line_type: 'PAGER', detail: 'Pager' };
    case PhoneNumberType.UAN: return { line_type: 'UAN', detail: 'Universal access number' };
    case PhoneNumberType.VOICEMAIL: return { line_type: 'VOICEMAIL', detail: 'Voicemail' };
    default: return { line_type: 'UNKNOWN', detail: 'Type not derivable from the number alone' };
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const number = searchParams.get('number');

  if (!number) {
    return NextResponse.json({ error: 'Missing phone parameter' }, { status: 400 });
  }

  const raw = number.trim();
  const digitsOnly = raw.replace(/\D/g, '');

  // A bare 10-digit number is NANP by convention; anything else needs a country
  // code, and guessing one produces a valid-looking answer about another country.
  let query = raw;
  if (digitsOnly.length === 10 && !raw.startsWith('+') && !raw.startsWith('00')) {
    query = '+1' + digitsOnly;
  } else if (!raw.startsWith('+') && !raw.startsWith('00')) {
    query = '+' + digitsOnly;
  }

  try {
    const parsed = phoneUtil.parse(query);
    const valid = phoneUtil.isValidNumber(parsed);
    const regionCode = phoneUtil.getRegionCodeForNumber(parsed) || null;
    const countryCode = parsed.getCountryCode();
    const nationalNumber = String(parsed.getNationalNumber());

    let countryName: string | null = null;
    if (regionCode) {
      try { countryName = REGION_NAMES.of(regionCode) || regionCode; } catch { countryName = regionCode; }
    }

    const { line_type, detail } = describeType(phoneUtil.getNumberType(parsed));

    // ── Geography, only where the numbering plan actually carries it ──
    let area: ReturnType<typeof lookupAreaCode> = null;
    let areaCode: string | null = null;
    let locationBasis = 'Country of the dialling code only — this numbering plan is not mapped at area level';

    if (countryCode === 1 && nationalNumber.length === 10) {
      areaCode = nationalNumber.slice(0, 3);
      if (isNonGeographic(areaCode)) {
        locationBasis = 'Toll-free or service number — has no geographic area by design';
      } else {
        area = lookupAreaCode(areaCode);
        locationBasis = area
          ? 'Centre of the area code’s numbering plan area, where the number was ISSUED. Number portability means the holder may be anywhere.'
          : `Area code ${areaCode} is not in the local table — no coordinate returned rather than a guessed one`;
      }
    }

    return NextResponse.json({
      query: number,
      valid,
      number: phoneUtil.format(parsed, PhoneNumberFormat.E164),
      international: phoneUtil.format(parsed, PhoneNumberFormat.INTERNATIONAL),
      national: phoneUtil.format(parsed, PhoneNumberFormat.NATIONAL),
      country_code: `+${countryCode}`,
      country: countryName,
      region_code: regionCode,
      area_code: areaCode,
      // "Sudbury / Barrie, ON" rather than "Canada".
      region: area ? `${area.city}, ${area.region}` : (countryName ?? 'Unknown'),
      line_type,
      line_type_detail: detail,
      // Null, not a centroid, when the area is unknown.
      lat: area?.lat ?? null,
      lng: area?.lng ?? null,
      location_basis: locationBasis,
      // Carrier requires a paid HLR lookup; saying so beats "Unknown ISP".
      carrier: null,
      carrier_note: 'Carrier requires a live HLR/number-portability lookup, which no keyless source provides',
    });
  } catch (err: any) {
    return NextResponse.json({
      query: number,
      valid: false,
      error: err?.message ?? 'Could not parse number',
      number: query,
      international: query,
      national: query,
      country_code: null,
      country: null,
      region: 'Invalid format',
      line_type: 'UNKNOWN',
      lat: null,
      lng: null,
      location_basis: 'Number could not be parsed',
      carrier: null,
    });
  }
}
