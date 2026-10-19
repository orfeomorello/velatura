/**
 * The intent chips (§6.1, §6.2) and contextual Quick Actions for reference images.
 *
 * A chip or quick action is not a hidden pipeline: it writes a clear,
 * well-formed instruction into the prompt box AND applies recommended
 * generation parameters (edit strength, negative prompt, detailer) so
 * the model achieves the intended transformation right away.
 */

export interface Chip {
  id: string;
  label: string;
  /** what the chip writes, in the words of the spec */
  writes: string;
  /** the smallest number of reference images the sentence needs */
  minImages: number;
}

export interface QuickActionParams {
  /** Recommended denoising / edit strength (0.1–1.0) */
  denoising?: number;
  /** Recommended negative prompt to steer away from unwanted styles/artifacts */
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
  /** whether this action applies to a single image ('single') or 2+ images ('multi') */
  scope: 'single' | 'multi';
  /** the prompt written into the composer when clicked */
  prompt: string;
  /** automatic parameter adjustments applied when selecting this action */
  params: QuickActionParams;
}

/**
 * Contextual Quick Actions shown automatically when 1 reference image is attached.
 */
export const SINGLE_IMAGE_ACTIONS: QuickAction[] = [
  {
    id: 'real-phone-photo',
    icon: '📱',
    label: 'Real Phone Photo',
    summary:
      'Convert an anime, drawing, or illustration into a candid real-life smartphone photo of a real human (sets Edit Strength 0.88)',
    scope: 'single',
    prompt:
      'Convert Image 1 into an authentic, unretouched real-life smartphone camera photograph of a real human person. Completely remove all 2D anime linework, cel-shading, flat illustration colours, and stylized cartoon facial proportions. Replace with realistic human facial anatomy, natural human eye proportions, real skin texture with visible pores and slight natural imperfections, individual hair strands, realistic fabric weave, and natural ambient daylight, shot handheld on a modern iPhone 24mm f/1.8 main camera',
    params: {
      denoising: 0.88,
      negativePrompt:
        'anime, cartoon, 2d, illustration, drawing, cel shading, sketch, painting, cgi, 3d render, doll, plastic skin, airbrushed, oversized eyes, manga, lineart',
    },
  },
  {
    id: 'pro-dslr-photo',
    icon: '📷',
    label: 'Pro DSLR Portrait',
    summary:
      'Transform into a professional full-frame DSLR photograph with lifelike textures and optical bokeh (sets Edit Strength 0.85)',
    scope: 'single',
    prompt:
      'Transform Image 1 into a professional full-frame DSLR photograph shot on an 85mm f/1.4 prime lens. Convert any illustrated or synthetic surfaces into lifelike real-world materials, realistic human skin micro-texture with pores, natural hair strands, physically accurate studio lighting, and creamy optical depth-of-field bokeh while keeping the subject pose, outfit, and framing',
    params: {
      denoising: 0.85,
      negativePrompt:
        'anime, cartoon, 2d, illustration, drawing, cel shading, cgi, 3d render, plastic skin, wax figure, painting, low quality, blurry',
    },
  },
  {
    id: 'anime-style',
    icon: '🎌',
    label: 'Anime Style',
    summary:
      'Transform a photo into a high-budget modern Japanese anime illustration (sets Edit Strength 0.85)',
    scope: 'single',
    prompt:
      'Transform Image 1 into a high-budget modern Japanese anime illustration in the style of Makoto Shinkai and Ufotable. Convert real-life textures into crisp 2D hand-drawn anime lineart, expressive anime eyes with detailed iris highlights, clean cel-shaded skin and clothing folds, and vibrant cinematic anime lighting while preserving the exact character pose, expression, outfit, and framing',
    params: {
      denoising: 0.85,
      negativePrompt:
        'photorealistic, real photo, live action, 3d render, skin pores, noisy, blurry, western comic, ugly lineart',
    },
  },
  {
    id: 'cartoon-3d',
    icon: '🧸',
    label: '3D Pixar / Cartoon',
    summary:
      'Restyle into a stylized 3D animated movie frame with soft subsurface scattering (sets Edit Strength 0.85)',
    scope: 'single',
    prompt:
      'Transform Image 1 into a stylized 3D animated feature film frame in the style of Pixar and Disney Animation. Give the character expressive stylized 3D proportions, soft subsurface scattering on the skin, tactile groomed 3D hair, rich fabric shaders, and warm cinematic rim lighting while preserving the original pose, outfit, and framing',
    params: {
      denoising: 0.85,
      negativePrompt:
        '2d flat, sketch, photorealistic live action, grainy, low poly, blurry, watermark',
    },
  },
  {
    id: 'enhance-details',
    icon: '✨',
    label: 'Enhance & Details',
    summary:
      'Sharpen textures, facial clarity, and fine details while strictly keeping the original image intact (sets Edit Strength 0.55)',
    scope: 'single',
    prompt:
      'Enhance and restore Image 1 to ultra-high definition: sharpen blurry edges, refine facial features, enrich skin and fabric micro-textures, balance exposure and natural colour grading, and remove compression artifacts while strictly preserving the exact subject identity, pose, style, and composition unchanged',
    params: {
      denoising: 0.55,
      negativePrompt: 'blurry, lowres, jpeg artifacts, pixelated, distorted face, extra fingers, oversaturated',
    },
  },
  {
    id: 'cinematic-relight',
    icon: '🎬',
    label: 'Cinematic Relight',
    summary:
      'Relight the scene with dramatic golden-hour cinema atmosphere while keeping the subject intact (sets Edit Strength 0.68)',
    scope: 'single',
    prompt:
      'Keep the exact subject, identity, and pose of Image 1 intact, and relight the entire scene with dramatic cinematic golden-hour rim lighting, volumetric atmospheric rays, rich anamorphic film colour grading, and natural shadow falloff',
    params: {
      denoising: 0.68,
      negativePrompt: 'flat lighting, overexposed, washed out, blurry, deformed face',
    },
  },
  {
    id: 'clean-background',
    icon: '🧹',
    label: 'Clean Background',
    summary:
      'Remove distractions from the background while keeping the main subject untouched (sets Edit Strength 0.65)',
    scope: 'single',
    prompt:
      'Keep the main subject of Image 1 completely sharp and unchanged in the foreground, remove all distracting clutter, people, and objects from the background, and rebuild a clean, coherent backdrop with matching perspective and natural depth of field',
    params: {
      denoising: 0.65,
      negativePrompt: 'cluttered background, photobombers, text, watermark, blurry subject',
    },
  },
  {
    id: 'oil-painting',
    icon: '🎨',
    label: 'Oil Painting',
    summary:
      'Restyle into a classic museum oil painting with rich impasto brushwork (sets Edit Strength 0.84)',
    scope: 'single',
    prompt:
      'Transform Image 1 into a masterwork classical oil painting on canvas with visible thick impasto brushstrokes, rich warm oil pigments, fine canvas weave texture, and dramatic Rembrandt chiaroscuro lighting while preserving the subject pose and composition',
    params: {
      denoising: 0.84,
      negativePrompt: 'digital photo, flat vector, smooth plastic, anime, low quality',
    },
  },
];

