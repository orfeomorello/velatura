/**
 * The Style presets and the lookup helpers shared with the Edit tools.
 *
 * Prompt shape. Qwen-Image-2.1 reads an edit prompt as an instruction, not
 * as a description: one operation, the target named in plain words, and a
 * short preservation clause at the end. It does not expect a reference token
 * for the image it is editing, so no preset writes "Image 1": the model reads
 * that phrase literally instead of pointing at the slot, and the edit gets
 * vague. When several references are attached the model addresses them as
 * `<image1>`, `<image2>`, which is left to the user because these presets
 * change a single image.
 *
 * A preset is not a hidden pipeline: it writes the instruction into the
 * prompt box AND applies the parameters that go with it (edit strength,
 * negative prompt), both of which can then be edited by hand.
 */

import { EDIT_TOOL_PRESETS } from './edit-tools';

/** Families shown as headings in the Style panel. */
export type StyleGroup = 'Photography' | 'Illustration' | 'Quality';

export const STYLE_GROUPS: StyleGroup[] = ['Photography', 'Illustration', 'Quality'];

export interface QuickActionParams {
  /** Recommended denoising / edit strength (0.1–1.0) */
  denoising?: number;
  /** Negative prompt: a few terms aimed at this edit's failure mode */
  negativePrompt?: string;
  /** Whether face/subject detailer pass is recommended */
  detailer?: boolean;
  /** Whether hi-res pass is recommended */
  hires?: boolean;
}

export interface QuickAction {
  id: string;
  icon: string;
  label: string;
  /** short tooltip explaining what the action does */
  summary: string;
  /** heading used by the Style panel; Edit presets leave it undefined */
  group?: StyleGroup;
  /** the instruction written into the composer when clicked */
  prompt: string;
  /** automatic parameter adjustments applied when selecting this action */
  params: QuickActionParams;
}

/**
 * The Style presets: they change the look of the reference image, not its
 * content. Each one is a single operation plus what must stay the same.
 */
export const STYLE_ACTIONS: QuickAction[] = [
  {
    id: 'real-phone-photo',
    icon: '📱',
    group: 'Photography',
    label: 'Real Phone Photo',
    summary: 'Candid smartphone photo of a real person, replacing anime or illustration',
    prompt:
      'Turn the photo into a real phone snapshot: natural skin texture, real hair, ordinary daylight, no illustration. Keep the person, pose and background unchanged.',
    params: {
      denoising: 0.88,
      negativePrompt: 'anime, cartoon, illustration, airbrushed skin, oversized eyes',
    },
  },
  {
    id: 'pro-dslr-photo',
    icon: '📷',
    group: 'Photography',
    label: 'Pro DSLR Portrait',
    summary: 'Professional 85mm portrait with lifelike textures and soft background blur',
    prompt:
      'Turn the photo into a professional 85mm portrait: lifelike skin texture, soft background blur, studio light. Keep the person, pose and framing unchanged.',
    params: {
      denoising: 0.85,
      negativePrompt: 'anime, cgi, plastic skin, blurry',
    },
  },
  {
    id: 'anime-style',
    icon: '🎌',
    group: 'Illustration',
    label: 'Anime Style',
    summary: 'Modern Japanese anime illustration with cel shading',
    prompt:
      'Turn the photo into modern Japanese anime: crisp lineart, expressive eyes, cel shading, vibrant light. Keep the pose, outfit and framing unchanged.',
    params: {
      denoising: 0.85,
      negativePrompt: 'photorealistic, 3d render, skin pores, western comic',
    },
  },
  {
    id: 'cartoon-3d',
    icon: '🧸',
    group: 'Illustration',
    label: '3D Pixar / Cartoon',
    summary: 'Stylized 3D animated film frame with soft skin shading',
    prompt:
      'Turn the photo into a 3D animated film frame: soft skin shading, groomed hair, stylized proportions, warm rim light. Keep the pose and outfit unchanged.',
    params: {
      denoising: 0.85,
      negativePrompt: '2d, sketch, photorealistic, low poly',
    },
  },
  {
    id: 'enhance-details',
    icon: '✨',
    group: 'Quality',
    label: 'Enhance & Details',
    summary: 'Sharper textures and cleaner edges, composition untouched',
    prompt:
      'Sharpen the photo: finer skin and fabric texture, clean edges, balanced colour. Keep the subject, pose and composition unchanged.',
    params: {
      denoising: 0.55,
      negativePrompt: 'blurry, jpeg artifacts, distorted face, extra fingers',
    },
  },
  {
    id: 'cinematic-relight',
    icon: '🎬',
    group: 'Photography',
    label: 'Cinematic Relight',
    summary: 'Warm golden-hour cinema light, subject untouched',
    prompt:
      'Relight the scene with warm cinematic golden-hour light and soft shadows. Keep the subject, face and pose unchanged.',
    params: {
      denoising: 0.68,
      negativePrompt: 'flat lighting, overexposed, blurry',
    },
  },
  {
    id: 'oil-painting',
    icon: '🎨',
    group: 'Illustration',
    label: 'Oil Painting',
    summary: 'Classical oil painting with impasto brushwork',
    prompt:
      'Turn the photo into a classical oil painting: impasto brushstrokes, warm pigments, canvas texture, chiaroscuro light. Keep the pose and composition unchanged.',
    params: {
      denoising: 0.84,
      negativePrompt: 'digital photo, smooth plastic, anime',
    },
  },
  {
    id: 'boring-reality',
    icon: '🏠',
    group: 'Photography',
    label: 'Boring Reality Style',
    summary: 'Unpolished everyday snapshot, not a cinematic shot',
    prompt:
      'Turn the photo into an ordinary unpolished snapshot: flat daylight, phone noise, muted colours, no cinematic grading. Keep the person and pose unchanged.',
    params: {
      denoising: 0.72,
      negativePrompt: 'cinematic lighting, bokeh, airbrushed, hdr',
    },
  },
];

