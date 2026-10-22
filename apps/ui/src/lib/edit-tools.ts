/**
 * Edit tools: changes to the subject, the content or the canvas, kept apart
 * from the Style presets. Each tool expands into a menu of preset prompts;
 * picking one writes it into the composer, where it can be edited.
 *
 * Prompt shape. Qwen-Image-2.1 follows an instruction, not a description:
 * one operation, the target named in plain words, and a short preservation
 * clause. That is why every prompt here is a single short sentence and none
 * of them says "Image 1": on a single-image edit the model already knows
 * which image it is working on, and the literal phrase makes the instruction
 * vague instead of more precise. With several references the model uses
 * `<image1>`, `<image2>`, which only the user can place correctly.
 *
 * Qwen-Image 2.1 is conservative: small changes keep the identity, large ones
 * tend to paste. The presets therefore ask for moderate changes and always
 * restate what must stay the same. Bigger rotations are best done in steps.
 */
import type { QuickAction } from './chips';

export interface EditTool {
  id: string;
  icon: string;
  label: string;
  summary: string;
  presets: QuickAction[];
}

/** What must not drift. Short on purpose: it is a clause, not a checklist. */
const KEEP_SUBJECT =
  'keep the same person, face, hairstyle, outfit and background unchanged';
const KEEP_SCENE = 'keep everything else unchanged';
const KEEP_PERSON = 'keep the person, face and background unchanged';

const ROTATE_NEGATIVE = 'different person, changed face, distorted face, blurry';

const POSE_NEGATIVE = 'different person, extra fingers, deformed hands, changed outfit';

const REMOVE_NEGATIVE = 'object still visible, ghost outline, smudged patch, visible seam';

const ADD_NEGATIVE = 'floating object, wrong scale, mismatched lighting, changed face';

const TEXT_NEGATIVE = 'misspelled letters, garbled text, blurred letters, wrong font';

const CANVAS_NEGATIVE = 'visible seam, black bars, duplicated subject, stretched';

/** A preset built from an instruction and the parameters that make it work. */
function preset(
  id: string,
  icon: string,
  label: string,
  summary: string,
  instruction: string,
  denoising: number,
  negativePrompt: string,
): QuickAction {
  return { id, icon, label, summary, prompt: instruction, params: { denoising, negativePrompt } };
}

function rotate(
  id: string,
  label: string,
  instruction: string,
  denoising: number,
): QuickAction {
  return preset(
    id,
    '🔄',
    label,
    instruction,
    `${instruction}, ${KEEP_SUBJECT}.`,
    denoising,
    ROTATE_NEGATIVE,
  );
}

function pose(
  id: string,
  label: string,
  instruction: string,
  denoising = 0.78,
): QuickAction {
  return preset(id, '🤸', label, instruction, `${instruction}, ${KEEP_SUBJECT}.`, denoising, POSE_NEGATIVE);
}

