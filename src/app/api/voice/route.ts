import { NextResponse } from 'next/server';

/**
 * OASIS VISION — what the voice service can actually do right now.
 *
 * GET /api/voice -> { configured, voices[], quota }
 *
 * The voice picker is built from THIS, never from a hardcoded list. A list
 * written into the client drifts the moment a voice is removed from the
 * account, and the operator then picks a name the server rejects — the failure
 * reads as operator error while both halves of the code review as correct.
 *
 * Quota is returned with it because the plan meters characters, not calls: an
 * operator about to spend the last of the month's budget should be able to see
 * that before pressing play, not discover it from a 401.
 */

export const maxDuration = 20;
export const dynamic = 'force-dynamic';

export interface VoiceOption { id: string; name: string; description: string }

/**
 * ElevenLabs names voices "Alice - Clear, Engaging Educator". The part before
 * the dash is the name; the rest is a description that belongs in the subtitle,
 * not crammed into a dropdown label.
 */
export function splitVoiceName(raw: string): { name: string; description: string } {
  const i = raw.indexOf(' - ');
  if (i === -1) return { name: raw.trim(), description: '' };
  return { name: raw.slice(0, i).trim(), description: raw.slice(i + 3).trim() };
}

/**
 * Use cases that suit a briefing read-out. An account carries character and
 * social-media voices too; offering "Fierce Warrior" for a reconnaissance
 * assessment is noise, so those are filtered out rather than ranked down.
 */
const BRIEFING_USE_CASES = new Set([
  'informative_educational', 'narrative_story', 'news', 'conversational', 'narration',
]);

/**
 * Labels are optional per-value, not just per-voice: ElevenLabs sets `accent`
 * on some voices and omits it on others, so the value type has to admit
 * undefined or every caller has to lie about the shape it received.
 */
export interface RawVoice {
  voice_id?: string;
  name?: string;
  /** premade | professional | cloned | generated — see selectBriefingVoices. */
  category?: string;
  labels?: Record<string, string | undefined>;
}

const useCaseOf = (v: RawVoice) => v.labels?.use_case || v.labels?.['use case'] || '';

/**
 * Measured on the live account 2026-09-04: 21 premade, 8 professional, 2 cloned.
 * `category` is the discriminator that use_case is not — "Gaming Russell" and
 * "Ms. Walker - Warm & Caring Southern Mom" are labelled `conversational` and
 * `narrative_story`, both perfectly good briefing use cases, so filtering on
 * use_case alone left them in a reconnaissance picker. They are `professional`:
 * marketplace clones the account can reach, not stock narration voices. The
 * account's own `cloned` entries (here "cc1" and "n8n") are test clones.
 */
const BRIEFING_CATEGORY = 'premade';

export function selectBriefingVoices(voices: RawVoice[]): VoiceOption[] {
  // If no voice reports a category, the field carries no information on this
  // account and filtering on it would empty the picker entirely.
  const accountCategorises = voices.some((v) => v.category);

  const out: VoiceOption[] = [];
  for (const v of voices) {
    if (!v.voice_id || !v.name) continue;
    if (accountCategorises && v.category !== BRIEFING_CATEGORY) continue;
    const useCase = useCaseOf(v);
    // An unlabelled voice on an otherwise-labelled account is not a briefing
    // voice; on an unlabelled account, labels prove nothing either way.
    if (useCase ? !BRIEFING_USE_CASES.has(useCase) : voices.some((x) => useCaseOf(x))) continue;
    const { name, description } = splitVoiceName(v.name);
    const accent = v.labels?.accent ? `${v.labels.accent} · ` : '';
    out.push({ id: v.voice_id, name, description: accent + (description || useCase) });
  }
  return out;
}

export async function GET() {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json({
      configured: false,
      reason: 'ELEVENLABS_API_KEY is not set in the app environment.',
      voices: [],
      quota: null,
    });
  }

  const headers = { 'xi-api-key': key };
  const [voicesRes, subRes] = await Promise.allSettled([
    fetch('https://api.elevenlabs.io/v1/voices', { headers, signal: AbortSignal.timeout(10000) }),
    fetch('https://api.elevenlabs.io/v1/user/subscription', { headers, signal: AbortSignal.timeout(10000) }),
  ]);

  let voices: VoiceOption[] = [];
  if (voicesRes.status === 'fulfilled' && voicesRes.value.ok) {
    const b = await voicesRes.value.json().catch(() => ({}));
    voices = selectBriefingVoices(b.voices || []);
  }

  let quota = null;
  if (subRes.status === 'fulfilled' && subRes.value.ok) {
    const s = await subRes.value.json().catch(() => ({}));
    if (typeof s.character_count === 'number' && typeof s.character_limit === 'number') {
      quota = {
        used: s.character_count,
        limit: s.character_limit,
        remaining: Math.max(0, s.character_limit - s.character_count),
        tier: s.tier || null,
        resetsAt: s.next_character_count_reset_unix
          ? new Date(s.next_character_count_reset_unix * 1000).toISOString()
          : null,
      };
    }
  }

  // Configured means the key is set AND the service answered with voices. A key
  // that is present but rejected must not render as a working picker.
  return NextResponse.json(
    { configured: voices.length > 0, voices, quota },
    { headers: { 'Cache-Control': 'private, max-age=300' } },
  );
}
