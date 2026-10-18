/**
 * Model manifest: the only thing we ship that describes the weights.
 * No weights, no binaries — just metadata: repo, pinned revision, file,
 * destination slot, size, sha256 and licence.
 */
import { parse as parseYaml } from 'yaml';
import type { ComponentRole, Manifest, ManifestEntry, SdnextSlot } from './types.js';

const SLOTS: SdnextSlot[] = ['UNET', 'Text-encoder', 'VAE', 'Lora'];
const ROLES: ComponentRole[] = ['dit', 'text-encoder', 'vae', 'lora', 'mmproj', 'unknown'];

export class ManifestError extends Error {}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(`manifest: "${field}" must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
}

function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ManifestError(`manifest: "${field}" must be a number`);
  }
  return value;
}

/**
 * A revision must be a *quoted* string in YAML: an unquoted 40-hex-digit
 * value is parsed as a number and silently loses precision.
 */
function requireRevision(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ManifestError(
      `manifest: "${field}" must be a quoted string (e.g. revision: "abc123…") — ` +
        'an unquoted value would be parsed as a number and lose precision',
    );
  }
  if (!/^[0-9a-f]{7,40}$/i.test(value)) {
    throw new ManifestError(`manifest: "${field}" must be a commit sha (7–40 hex characters)`);
  }
  return value;
}

export function parseManifest(text: string): Manifest {
  const raw = parseYaml(text) as unknown;
  if (!raw || typeof raw !== 'object') throw new ManifestError('manifest: not a mapping');
  const doc = raw as { version?: unknown; generatedAt?: unknown; models?: unknown };
  if (!Array.isArray(doc.models)) throw new ManifestError('manifest: "models" must be a list');

  const models: ManifestEntry[] = doc.models.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new ManifestError(`manifest: models[${index}] is not a mapping`);
    }
    const m = item as Record<string, unknown>;
    const dest = requireString(m.dest, `models[${index}].dest`) as SdnextSlot;
    if (!SLOTS.includes(dest)) {
      throw new ManifestError(`models[${index}].dest must be one of ${SLOTS.join(', ')}`);
    }
    const role = (m.role ?? 'unknown') as ComponentRole;
    if (!ROLES.includes(role)) {
      throw new ManifestError(`models[${index}].role must be one of ${ROLES.join(', ')}`);
    }
    const entry: ManifestEntry = {
      id: requireString(m.id, `models[${index}].id`),
      role,
      label: requireString(m.label, `models[${index}].label`),
      repo: requireString(m.repo, `models[${index}].repo`),
      revision: requireRevision(m.revision, `models[${index}].revision`),
      file: requireString(m.file, `models[${index}].file`),
      dest,
      sizeBytes: optionalNumber(m.sizeBytes, `models[${index}].sizeBytes`),
      sha256: optionalString(m.sha256, `models[${index}].sha256`),
      license: requireString(m.license, `models[${index}].license`),
      licenseUrl: optionalString(m.licenseUrl, `models[${index}].licenseUrl`),
      required: m.required === undefined ? true : Boolean(m.required),
    };
    if (m.note) entry.note = String(m.note);
    if (Array.isArray(m.alternatives)) {
      entry.alternatives = m.alternatives.map((a, ai) => {
        const alt = (a ?? {}) as Record<string, unknown>;
        return {
          file: requireString(alt.file, `models[${index}].alternatives[${ai}].file`),
          sizeBytes: optionalNumber(alt.sizeBytes, `models[${index}].alternatives[${ai}].sizeBytes`),
          sha256: optionalString(alt.sha256, `models[${index}].alternatives[${ai}].sha256`),
          note: alt.note ? String(alt.note) : undefined,
        };
      });
    }
    return entry;
  });

  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.id)) throw new ManifestError(`manifest: duplicate id "${m.id}"`);
    seen.add(m.id);
  }

  return {
    version: optionalNumber(doc.version, 'version') ?? 1,
    generatedAt: optionalString(doc.generatedAt, 'generatedAt'),
    models,
  };
}

export function findEntry(manifest: Manifest, id: string): ManifestEntry | undefined {
  return manifest.models.find((m) => m.id === id);
}

export function entriesForRole(manifest: Manifest, role: ComponentRole): ManifestEntry[] {
  return manifest.models.filter((m) => m.role === role);
}

/** Every file name that satisfies this entry (primary + known alternatives). */
export function knownFilesFor(entry: ManifestEntry): string[] {
  return [entry.file, ...(entry.alternatives ?? []).map((a) => a.file)];
}

/** Look up the expected size/sha of one of the known file names. */
export function expectationFor(
  entry: ManifestEntry,
  fileName: string,
): { sizeBytes?: number; sha256?: string } {
  if (entry.file === fileName) {
    return { sizeBytes: entry.sizeBytes, sha256: entry.sha256 };
  }
  const alt = entry.alternatives?.find((a) => a.file === fileName);
  return { sizeBytes: alt?.sizeBytes, sha256: alt?.sha256 };
}