/**
 * Every preset changes the image being edited, so the Style list needs a
 * reference image. The number of images does not narrow it: a second
 * reference is extra content, not a different set of looks.
 */
export function getQuickActionsForCount(imageCount: number): QuickAction[] {
  return imageCount > 0 ? STYLE_ACTIONS : [];
}

export const ALL_PRESETS: QuickAction[] = [...STYLE_ACTIONS, ...EDIT_TOOL_PRESETS];

/** The preset a prompt was built from, if any (the prompt may carry a user suffix). */
export function findPreset(currentPrompt: string): QuickAction | undefined {
  const trimmed = currentPrompt.trim();
  if (!trimmed) return undefined;
  return ALL_PRESETS.find((action) => trimmed.startsWith(action.prompt));
}

/** A prompt is custom when the user wrote it, rather than a preset with an optional suffix. */
export function isCustomPrompt(currentPrompt: string): boolean {
  return currentPrompt.trim().length > 0 && findPreset(currentPrompt) === undefined;
}

/** Preset first, the user's own words after it: the "Add to the preset" choice. */
export function mergePresetPrompt(currentPrompt: string, action: QuickAction): string {
  const trimmed = currentPrompt.trim();
  return trimmed ? `${action.prompt} ${trimmed}` : action.prompt;
}

/**
 * Smartly apply a QuickAction prompt:
 * - If the current prompt is empty or starts with any known QuickAction prompt, replace the preset portion cleanly
 *   while preserving any custom user suffix appended after the preset.
 * - Otherwise replace with the chosen preset so clicking preset buttons switches cleanly between presets.
 */
export function applyQuickActionPrompt(currentPrompt: string, action: QuickAction): string {
  const trimmed = currentPrompt.trim();
  if (!trimmed) return action.prompt;
  const matchedPreset = findPreset(trimmed);
  if (matchedPreset) {
    const customSuffix = trimmed.slice(matchedPreset.prompt.length).trim();
    return customSuffix ? `${action.prompt} ${customSuffix}` : action.prompt;
  }
  return action.prompt;
}
