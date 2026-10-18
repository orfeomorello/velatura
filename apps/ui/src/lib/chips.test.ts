import { describe, expect, it } from 'vitest';
import { CHIPS, chipSentence } from './chips';

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