/**
 * Contextual Quick Actions shown automatically when 2 (or more) reference images are attached.
 */
export const MULTI_IMAGE_ACTIONS: QuickAction[] = [
  {
    id: 'copy-pose',
    icon: '🕺',
    label: 'Copy Pose',
    summary:
      'Keep the character from Image 1 and put them into the exact pose of Image 2 (sets Edit Strength 0.82)',
    scope: 'multi',
    prompt:
      'Keep the exact face, identity, hair, and outfit of the character in Image 1, and place them into the exact body pose, limb position, gesture, and camera angle of the character in Image 2 with natural anatomy and consistent lighting',
    params: {
      denoising: 0.82,
      negativePrompt: 'deformed limbs, extra arms, extra fingers, bad anatomy, mismatched face, blurry',
    },
  },
  {
    id: 'character-swap',
    icon: '🔄',
    label: 'Character Swap',
    summary:
      'Replace the protagonist in Image 2 with the person/character from Image 1 (sets Edit Strength 0.80)',
    scope: 'multi',
    prompt:
      'Replace the main character in the scene of Image 2 with the person from Image 1. Strictly preserve the facial identity, hair, and features of Image 1 while matching the exact body pose, scene environment, camera perspective, and lighting of Image 2',
    params: {
      denoising: 0.8,
      negativePrompt: 'wrong face, double body, bad anatomy, mismatched lighting, pasted cutout look, blurry',
    },
  },
  {
    id: 'transfer-style',
    icon: '🎨',
    label: 'Transfer Style',
    summary:
      'Apply the artistic style and colour palette of Image 2 onto Image 1 (sets Edit Strength 0.84)',
    scope: 'multi',
    prompt:
      'Keep the exact subject, pose, and composition of Image 1, and render the entire image in the artistic medium, colour palette, lighting mood, and surface texture of Image 2',
    params: {
      denoising: 0.84,
      negativePrompt: 'inconsistent style, blurry, artifacts, deformed subject',
    },
  },
  {
    id: 'outfit-swap',
    icon: '👕',
    label: 'Outfit Swap',
    summary:
      'Dress the person of Image 1 in the clothing shown in Image 2 (sets Edit Strength 0.76)',
    scope: 'multi',
    prompt:
      'Keep the exact identity, face, hair, body pose, and background of the person in Image 1, and change their clothing so they are wearing the exact outfit, garment style, fabric texture, and accessories shown in Image 2 with natural folds and matching lighting',
    params: {
      denoising: 0.76,
      negativePrompt: 'changed face, deformed body, floating clothes, mismatched lighting, blurry',
    },
  },
  {
    id: 'combine-scene',
    icon: '🌄',
    label: 'Place in Scene',
    summary:
      'Place the subject of Image 1 into the background environment of Image 2 (sets Edit Strength 0.80)',
    scope: 'multi',
    prompt:
      'Extract the main subject from Image 1 keeping their exact identity, pose, and appearance, and place them naturally into the background environment of Image 2, harmonizing the perspective, scale, contact shadows, and ambient lighting so they seamlessly belong to the scene',
    params: {
      denoising: 0.8,
      negativePrompt: 'cutout halo, floating subject, mismatched lighting, wrong perspective, blurry',
    },
  },
];

