import { NextResponse } from 'next/server';

/**
 * OASIS VISION — the command centre's voice.
 *
 * POST /api/voice/speak  { text, voiceId? }  ->  audio/mpeg
 *
 * A server-side proxy, and that is the whole architectural point: the browser
 * never sees ELEVENLABS_API_KEY. A key shipped to the client is a key published
 * — anyone with the page can read it out of the network tab and spend the
 * account's quota.
 *
 * The route reports its own limits honestly rather than failing opaquely:
 *   - no key configured        -> 503 with the variable name to set
 *   - text too long            -> 413 with the actual limit
 *   - quota exhausted upstream -> the upstream status and message, verbatim
 *
 * Quota matters here. The plan is metered in characters, not requests, so a
 * caller that re-speaks the same briefing twice pays twice. GET /api/voice
 * exposes the remaining balance so the UI can show it before spending it.
 */

export const maxDuration = 45;

/**
 * ElevenLabs bills per character, so an unbounded text field is an unbounded
 * bill. A spoken area assessment measures roughly 500-900 characters; this
 * leaves generous headroom without letting a pasted document drain the plan.
 */
const MAX_CHARS = 2500;

/**
 * Default voice: "Alice — Clear, Engaging Educator", labelled
 * informative_educational by ElevenLabs. Verified present on this account
 * 2026-09-04. A briefing voice should sound like a control room, not a podcast.
 */
const DEFAULT_VOICE = 'Xb7hH8MSUJpSbSDYk0k2';

/**
 * Flash v2.5 — the lowest-latency model on the account. A read-out that starts
 * two seconds after the click feels live; one that starts after eight does not.
 */
const MODEL = 'eleven_flash_v2_5';

/** ElevenLabs voice ids are 20 URL-safe characters. Validated, never interpolated raw. */
const VOICE_ID = /^[A-Za-z0-9]{20}$/;

export async function POST(request: Request) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) {
    return NextResponse.json(
      { error: 'Voice is not configured. Set ELEVENLABS_API_KEY in the app environment.' },
      { status: 503 },
    );
  }

  let body: { text?: string; voiceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const text = (body.text || '').trim();
  if (!text) return NextResponse.json({ error: 'text is required' }, { status: 400 });
  if (text.length > MAX_CHARS) {
    return NextResponse.json(
      { error: `text is ${text.length} characters; the limit is ${MAX_CHARS}`, limit: MAX_CHARS },
      { status: 413 },
    );
  }

  const voiceId = body.voiceId && VOICE_ID.test(body.voiceId) ? body.voiceId : DEFAULT_VOICE;

  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({
          text,
          model_id: MODEL,
          // Stability high, style low: a briefing should be evenly paced and
          // unperformed. The defaults are tuned for expressive narration.
          voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.0, use_speaker_boost: true },
        }),
        signal: AbortSignal.timeout(40000),
      },
    );

    if (!res.ok) {
      // Pass the upstream reason through. A generic "voice failed" hides the
      // one thing the operator needs to know — usually that the plan's
      // character quota for the month is spent.
      const detail = await res.text().catch(() => '');
      console.error('[OASIS] ElevenLabs error', res.status, detail.slice(0, 300));
      return NextResponse.json(
        { error: `Voice service returned ${res.status}`, detail: detail.slice(0, 400) },
        { status: res.status === 401 ? 502 : res.status },
      );
    }

    const audio = await res.arrayBuffer();
    return new NextResponse(audio, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audio.byteLength),
        'X-Characters-Billed': String(text.length),
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[OASIS] Voice synthesis failed:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Voice synthesis failed' },
      { status: 502 },
    );
  }
}