export const EDIT_TOOLS: EditTool[] = [
  {
    id: 'rotate-subject',
    icon: '🔄',
    label: 'Rotate Subject',
    summary: 'Turn the head or the body. For large angles, apply small steps one after another.',
    presets: [
      rotate('rotate-head-left', 'Head slightly left', 'Turn the head slightly to the left', 0.7),
      rotate('rotate-head-right', 'Head slightly right', 'Turn the head slightly to the right', 0.7),
      rotate('rotate-look-camera', 'Look at camera', 'Turn the head and eyes to look straight into the camera', 0.7),
      rotate('rotate-body-34-left', 'Three-quarter left', 'Turn the head and upper body three-quarters to the left', 0.8),
      rotate('rotate-body-34-right', 'Three-quarter right', 'Turn the head and upper body three-quarters to the right', 0.8),
      rotate('rotate-profile', 'Side profile (experimental)', 'Turn the person to a full side profile', 0.88),
    ],
  },
  {
    id: 'change-pose',
    icon: '🤸',
    label: 'Change Pose',
    summary: 'Change the body pose while keeping identity, outfit and scene.',
    presets: [
      pose('pose-hands-pockets', 'Hands in pockets', 'Put both hands in the pockets in a relaxed stance'),
      pose('pose-hand-hip', 'Hand on hip', 'Put one hand on the hip in a confident stance'),
      pose('pose-thumbs-up', 'Thumbs up', 'Give a thumbs up with one hand'),
      pose('pose-hand-chin', 'Hand on chin', 'Rest the chin on one hand in a thoughtful pose'),
      pose('pose-smile', 'Smile', 'Give a natural warm smile', 0.65),
      pose('pose-sitting', 'Sitting (experimental)', 'Sit the person down naturally on a chair in the same scene', 0.86),
    ],
  },
  {
    id: 'remove-object',
    icon: '🧽',
    label: 'Remove Object',
    summary: 'Take something out of the image and rebuild what was behind it.',
    presets: [
      preset(
        'remove-distraction',
        '🧽',
        'Distracting object',
        'Remove the most distracting object and rebuild the area behind it',
        `Remove the most distracting object and rebuild that area with the surrounding background, ${KEEP_SCENE}.`,
        0.8,
        REMOVE_NEGATIVE,
      ),
      preset(
        'remove-watermark',
        '🧾',
        'Watermark or caption',
        'Remove lettering, logos and watermarks without a trace',
        `Remove the watermark, logo or written text and rebuild the surface behind it, ${KEEP_SCENE}.`,
        0.78,
        REMOVE_NEGATIVE,
      ),
      preset(
        'remove-people',
        '👥',
        'People in the background',
        'Keep only the main subject, rebuild the scene behind the others',
        `Remove the other people in the background and rebuild the scene behind them, keep the main subject unchanged.`,
        0.8,
        REMOVE_NEGATIVE,
      ),
      preset(
        'clean-background',
        '🧹',
        'Clean background',
        'Keep the subject untouched, rebuild a tidy backdrop',
        `Remove all clutter from the background and rebuild a clean backdrop, keep the main subject unchanged.`,
        0.65,
        'cluttered background, photobombers, left-over object, blurry subject',
      ),
    ],
  },
  {
    id: 'add-element',
    icon: '➕',
    label: 'Add Element',
    summary: 'Add something to the scene. Pick an example, then swap the object for your own.',
    presets: [
      preset(
        'add-cat',
        '🐈',
        'Cat on the bed',
        'The simple pattern: one object, one place, keep the rest',
        `Add a big black cat on the bed, ${KEEP_PERSON}.`,
        0.78,
        ADD_NEGATIVE,
      ),
      preset(
        'add-plant',
        '🪴',
        'Potted plant',
        'Same pattern, a different object and place',
        `Add a green potted plant in the corner of the room, ${KEEP_PERSON}.`,
        0.75,
        ADD_NEGATIVE,
      ),
      preset(
        'add-cup',
        '☕',
        'Coffee cup',
        'Same pattern, a small object on a surface',
        `Add a white coffee cup on the table, ${KEEP_PERSON}.`,
        0.75,
        ADD_NEGATIVE,
      ),
    ],
  },
  {
    id: 'add-text',
    icon: '🔤',
    label: 'Text',
    summary: 'Add or replace text. Pick an example, then put your own words in the quotes.',
    presets: [
      preset(
        'text-add',
        '🔤',
        'Add text',
        'White letters on the wall: replace HELLO with your own words',
        `Add the text "HELLO" in white letters on the wall, keep the font clean and legible, ${KEEP_SCENE}.`,
        0.8,
        TEXT_NEGATIVE,
      ),
      preset(
        'text-replace',
        '✏️',
        'Replace existing text',
        'Same place, same style, new words',
        `Change the text to "HELLO", keeping the same font, colour and position, ${KEEP_SCENE}.`,
        0.8,
        TEXT_NEGATIVE,
      ),
    ],
  },
  {
    id: 'canvas',
    icon: '🖼️',
    label: 'Canvas',
    summary: 'Extend or reframe the image. Choose the format in the settings first.',
    presets: [
      preset(
        'canvas-expand',
        '🖼️',
        'Expand to the selected format',
        'Outpainting: continues the scene beyond the original borders',
        'Expand the image to fill the new canvas, continue the scene outward on every side, keep the subject and the light unchanged.',
        0.75,
        CANVAS_NEGATIVE,
      ),
      preset(
        'canvas-reframe',
        '✂️',
        'Reframe to the selected format',
        'Keeps the whole subject, rebuilds only the new area around the scene',
        'Reframe the image to the new canvas, keep the whole subject visible, rebuild only the new area around it and keep everything else unchanged.',
        0.72,
        CANVAS_NEGATIVE,
      ),
    ],
  },
];

export const EDIT_TOOL_PRESETS: QuickAction[] = EDIT_TOOLS.flatMap((t) => t.presets);
