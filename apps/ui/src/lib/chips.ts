/**
 * The intent chips of the spec (§6.1, §6.2).
 *
 * A chip is not a pipeline and not a hidden model: it writes a
 * well-formed sentence in the box, and the user is free to edit it.
 * The sentence depends on how many reference images are in the job,
 * because "apply the style of Image 1 to Image 2" only makes sense
 * with two images.
 */

export interface Chip {
  id: string;
  label: string;
  /** what the chip writes, in the words of the spec */
  writes: string;
  /** the smallest number of reference images the sentence needs */
  minImages: number;
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
