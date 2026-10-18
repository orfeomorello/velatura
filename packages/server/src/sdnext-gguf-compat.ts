/**
 * Velatura's narrowly-scoped SD.Next compatibility helper for Qwen-Image 2.1 GGUF.
 *
 * The helper is written into SD.Next's normal user-extension folder before Velatura
 * starts that engine. It does not replace or edit SD.Next files or model weights.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const QWEN21_GGUF_COMPAT_VERSION = '1.0.0';
export const QWEN21_GGUF_COMPAT_EXTENSION = 'velatura-qwen21-gguf-compat';
const MANAGED_MARKER = '# Velatura-managed Qwen-Image 2.1 GGUF compatibility helper';

/**
 * SD.Next's Diffusers GGUF loader leaves a small set of BF16 GGUF tensors outside
 * GGUFLinear in their packed representation. Qwen-Image 2.1 reads these tensors
 * directly as normalization weights, where the packed byte count is mistaken for
 * the logical element count. This callback materializes only those non-linear
 * GGUFParameter values as the engine's compute dtype; the large GGUFLinear weights
 * remain quantized and are untouched.
 */
export const QWEN21_GGUF_COMPAT_SOURCE = `${MANAGED_MARKER}
# Version: ${QWEN21_GGUF_COMPAT_VERSION}
# SPDX-License-Identifier: Apache-2.0

from modules import script_callbacks


def _velatura_qwen21_fix_gguf_non_linear_parameters(sd_model):
    transformer = getattr(sd_model, "transformer", None)
    if transformer is None or transformer.__class__.__name__ != "QwenImage21Transformer2DModel":
        return

    try:
        import torch
        from diffusers.quantizers.gguf.utils import GGUFLinear, GGUFParameter, dequantize_gguf_tensor
        from modules import devices
        from modules.logger import log
    except Exception as exc:
        try:
            from modules.logger import log
            log.warning(f"Velatura Qwen GGUF compatibility could not load its Diffusers helpers: {type(exc).__name__}: {exc}")
        except Exception:
            pass
        return

    compute_dtype = getattr(devices, "dtype", None)
    fixed = []
    for module_name, module in transformer.named_modules():
        if isinstance(module, GGUFLinear):
            continue
        for parameter_name, parameter in list(module.named_parameters(recurse=False)):
            if not isinstance(parameter, GGUFParameter):
                continue
            try:
                dense = dequantize_gguf_tensor(parameter)
                if compute_dtype is not None:
                    dense = dense.to(dtype=compute_dtype)
                if isinstance(dense, GGUFParameter):
                    dense = dense.as_subclass(torch.Tensor)
                setattr(module, parameter_name, torch.nn.Parameter(dense, requires_grad=False))
                fixed.append(f"{module_name}.{parameter_name}" if module_name else parameter_name)
            except Exception as exc:
                log.error(
                    f"Velatura Qwen GGUF compatibility could not dequantize "
                    f"{module_name}.{parameter_name}: {type(exc).__name__}: {exc}"
                )

    if fixed:
        log.info(
            f"Velatura Qwen GGUF compatibility dequantized {len(fixed)} non-linear parameter(s): "
            f"{', '.join(fixed[:8])}"
        )


script_callbacks.on_model_loaded(_velatura_qwen21_fix_gguf_non_linear_parameters)
`;

export interface Qwen21GgufCompatInstall {
  root: string;
  directory: string;
  scriptPath: string;
  changed: boolean;
}

export function qwen21GgufCompatScriptPath(root: string): string {
  return join(resolve(root), 'extensions', QWEN21_GGUF_COMPAT_EXTENSION, 'scripts', 'qwen21_gguf_compat.py');
}

/** Install/update only Velatura's own script; never replace an unrelated extension file. */
export async function installQwen21GgufCompat(root: string): Promise<Qwen21GgufCompatInstall> {
  const absoluteRoot = resolve(root);
  const scriptPath = qwen21GgufCompatScriptPath(absoluteRoot);
  const directory = dirname(dirname(scriptPath));
  let existing: string | undefined;
  try {
    existing = await readFile(scriptPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (existing !== undefined && !existing.startsWith(MANAGED_MARKER)) {
    throw new Error(`Velatura will not replace an unrelated SD.Next extension file: ${scriptPath}`);
  }
  if (existing === QWEN21_GGUF_COMPAT_SOURCE) {
    return { root: absoluteRoot, directory, scriptPath, changed: false };
  }

  await mkdir(dirname(scriptPath), { recursive: true });
  const temporaryPath = `${scriptPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, QWEN21_GGUF_COMPAT_SOURCE, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
    await rename(temporaryPath, scriptPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return { root: absoluteRoot, directory, scriptPath, changed: true };
}

/** True only for the exact Velatura-managed marker; used to avoid touching user files. */
export async function hasQwen21GgufCompat(root: string): Promise<boolean> {
  const scriptPath = qwen21GgufCompatScriptPath(root);
  if (!existsSync(scriptPath)) return false;
  try {
    return (await readFile(scriptPath, 'utf8')).startsWith(MANAGED_MARKER);
  } catch {
    return false;
  }
}

/** Remove Velatura's script, leaving any unrelated files and directories intact. */
export async function removeQwen21GgufCompat(root: string): Promise<boolean> {
  const scriptPath = qwen21GgufCompatScriptPath(root);
  let content: string;
  try {
    content = await readFile(scriptPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!content.startsWith(MANAGED_MARKER)) return false;

  await rm(scriptPath, { force: true });
  const scriptsDirectory = dirname(scriptPath);
  const extensionDirectory = dirname(scriptsDirectory);
  await rmdir(scriptsDirectory).catch(() => undefined);
  await rmdir(extensionDirectory).catch(() => undefined);
  return true;
}
