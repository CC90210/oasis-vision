import { describe, it, expect } from 'vitest';
import { splitVoiceName, selectBriefingVoices, type RawVoice } from './route';

describe('splitVoiceName', () => {
  it('separates the name from the description ElevenLabs appends', () => {
    expect(splitVoiceName('Alice - Clear, Engaging Educator'))
      .toEqual({ name: 'Alice', description: 'Clear, Engaging Educator' });
  });

  it('leaves a plain name alone', () => {
    expect(splitVoiceName('Rachel')).toEqual({ name: 'Rachel', description: '' });
  });

  it('does not split on a hyphen inside a name', () => {
    expect(splitVoiceName('Jean-Luc').name).toBe('Jean-Luc');
  });
});

describe('selectBriefingVoices', () => {
  const raw: RawVoice[] = [
    { voice_id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice - Clear, Engaging Educator', category: 'premade', labels: { accent: 'british', use_case: 'informative_educational' } },
    { voice_id: 'SOYHLrjzK2X1ezoPC6cr', name: 'Harry - Fierce Warrior', category: 'premade', labels: { accent: 'american', use_case: 'characters_animation' } },
    { voice_id: 'TX3LPaxmHKxFdv7VOQHJ', name: 'Liam - Energetic Creator', category: 'premade', labels: { use_case: 'social_media' } },
    { voice_id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George - Warm Storyteller', category: 'premade', labels: { use_case: 'narrative_story' } },
  ];

  it('keeps voices suited to a briefing and drops the rest', () => {
    const ids = selectBriefingVoices(raw).map(v => v.id);
    expect(ids).toContain('Xb7hH8MSUJpSbSDYk0k2');
    expect(ids).toContain('JBFqnCBsd6RMkjVDRZzb');
    expect(ids).not.toContain('SOYHLrjzK2X1ezoPC6cr'); // Fierce Warrior
    expect(ids).not.toContain('TX3LPaxmHKxFdv7VOQHJ'); // social media
  });

  /**
   * Every id offered must satisfy the pattern the speak route validates, or the
   * picker offers a choice the server silently swaps for the default.
   */
  it('offers only ids the speak route will accept', () => {
    for (const v of selectBriefingVoices(raw)) {
      expect(v.id, v.name).toMatch(/^[A-Za-z0-9]{20}$/);
    }
  });

  it('skips malformed entries rather than rendering a broken option', () => {
    expect(selectBriefingVoices([{ name: 'No id' }, { voice_id: 'x'.repeat(20) }])).toHaveLength(0);
  });

  /**
   * What an absent label means depends on whether the account labels anything.
   * Getting this backwards put the account's custom clones — "Gaming Russell",
   * "Ms. Walker - Warm & Caring Southern Mom" — into a reconnaissance briefing
   * picker on the live account.
   */
  it('keeps everything when the account neither categorises nor labels', () => {
    const kept = selectBriefingVoices([
      { voice_id: 'a'.repeat(20), name: 'Nova' },
      { voice_id: 'b'.repeat(20), name: 'Atlas' },
    ]);
    expect(kept).toHaveLength(2);
  });

  /**
   * The exact live-account failure. Filtering on use_case alone was not enough:
   * these two report `conversational` and `narrative_story`, both legitimate
   * briefing use cases. `category: professional` is what separates a
   * marketplace clone from a stock narration voice.
   */
  it('drops professional marketplace clones that carry briefing use cases', () => {
    const names = selectBriefingVoices([
      ...raw,
      { voice_id: 'z'.repeat(20), name: 'Gaming Russell', category: 'professional', labels: { use_case: 'conversational' } },
      { voice_id: 'y'.repeat(20), name: 'Ms. Walker – Warm & Caring Southern Mom', category: 'professional', labels: { use_case: 'narrative_story' } },
    ]).map(v => v.name);
    expect(names).toContain('Alice');
    expect(names).not.toContain('Gaming Russell');
    expect(names.some(n => /Ms\. Walker/.test(n))).toBe(false);
  });

  it('drops the account’s own unlabelled clones', () => {
    const names = selectBriefingVoices([
      ...raw,
      { voice_id: 'c'.repeat(20), name: 'cc1', category: 'cloned' },
      { voice_id: 'd'.repeat(20), name: 'n8n', category: 'cloned' },
    ]).map(v => v.name);
    expect(names).toEqual(['Alice', 'George']);
  });
});
