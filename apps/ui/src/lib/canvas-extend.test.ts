import { describe, expect, it } from 'vitest';
import {
  EXTEND_DENOISING,
  EXTEND_NEGATIVE,
  MAX_SIDE,
  extensionAction,
  extensionPrompt,
  planExtend,
} from './canvas-extend';

const words = (prompt: string) => prompt.split(/\s+/).filter(Boolean).length;

describe('Extending the canvas', () => {
  it('adds a quarter of the side, on the side the arrow points at', () => {
    const right = planExtend(1024, 1024, 'right')!;
    expect(right).toMatchObject({
      width: 1280,
      height: 1024,
      offsetX: 0,
      offsetY: 0,
      strip: { x: 1024, y: 0, width: 256, height: 1024 },
    });

    const left = planExtend(1024, 1024, 'left')!;
    expect(left).toMatchObject({
      width: 1280,
      offsetX: 256,
      strip: { x: 0, y: 0, width: 256, height: 1024 },
    });

    const down = planExtend(1280, 720, 'down')!;
    expect(down).toMatchObject({
      width: 1280,
      height: 896,
      offsetY: 0,
      strip: { x: 0, y: 720, width: 1280, height: 176 },
    });

    const up = planExtend(1280, 720, 'up')!;
    expect(up).toMatchObject({ height: 896, offsetY: 176, strip: { x: 0, y: 0, height: 176 } });
  });

  it('keeps every side a multiple of 16, for the common formats', () => {
    for (const [width, height] of [
      [1024, 1024],
      [1280, 720],
      [720, 1280],
      [832, 1216],
      [864, 1152],
      [1200, 1200],
    ] as const) {
      for (const direction of ['left', 'right', 'up', 'down'] as const) {
        const plan = planExtend(width, height, direction)!;
        expect(plan.width % 16, `${width}x${height} ${direction}`).toBe(0);
        expect(plan.height % 16, `${width}x${height} ${direction}`).toBe(0);
      }
    }
  });

  it('aligns the new side even when the photo is not aligned, without moving the photo', () => {
    const right = planExtend(1000, 900, 'right')!;
    expect(right.width).toBe(1264);
    expect(right.strip).toEqual({ x: 1000, y: 0, width: 264, height: 900 });
    const down = planExtend(1000, 900, 'down')!;
    expect(down.height).toBe(1136);
    expect(down.strip).toEqual({ x: 0, y: 900, width: 1000, height: 236 });
  });

  it('stops at the maximum side, and gives the last aligned step instead of overshooting', () => {
    expect(planExtend(2048, 1024, 'right')).toBeUndefined();
    expect(planExtend(1024, 2048, 'down')).toBeUndefined();
    const almost = planExtend(2000, 1000, 'right')!;
    expect(almost.width).toBe(2048);
    expect(almost.strip.width).toBe(48);
    // less than one aligned step of room: nothing to do
    expect(planExtend(2040, 1000, 'right')).toBeUndefined();
  });

  it('refuses sizes it cannot extend', () => {
    expect(planExtend(0, 0, 'right')).toBeUndefined();
    expect(planExtend(Number.NaN, 1024, 'right')).toBeUndefined();
    expect(planExtend(8, 1024, 'right')).toBeUndefined();
  });

  it('never asks for a camera move: it names the direction to extend', () => {
    expect(extensionPrompt('left')).toContain('to the left');
    expect(extensionPrompt('right')).toContain('to the right');
    expect(extensionPrompt('up')).toContain('upward');
    expect(extensionPrompt('down')).toContain('downward');
    for (const direction of ['left', 'right', 'up', 'down'] as const) {
      const prompt = extensionPrompt(direction);
      expect(prompt).not.toMatch(/turn|rotate|orbit|camera/i);
      expect(words(prompt)).toBeLessThanOrEqual(26);
      expect(prompt.endsWith('unchanged.')).toBe(true);
    }
  });

  it('runs as a preset with its own parameters, so prompt and strength stay visible', () => {
    const action = extensionAction('right');
    expect(action.id).toBe('extend-right');
    expect(action.prompt).toBe(extensionPrompt('right'));
    expect(action.params.denoising).toBe(EXTEND_DENOISING);
    expect(action.params.negativePrompt).toBe(EXTEND_NEGATIVE);
    expect(EXTEND_DENOISING).toBeGreaterThan(0);
    expect(EXTEND_DENOISING).toBeLessThanOrEqual(1);
    expect(MAX_SIDE).toBeGreaterThanOrEqual(1024);
    const ids = (['left', 'right', 'up', 'down'] as const).map((d) => extensionAction(d).id);
    expect(new Set(ids).size).toBe(4);
  });
});
