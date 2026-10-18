import { describe, expect, it } from 'vitest';
import { basename, displayModelName } from './paths.js';

describe('model path labels', () => {
  it('shows the selected Turbo variant instead of Velatura’s internal SD.Next alias', () => {
    expect(displayModelName('Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4 [a1b2c3]')).toBe('Qwen-Image-2.1-Turbo SDNQ UINT4');
    expect(displayModelName('Velatura-Qwen-Image-2.1-Turbo-BF16')).toBe('Qwen-Image-2.1-Turbo BF16');
  });

  it('keeps other model basenames unchanged', () => {
    expect(displayModelName('models/qwen-image-2.1-turbo-Q4_K_M.gguf')).toBe('qwen-image-2.1-turbo-Q4_K_M.gguf');
    expect(basename('C:\\models\\encoder.safetensors')).toBe('encoder.safetensors');
  });
});
