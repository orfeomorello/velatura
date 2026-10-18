/**
 * Matching a model file with the name the engine knows it by.
 *
 * SD.Next lists its models with its own naming (`/sdapi/v1/sd-models`), and
 * the name may carry a hash: `qwen-image-2.1-turbo-Q4_K_M.gguf [a1b2c3d4]`.
 * The manifest, on the other side, knows the file name. This module is the
 * bridge between the two, and it never guesses: if there is no match, it
 * says so.
 */

/** The last part of a path, with either separator. */
function baseName(name: string): string {
  return name.split(/[\\/]/).pop() ?? name;
}

/** Lowercase, without the extension, without the "[hash]" and without punctuation. */
export function normalizeModelName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, ' ')
    .trim()
    .replace(/\.(gguf|safetensors|safetensor|ckpt|pt|pth|bin)$/i, '')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * Find the model of the engine that corresponds to a file.
 *
 * The match is deliberately conservative: the engine's name must contain the
 * file's name (or the other way round), so `qwen-image-2.1-Q4_K_M` does not
 * match `qwen-image-2.1-turbo-Q4_K_M` by accident — the shorter one is not a
 * substring of the longer one in the right direction, but it is checked
 * explicitly below.
 */
export function matchCheckpoint(fileName: string, models: string[]): string | undefined {
  const wanted = normalizeModelName(baseName(fileName));
  if (!wanted) return undefined;

  // the engine writes the name of the model with the folder and with the
  // separator of its own system: on Windows it is a backslash. The folder
  // is left out, or the name of another model that has this one in it
  // would be taken for it.
  const exact = models.find((m) => normalizeModelName(baseName(m)) === wanted);
  if (exact) return exact;

  // the engine may write the name in its own way: "name [hash]" is already
  // normalized away, but the quantisation may be spelled differently
  // ("int8_convrot" against "int8"). A short common prefix is not enough.
  const contained = models.find((m) => {
    const candidate = normalizeModelName(baseName(m));
    if (candidate.length < 8 || wanted.length < 8) return false;
    return candidate.includes(wanted) || wanted.includes(candidate);
  });
  if (contained) return contained;

  // a last chance: the same file with a different quantisation is not the
  // same model, so we do not accept it
  return undefined;
}

/**
 * Match a base checkpoint/reference model by identity only.
 *
 * Unlike component matching, a base model must never use substring matching:
 * `Qwen-Image-2.1` must not silently resolve to `Qwen-Image-2.1-Turbo`.
 */
export function matchExactModel(name: string, models: string[]): string | undefined {
  const wanted = normalizeModelName(baseName(name));
  if (!wanted) return undefined;
  return models.find((model) => normalizeModelName(baseName(model)) === wanted);
}
