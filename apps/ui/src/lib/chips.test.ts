import { describe, expect, it } from 'vitest';
import {
  STYLE_ACTIONS,
  STYLE_GROUPS,
  applyQuickActionPrompt,
  findPreset,
  getQuickActionsForCount,
  isCustomPrompt,
  mergePresetPrompt,
} from './chips';
import { EDIT_TOOL_PRESETS } from './edit-tools';

const words = (prompt: string) => prompt.split(/\s+/).filter(Boolean).length;

describe('the Style presets', () => {
  it('need a reference image but are not narrowed by how many are attached', () => {
    expect(getQuickActionsForCount(0)).toEqual([]);
    expect(getQuickActionsForCount(1)).toEqual(STYLE_ACTIONS);
    expect(getQuickActionsForCount(2)).toEqual(STYLE_ACTIONS);
    expect(getQuickActionsForCount(4)).toEqual(STYLE_ACTIONS);
  });

  it('are organised under headings that all have presets', () => {
    for (const action of STYLE_ACTIONS) {
      expect(STYLE_GROUPS).toContain(action.group);
    }
    for (const group of STYLE_GROUPS) {
      expect(STYLE_ACTIONS.filter((a) => a.group === group).length).toBeGreaterThan(0);
    }
  });

  it('no longer mix in edits of the content or of the canvas', () => {
    const ids = STYLE_ACTIONS.map((a) => a.id);
    expect(ids).not.toContain('clean-background');
    expect(ids).not.toContain('image-expansion');
    expect(ids).toContain('boring-reality');
  });

  it('carry tuned parameters inside the valid range', () => {
    for (const action of STYLE_ACTIONS) {
      expect(action.params.denoising).toBeGreaterThan(0);
      expect(action.params.denoising).toBeLessThanOrEqual(1);
      expect(action.params.negativePrompt?.length).toBeGreaterThan(10);
    }
  });
});

describe('the shape of a preset prompt', () => {
  const allPrompts = [...STYLE_ACTIONS, ...EDIT_TOOL_PRESETS];

  it('never names a reference slot', () => {
    // "Image 1" is read literally by the model and makes the instruction vague;
    // several references are addressed as <image1>, <image2> by the user instead.
    for (const preset of allPrompts) {
      expect(preset.prompt).not.toMatch(/Image\s*\d/i);
      expect(preset.prompt).not.toMatch(/<image\d>/i);
    }
  });

  it('stays short and closes with what must not change', () => {
    for (const preset of allPrompts) {
      expect(words(preset.prompt)).toBeLessThanOrEqual(30);
      expect(preset.prompt.trim().endsWith('.')).toBe(true);
      expect(preset.prompt).toMatch(/unchanged\.$/);
    }
  });

  it('spells the operation first, not a chain of requests', () => {
    const imperatives = /^(Add|Turn|Put|Give|Rest|Sit|Remove|Change|Expand|Reframe|Sharpen|Relight|Turn|Give)\b/;
    for (const preset of allPrompts) expect(preset.prompt).toMatch(imperatives);
  });
});

describe('recognising which preset a prompt came from', () => {
  const anime = STYLE_ACTIONS.find((a) => a.id === 'anime-style')!;
  const phone = STYLE_ACTIONS.find((a) => a.id === 'real-phone-photo')!;

  it('finds the preset of a prompt, with or without a user suffix', () => {
    expect(findPreset(anime.prompt)?.id).toBe('anime-style');
    expect(findPreset(`${anime.prompt}, wearing a red scarf`)?.id).toBe('anime-style');
    expect(findPreset('  ')).toBeUndefined();
    expect(findPreset('a photo of my cat')).toBeUndefined();
  });

  it('treats only user-written text as custom', () => {
    expect(isCustomPrompt('')).toBe(false);
    expect(isCustomPrompt('   ')).toBe(false);
    expect(isCustomPrompt(anime.prompt)).toBe(false);
    expect(isCustomPrompt(`${anime.prompt}, wearing a red scarf`)).toBe(false);
    expect(isCustomPrompt('a photo of my cat')).toBe(true);
  });

  it('merges the user text after the preset instead of replacing it', () => {
    expect(mergePresetPrompt('', anime)).toBe(anime.prompt);
    expect(mergePresetPrompt('  a red scarf  ', anime)).toBe(`${anime.prompt} a red scarf`);
  });

  it('switches cleanly between presets while preserving any custom user suffix', () => {
    const first = applyQuickActionPrompt('', anime);
    expect(first).toBe(anime.prompt);

    const withSuffix = `${first}, wearing a red scarf`;
    const switched = applyQuickActionPrompt(withSuffix, phone);
    expect(switched).toBe(`${phone.prompt} , wearing a red scarf`);
  });
});
