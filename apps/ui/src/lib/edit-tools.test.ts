import { describe, expect, it } from 'vitest';
import { STYLE_ACTIONS, applyQuickActionPrompt, getQuickActionsForCount } from './chips';
import { EDIT_TOOLS, EDIT_TOOL_PRESETS } from './edit-tools';

const words = (prompt: string) => prompt.split(/\s+/).filter(Boolean).length;

describe('Edit tools', () => {
  it('expose the six commands, each with presets', () => {
    expect(EDIT_TOOLS.map((t) => t.id)).toEqual([
      'rotate-subject',
      'change-pose',
      'remove-object',
      'add-element',
      'add-text',
      'canvas',
    ]);
    for (const tool of EDIT_TOOLS) expect(tool.presets.length).toBeGreaterThanOrEqual(2);
  });

  it('uses unique ids across edit presets and style actions', () => {
    const ids = [...EDIT_TOOL_PRESETS, ...STYLE_ACTIONS].map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('writes English prompts that restate what must not change', () => {
    for (const p of EDIT_TOOL_PRESETS) {
      expect(p.prompt).not.toMatch(/[àèéìòù]/);
      expect(p.prompt).toMatch(/unchanged\.$/);
      expect(p.label.length).toBeGreaterThan(2);
      expect(p.summary.length).toBeGreaterThan(10);
    }
  });

  it('stays direct: one sentence, no reference token, no colon placeholder left open', () => {
    for (const p of EDIT_TOOL_PRESETS) {
      expect(words(p.prompt)).toBeLessThanOrEqual(26);
      expect(p.prompt).not.toMatch(/Image\s*\d/i);
      expect(p.prompt).not.toMatch(/<image\d>/i);
      expect(p.prompt.trim().endsWith(':')).toBe(false);
      expect(p.prompt).not.toMatch(/the following/i);
    }
  });

  it('gives Add and Text a complete example, so one click always produces a working prompt', () => {
    const add = EDIT_TOOLS.find((tool) => tool.id === 'add-element')!;
    const text = EDIT_TOOLS.find((tool) => tool.id === 'add-text')!;
    expect(add.presets.every((p) => p.prompt.startsWith('Add '))).toBe(true);
    expect(text.presets.some((p) => p.prompt.includes('"HELLO"'))).toBe(true);
    // the quotes are what the user replaces, so at least the add examples are concrete objects
    expect(add.presets.map((p) => p.id)).toEqual(['add-cat', 'add-plant', 'add-cup']);
  });

  it('no preset prompt is a prefix of another (so the active state is unambiguous)', () => {
    for (const a of EDIT_TOOL_PRESETS)
      for (const b of EDIT_TOOL_PRESETS)
        if (a !== b) expect(b.prompt.startsWith(a.prompt)).toBe(false);
  });

  it('switching presets keeps the custom text the user appended', () => {
    const [left, right] = EDIT_TOOL_PRESETS;
    const edited = `${left!.prompt} wearing sunglasses`;
    expect(applyQuickActionPrompt(edited, right!)).toBe(`${right!.prompt} wearing sunglasses`);
    // and from an edit preset to a style action and back
    const style = STYLE_ACTIONS[0]!;
    expect(applyQuickActionPrompt(edited, style)).toBe(`${style.prompt} wearing sunglasses`);
  });

  it('keeps the Style presets available for any number of reference images', () => {
    const ids = getQuickActionsForCount(1).map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(['boring-reality']));
    expect(ids).not.toContain('image-expansion');
    expect(getQuickActionsForCount(2).map((a) => a.id)).toEqual(ids);
  });
});
