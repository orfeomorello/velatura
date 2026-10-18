/**
 * Small helpers for the paths the interface shows.
 *
 * The name of a model can arrive with the separator of the system it comes
 * from: a backslash on Windows, a slash on Linux. The interface shows the
 * name of the file, never the whole path.
 */

/** The last part of a path, with either separator. */
export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** The parent folder of a path, preserving its native separator. */
export function folderOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : path;
}

/** Hide Velatura's internal SD.Next alias from the user-facing model label. */
export function displayModelName(name: string): string {
  const base = basename(name);
  const withoutHash = base.replace(/\s*\[[^\]]*\]\s*$/, '').trim().toLowerCase();
  if (withoutHash === 'velatura-qwen-image-2.1-turbo') return 'Qwen-Image-2.1-Turbo';
  if (withoutHash === 'velatura-qwen-image-2.1-turbo-sdnq-uint4') return 'Qwen-Image-2.1-Turbo SDNQ UINT4';
  if (withoutHash === 'velatura-qwen-image-2.1-turbo-bf16') return 'Qwen-Image-2.1-Turbo BF16';
  return base;
}
