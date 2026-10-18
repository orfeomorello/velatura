/**
 * Validate the model roles selected by a profile before calling SD.Next.
 *
 * A Qwen GGUF file is a UNET/DiT component, not a base checkpoint. The base
 * model and each replaceable component must therefore be resolved separately.
 */
import { matchExactModel } from '@velatura/core';

/** SD.Next indexes local .safetensors text encoders by their filename stem. */
export function sdnextTextEncoderName(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  return base.replace(/\.safetensors$/i, '');
}

export interface ProfileModelSelection {
  expectedBase?: string;
  resolvedBase?: string;
  expectedDit?: string;
  resolvedDit?: string;
  expectedTextEncoder?: string;
  resolvedTextEncoder?: string;
  expectedVae?: string;
  resolvedVae?: string;
  explicitBase?: string;
}

export interface ProfileRuntimeState {
  expectedBase?: string;
  loadedBase?: string;
  selectedBase?: unknown;
  expectedPipeline?: string;
  loadedPipelineClass?: string;
  selectedPipeline?: unknown;
  expectedDit?: string;
  selectedDit?: unknown;
  expectedTextEncoder?: string;
  selectedTextEncoder?: unknown;
  expectedVae?: string;
  selectedVae?: unknown;
}

function selectedModelMatches(expected: string | undefined, actual: unknown): boolean {
  return expected === undefined ||
    (typeof actual === 'string' && Boolean(matchExactModel(expected, [actual])));
}

/** True only when SD.Next has the requested base, pipeline, and components active. */
export function profileRuntimeMatches(state: ProfileRuntimeState): boolean {
  if (state.expectedBase && !selectedModelMatches(state.expectedBase, state.loadedBase)) return false;
  if (state.expectedBase && !selectedModelMatches(state.expectedBase, state.selectedBase)) return false;
  if (state.expectedPipeline && state.selectedPipeline !== state.expectedPipeline) return false;
  if (
    (state.expectedPipeline === 'Qwen21' || state.expectedPipeline === 'Autodetect') &&
    state.loadedPipelineClass !== 'QwenImage21Pipeline'
  ) return false;
  if (!selectedModelMatches(state.expectedDit, state.selectedDit)) return false;
  if (!selectedModelMatches(state.expectedTextEncoder, state.selectedTextEncoder)) return false;
  if (!selectedModelMatches(state.expectedVae, state.selectedVae)) return false;
  return true;
}

/**
 * Pick a registered SD.Next alias that differs from the current option so
 * `override_settings` will cause a reload even when the same base is loaded
 * with the wrong pipeline or component selection.
 */
export function chooseCheckpointReloadAlias(aliases: Array<string | undefined>, current: unknown): string | undefined {
  const distinct = [...new Set(aliases.filter((alias): alias is string => Boolean(alias)))];
  const currentValue = typeof current === 'string' ? current : undefined;
  return distinct.find((alias) => alias !== currentValue) ?? distinct[0];
}

export function requireProfileModels(selection: ProfileModelSelection): void {
  const {
    expectedBase,
    resolvedBase,
    expectedDit,
    resolvedDit,
    expectedTextEncoder,
    resolvedTextEncoder,
    expectedVae,
    resolvedVae,
    explicitBase,
  } = selection;

  if (expectedDit && !expectedBase) {
    throw new Error(
      `The active profile requires the UNET/DiT component "${expectedDit}" but does not specify its SD.Next base checkpoint. Configure the profile base model (Qwen-Image-2.1). Velatura stopped before sending a generation request.`,
    );
  }

  if (expectedBase && explicitBase && !matchExactModel(expectedBase, [explicitBase])) {
    throw new Error(
      `The selected base model ("${explicitBase}") does not match the active profile's required base model ("${expectedBase}"). Choose the profile's Qwen-Image 2.1 base model. Velatura stopped before sending a generation request.`,
    );
  }

  if (expectedBase && resolvedBase && !matchExactModel(expectedBase, [resolvedBase])) {
    throw new Error(
      `SD.Next resolved "${resolvedBase}" instead of the active profile's required base model "${expectedBase}". Velatura stopped before sending a generation request.`,
    );
  }

  if (expectedBase && !resolvedBase) {
    throw new Error(
      `The active profile requires the SD.Next base model "${expectedBase}", but it is not listed in SD.Next's local model list. Install or import the base model before trying again. Velatura will not download it or use the currently loaded model as a fallback.`,
    );
  }

  if (expectedDit && !resolvedDit) {
    throw new Error(
      `SD.Next did not list the profile's UNET/DiT component "${expectedDit}" in /sdapi/v1/unets (or /sdapi/v1/unet). Confirm that the file is in SD.Next's models/UNET folder and refresh or restart SD.Next. Velatura stopped before sending a generation request.`,
    );
  }

  if (expectedTextEncoder && !resolvedTextEncoder) {
    throw new Error(
      `The profile's text encoder "${expectedTextEncoder}" is missing from SD.Next's models/Text-encoder folder. Install it in the expected folder, then retry. Velatura stopped before sending a generation request.`,
    );
  }

  if (expectedVae && !resolvedVae) {
    throw new Error(
      `SD.Next did not list the profile's VAE component "${expectedVae}" in /sdapi/v1/sd-vae. Confirm that the file is in SD.Next's models/VAE folder and refresh or restart SD.Next. Velatura stopped before sending a generation request.`,
    );
  }
}
