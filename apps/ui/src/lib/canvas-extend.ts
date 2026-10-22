/**
 * Extending the canvas in one direction.
 *
 * The camera orbit asked Qwen-Image 2.1 to invent a point of view it cannot
 * infer: the base model returns the picture it was given, and no wording moves
 * it (docs/qwen21-camera-orbit-notes.md, §3.1). The arrows are now used for
 * something the model can actually do: pad the picture on one side and ask it
 * to continue the scene there.
 *
 * The backend has no mask, so the whole canvas is regenerated at a moderate
 * denoise instead of inpainting only the new strip. To keep that plausible the
 * strip is pre-filled, in the browser, with the border of the photo stretched
 * and blurred: the model gets a colour and a light direction to continue,
 * instead of a black rectangle to guess. The subject stays where it is; the
 * new area is invented, which is the trade outpainting has always made.
 *
 * Every extension runs on the result of the previous one, and here that is
 * correct: the new strip is adjacent to the canvas it extends.
 */

import type { QuickAction } from './chips';

export type ExtendDirection = 'left' | 'right' | 'up' | 'down';

export interface ExtendSize {
  width: number;
  height: number;
}

export interface ExtendPlan {
  direction: ExtendDirection;
  /** the canvas after the extension */
  width: number;
  height: number;
  /** where the photo goes on the new canvas */
  offsetX: number;
  offsetY: number;
  /** the photo, in pixels */
  sourceWidth: number;
  sourceHeight: number;
  /** the area that has to be invented */
  strip: { x: number; y: number; width: number; height: number };
}

/** How much of the side is added per click. */
export const EXTEND_STEP = 0.25;
/** Bigger than this and the job becomes slow on the GPUs Velatura targets. */
export const MAX_SIDE = 2048;
/**
 * A quarter of the canvas is new, so the model needs room to paint, but the
 * three quarters that already exist should survive: lower than the preset that
 * expands both sides at once.
 */
export const EXTEND_DENOISING = 0.7;
export const EXTEND_NEGATIVE =
  'visible seam, black bars, duplicated subject, stretched subject, repeated pattern';

/**
 * SD.Next wants dimensions in steps of 8; 16 keeps every common pipeline happy
 * (720, 832, 864, 1024, 1280 are all multiples of 16).
 */
const ALIGN = 16;

const alignUp = (value: number) => Math.ceil(value / ALIGN) * ALIGN;

const DIRECTION_WORDS: Record<ExtendDirection, string> = {
  left: 'to the left',
  right: 'to the right',
  up: 'upward',
  down: 'downward',
};

/**
 * The new canvas, the position of the photo on it, and the strip to invent.
 * `undefined` when the photo cannot be extended: unreadable size, or already
 * at the limit on the side the arrow points at.
 */
export function planExtend(
  width: number,
  height: number,
  direction: ExtendDirection,
  step = EXTEND_STEP,
): ExtendPlan | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return undefined;
  if (width < ALIGN || height < ALIGN) return undefined;

  const horizontal = direction === 'left' || direction === 'right';
  const base = horizontal ? width : height;
  const wanted = Math.max(ALIGN, Math.round((base * step) / ALIGN) * ALIGN);
  const grow = Math.min(wanted, Math.floor((MAX_SIDE - base) / ALIGN) * ALIGN);
  if (grow < ALIGN) return undefined;

  // the new side is aligned too, and any pixel this adds belongs to the strip
  const nextWidth = horizontal ? alignUp(width + grow) : width;
  const nextHeight = horizontal ? height : alignUp(height + grow);
  const offsetX = direction === 'left' ? nextWidth - width : 0;
  const offsetY = direction === 'up' ? nextHeight - height : 0;

  const strip =
    direction === 'left'
      ? { x: 0, y: 0, width: offsetX, height }
      : direction === 'right'
        ? { x: width, y: 0, width: nextWidth - width, height }
        : direction === 'up'
          ? { x: 0, y: 0, width, height: offsetY }
          : { x: 0, y: height, width, height: nextHeight - height };

  return {
    direction,
    width: nextWidth,
    height: nextHeight,
    offsetX,
    offsetY,
    sourceWidth: width,
    sourceHeight: height,
    strip,
  };
}

/** The instruction for a direction: continue the scene, keep the subject. */
export function extensionPrompt(direction: ExtendDirection): string {
  return `Extend the photo ${DIRECTION_WORDS[direction]}, continue the scene beyond the original edge with the same light, colours and perspective, keep the subject unchanged.`;
}

/** The command the cross runs, shaped like every other preset. */
export function extensionAction(direction: ExtendDirection): QuickAction {
  return {
    id: `extend-${direction}`,
    icon: '🖼️',
    label: `Extend ${direction}`,
    summary: `Pad the canvas ${DIRECTION_WORDS[direction]} and continue the scene there`,
    prompt: extensionPrompt(direction),
    params: { denoising: EXTEND_DENOISING, negativePrompt: EXTEND_NEGATIVE },
  };
}

/** The real pixel size of a data URL, when the browser can read it. */
export function measureImage(source: string): Promise<ExtendSize | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve(undefined);
    image.src = source;
  });
}

/**
 * The padded image, ready to be the reference of the job.
 *
 * The strip is filled with the nearest column (or row) of the photo, stretched
 * across it and blurred, so the continuation starts from the colours and the
 * light that are already there. Canvas filters are not everywhere; without one
 * the stretched edge still works, just harder.
 */
export async function renderExtended(
  source: string,
  plan: ExtendPlan,
): Promise<string | undefined> {
  const image = await loadImage(source);
  if (!image) return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = plan.width;
  canvas.height = plan.height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;

  const { direction, strip, sourceWidth, sourceHeight } = plan;
  context.save();
  context.beginPath();
  context.rect(strip.x, strip.y, strip.width, strip.height);
  context.clip();
  // the column, or the row, of the photo nearest to the new area, stretched
  const edge =
    direction === 'left'
      ? { x: 0, y: 0, width: 1, height: sourceHeight }
      : direction === 'right'
        ? { x: sourceWidth - 1, y: 0, width: 1, height: sourceHeight }
        : direction === 'up'
          ? { x: 0, y: 0, width: sourceWidth, height: 1 }
          : { x: 0, y: sourceHeight - 1, width: sourceWidth, height: 1 };
  const drawStrip = () =>
    context.drawImage(
      image,
      edge.x,
      edge.y,
      edge.width,
      edge.height,
      strip.x,
      strip.y,
      strip.width,
      strip.height,
    );
  // twice: the sharp pass keeps the area opaque after JPEG export, the blurred
  // one softens the seam with the photo without leaving transparent corners
  drawStrip();
  context.filter = 'blur(28px)';
  drawStrip();
  context.restore();
  context.filter = 'none';

  context.drawImage(image, plan.offsetX, plan.offsetY, sourceWidth, sourceHeight);
  return canvas.toDataURL('image/jpeg', 0.95);
}

function loadImage(source: string): Promise<HTMLImageElement | undefined> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(undefined);
    image.src = source;
  });
}
