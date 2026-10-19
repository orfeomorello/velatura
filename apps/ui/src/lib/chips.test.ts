import { describe, expect, it } from 'vitest';
import {
  CHIPS,
  MULTI_IMAGE_ACTIONS,
  SINGLE_IMAGE_ACTIONS,
  applyQuickActionPrompt,
  chipSentence,
  getQuickActionsForCount,
} from './chips';

describe('the intent chips', () => {
  it('writes a sentence that names the images it uses', () => {
    const style = CHIPS.find((c) => c.id === 'style')!;
    expect(chipSentence(style, 2)).toContain('Image 1');
    expect(chipSentence(style, 2)).toContain('Image 2');
    // with one image there is no "Image 2" to refer to
    expect(chipSentence(style, 1)).not.toContain('Image 2');
    expect(chipSentence(style, 1)).toContain('Image 1');
  });

  it('works without any reference image', () => {
    for (const chip of CHIPS) {
      const sentence = chipSentence(chip, 0);
      expect(sentence.length).toBeGreaterThan(10);
      expect(sentence).not.toContain('Image 1');
    }
  });

  it('never mentions an image that is not there', () => {
    for (const chip of CHIPS) {
      for (const count of [0, 1, 2, 3]) {
        const sentence = chipSentence(chip, count);
        const mentioned = (sentence.match(/Image \d/g) ?? []).map((m) => Number(m.split(' ')[1]));
        for (const index of mentioned) {
          expect(index).toBeLessThanOrEqual(count);
        }
      }
    }
  });

  it('asks for the images it really needs', () => {
    const remove = CHIPS.find((c) => c.id === 'remove')!;
    expect(remove.minImages).toBe(1);
    expect(CHIPS.find((c) => c.id === 'style')!.minImages).toBe(0);
  });
});

describe('contextual Quick Actions for reference images', () => {
  it('returns empty actions when 0 images are attached', () => {
    expect(getQuickActionsForCount(0)).toEqual([]);
  });

  it('returns single-image actions when 1 image is attached, with tuned parameters and no Image 2 reference', () => {
    const actions = getQuickActionsForCount(1);
    expect(actions.length).toBeGreaterThanOrEqual(6);
    expect(actions).toEqual(SINGLE_IMAGE_ACTIONS);
    const phonePhoto = actions.find((a) => a.id === 'real-phone-photo');
    expect(phonePhoto).toBeDefined();
    expect(phonePhoto?.params.denoising).toBeGreaterThanOrEqual(0.85);
    expect(phonePhoto?.params.negativePrompt).toContain('anime');

    for (const action of actions) {
      expect(action.prompt).toContain('Image 1');
      expect(action.prompt).not.toContain('Image 2');
      expect(action.params.denoising).toBeGreaterThan(0);
    }
  });

  it('returns multi-image fusion actions when 2 or more images are attached', () => {
    const actions = getQuickActionsForCount(2);
    expect(actions.length).toBeGreaterThanOrEqual(4);
    expect(actions).toEqual(MULTI_IMAGE_ACTIONS);
    for (const action of actions) {
      expect(action.prompt).toContain('Image 1');
      expect(action.prompt).toContain('Image 2');
      expect(action.params.denoising).toBeGreaterThan(0);
    }
  });

  it('switches cleanly between quick action presets while preserving any custom user suffix', () => {
    const anime = SINGLE_IMAGE_ACTIONS.find((a) => a.id === 'anime-style')!;
    const phone = SINGLE_IMAGE_ACTIONS.find((a) => a.id === 'real-phone-photo')!;
    const first = applyQuickActionPrompt('', anime);
    expect(first).toBe(anime.prompt);

    const withSuffix = `${first}, wearing a red scarf`;
    const switched = applyQuickActionPrompt(withSuffix, phone);
    expect(switched).toBe(`${phone.prompt} , wearing a red scarf`);
  });
});
