/**
 * The state of the model files, as the wizard needs it:
 * what is installed, where it should go, and whether it is usable.
 */
import { existsSync, statSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sdnextLauncherName, slotDir, slotPath } from './paths.js';
import type { ManifestEntry, ScanResult } from './types.js';
import { scanFile } from './scanner.js';
import { knownFilesFor } from './manifest.js';

export type ModelStatus = 'installed' | 'incompatible' | 'missing';

export interface ModelConflict {
  path: string;
  name: string;
  role: string;
  family?: string;
  variant?: string;
  reasons: string[];
}

export interface ModelState {
  entry: ManifestEntry;
  status: ModelStatus;
  /** files that sit in the same folder but are not what this component needs */
  conflicts: ModelConflict[];
  /** the file that is currently in place, if any */
  installedPath?: string;
  /** the file we would place */
  targetPath: string;
  /** semantic analysis of the installed file */
  scan?: ScanResult;
  /** the exact file name the user should put in the folder */
  expectedFile: string;
  /** every file name that satisfies this component */
  acceptableFiles: string[];
  sizeBytes?: number;
}

export async function modelState(root: string | undefined, entry: ManifestEntry): Promise<ModelState> {
  const acceptableFiles = knownFilesFor(entry);
  const expectedFile = entry.file.split('/').pop()!;
  const targetPath = root ? slotPath(root, entry.dest, expectedFile) : '';

  if (!root) {
    return { entry, status: 'missing', conflicts: [], targetPath, expectedFile, acceptableFiles };
  }

  const dir = slotDir(root, entry.dest);
  const conflicts = await findConflicts(dir, entry, acceptableFiles);

  for (const candidate of acceptableFiles) {
    const path = join(dir, candidate.split('/').pop()!);
    if (!existsSync(path)) continue;
    const scan = await scanFile(path);
    const status: ModelStatus = scan.compatible ? 'installed' : 'incompatible';
    return {
      entry,
      status,
      conflicts,
      installedPath: path,
      targetPath,
      scan,
      expectedFile,
      acceptableFiles,
      sizeBytes: (await stat(path)).size,
    };
  }

  return { entry, status: 'missing', conflicts, targetPath, expectedFile, acceptableFiles };
}

/**
 * Files that are in the right folder but are not the right component:
 * the 1.x VAE instead of the 2.1 one, the base model instead of the Turbo…
 * We look at the content, not at the name.
 */
function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index >= 0 ? name.slice(index).toLowerCase() : '';
}

function expectedName(entry: ManifestEntry): string {
  return entry.file.split('/').pop() ?? entry.file;
}

async function findConflicts(
  dir: string,
  entry: ManifestEntry,
  acceptableFiles: string[],
): Promise<ModelConflict[]> {
  if (!existsSync(dir)) return [];
  const names = await readdir(dir).catch(() => [] as string[]);
  const conflicts: ModelConflict[] = [];
  for (const name of names) {
    if (!/\.(gguf|safetensors)$/i.test(name)) continue;
    if (acceptableFiles.some((a) => a.split('/').pop() === name)) continue;
    const path = join(dir, name);
    const scan = await scanFile(path);
    if (scan.role !== entry.role) continue;
    const expected = expectedName(entry);
    const sameFormat = extensionOf(expected) === extensionOf(name);
    const reasons =
      scan.reasons.length > 0
        ? scan.reasons
        : !sameFormat
          ? [
              `different format: this is a ${extensionOf(name)} file, the active profile expects ${extensionOf(expected)} — ` +
                'it is a different checkpoint, not a substitute',
            ]
          : [
              scan.variant
                ? `this is the "${scan.variant}" variant — the active profile needs ${expected}`
                : `this file is not the component the active profile needs (${expected})`,
            ];
    conflicts.push({
      path,
      name,
      role: scan.role,
      family: scan.family,
      variant: scan.variant,
      reasons,
    });
  }
  return conflicts;
}

export async function modelStates(root: string | undefined, entries: ManifestEntry[]): Promise<ModelState[]> {
  const out: ModelState[] = [];
  for (const entry of entries) out.push(await modelState(root, entry));
  return out;
}

export interface SdnextValidation {
  ok: boolean;
  root: string;
  rootExists: boolean;
  markers: string[];
  modelsDir?: string;
  problems: string[];
  warnings: string[];
}

/** Check whether the path contains the platform's SD.Next startup script. */
export function validateSdnextRoot(root: string): SdnextValidation {
  const problems: string[] = [];
  const warnings: string[] = [];
  const markers: string[] = [];
  if (!root.trim()) {
    return { ok: false, root, rootExists: false, markers, problems: ['no path given'], warnings };
  }

  const pathExists = existsSync(root);
  let rootExists = false;
  try {
    rootExists = pathExists && statSync(root).isDirectory();
  } catch {
    rootExists = false;
  }
  if (!pathExists) {
    problems.push('this folder does not exist');
  } else if (!rootExists) {
    problems.push('this path is not a folder');
  } else if (!existsSync(join(root, sdnextLauncherName()))) {
    problems.push(`no ${sdnextLauncherName()} found in this folder`);
  } else if (!existsSync(join(root, 'launch.py'))) {
    problems.push('no launch.py found in this folder');
  } else {
    markers.push(sdnextLauncherName(), 'launch.py');
  }

  for (const marker of ['venv', 'config.json']) {
    if (existsSync(join(root, marker))) markers.push(marker);
  }

  const modelsDir = join(root, 'models');
  if (rootExists && markers.includes(sdnextLauncherName()) && !existsSync(join(root, 'venv'))) {
    warnings.push('the virtual environment has not been created yet; SD.Next may need several minutes on first start');
  }
  if (rootExists && !existsSync(modelsDir)) {
    // A fresh checkout is still usable: SD.Next creates this folder on first run.
    warnings.push('the models folder has not been created yet; SD.Next creates it on first run');
  }
  return { ok: problems.length === 0, root, rootExists, markers, modelsDir, problems, warnings };
}