/** Return the contextual Quick Actions appropriate for the current number of attached images. */
export function getQuickActionsForCount(imageCount: number): QuickAction[] {
  if (imageCount === 1) return SINGLE_IMAGE_ACTIONS;
  if (imageCount >= 2) return MULTI_IMAGE_ACTIONS;
  return [];
}

/**
 * Smartly apply a QuickAction prompt:
 * - If the current prompt is empty or starts with any known QuickAction prompt, replace the preset portion cleanly
 *   while preserving any custom user suffix appended after the preset.
 * - Otherwise replace with the chosen preset so clicking style buttons switches cleanly between styles.
 */
export function applyQuickActionPrompt(currentPrompt: string, action: QuickAction): string {
  const trimmed = currentPrompt.trim();
  if (!trimmed) return action.prompt;
  const allPresets = [...SINGLE_IMAGE_ACTIONS, ...MULTI_IMAGE_ACTIONS];
  const matchedPreset = allPresets.find((a) => trimmed.startsWith(a.prompt));
  if (matchedPreset) {
    const customSuffix = trimmed.slice(matchedPreset.prompt.length).trim();
    return customSuffix ? `${action.prompt} ${customSuffix}` : action.prompt;
  }
  return action.prompt;
}

/** The sentence a chip writes, given the number of reference images. */
export function chipSentence(chip: Chip, imageCount: number): string {
  const two = imageCount >= 2;
  const one = imageCount === 1;
  switch (chip.id) {
    case 'style':
      if (two) return 'apply the colour palette and the brushwork of Image 1 to the content of Image 2';
      if (one) return 'apply the colour palette and the brushwork of Image 1 to the subject';
      return 'in one consistent colour palette, with clean and deliberate brushwork';
    case 'pose':
      if (two) return 'keep the identity of the person in Image 1 and change the pose to the one in Image 2';
      if (one) return 'keep the identity of the person in Image 1 and change the pose';
      return 'in a natural, relaxed pose, with the weight of the body believable';
    case 'appearance':
      if (two) return 'keep the identity and the pose of Image 1, and change only the appearance to match Image 2';
      if (one) return 'keep the identity and the pose of Image 1, and change only the appearance';
      return 'in a natural, everyday appearance, with the skin and the hair believable';
    case 'remove':
      if (two) return 'remove the object shown in Image 1 from the scene of Image 2 and rebuild the area behind it';
      if (one) return 'remove the object shown in Image 1 and rebuild the area behind it';
      return 'remove the distracting element from the background and rebuild it';
    case 'add':
      if (two) return 'add the element shown in Image 2 into the scene of Image 1, in the same light and perspective';
      if (one) return 'add the described element into the scene of Image 1, in the same light and perspective';
      return 'add the described element into the scene, in the same light and perspective';
    case 'text':
      if (two) return 'reproduce the text of Image 2 in the same place and with the same style as in Image 1';
      if (one) return 'add the text in the same style as the reference, with the letters spelled correctly';
      return 'add the text with the letters spelled correctly, in the same style as the rest of the image';
    default:
      return chip.writes;
  }
}

export const CHIPS: Chip[] = [
  { id: 'style', label: 'style', writes: 'the palette and the brushwork of one image', minImages: 0 },
  { id: 'pose', label: 'pose', writes: 'the pose of one image, the identity of another', minImages: 0 },
  { id: 'appearance', label: 'appearance', writes: 'the appearance, keeping the identity', minImages: 0 },
  { id: 'remove', label: 'remove', writes: 'remove an object and rebuild what is behind it', minImages: 1 },
  { id: 'add', label: 'add', writes: 'add an element into the scene', minImages: 1 },
  { id: 'text', label: 'text', writes: 'reproduce a text in the same style', minImages: 1 },
];
