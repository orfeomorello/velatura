/**
 * Hardware detection.
 *
 * Honest by design: we report what we could read and *how*, and we never
 * guess a VRAM figure we could not measure.
 */
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { HardwareInfo } from './types.js';

const exec = promisify(execFile);

async function run(cmd: string, args: string[], timeout = 4000): Promise<string | undefined> {
  try {
    const { stdout } = await exec(cmd, args, { timeout });
    return stdout;
  } catch {
    return undefined;
  }
}

function vramFromBytes(bytes: number): number | undefined {
  if (!Number.isFinite(bytes) || bytes <= 0) return undefined;
  return Math.round((bytes / 1024 ** 3) * 10) / 10;
}

async function detectWindowsGpus(): Promise<Array<{ vendor: string; name: string; vramGb?: number; driver?: string }>> {
  const script =
    'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json -Compress';
  const out = await run('powershell', ['-NoProfile', '-Command', script], 8000);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out.trim()) as
      | { Name?: string; AdapterRAM?: number; DriverVersion?: string }
      | Array<{ Name?: string; AdapterRAM?: number; DriverVersion?: string }>;
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((g) => g.Name)
      .map((g) => {
        const name = g.Name!;
        const vendor = /nvidia/i.test(name) ? 'NVIDIA' : /amd|radeon/i.test(name) ? 'AMD' : /intel|arc/i.test(name) ? 'Intel' : 'unknown';
        // AdapterRAM is a 32-bit value: anything above 4 GB is reported as
        // 4294967295 and means "unknown", not "4 GB".
        const ram = g.AdapterRAM ?? 0;
        const vramGb = ram > 0 && ram < 0xfffffff0 ? vramFromBytes(ram) : undefined;
        return { vendor, name, vramGb, driver: g.DriverVersion };
      });
  } catch {
    return [];
  }
}

async function detectNvidia(): Promise<Array<{ vendor: string; name: string; vramGb?: number; driver?: string }>> {
  const out = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (!out) return [];
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name, mem] = line.split(',').map((s) => s.trim());
      return { vendor: 'NVIDIA', name: name ?? 'NVIDIA GPU', vramGb: mem ? Number(mem) / 1024 : undefined };
    });
}

async function detectLinuxGpus(): Promise<Array<{ vendor: string; name: string; vramGb?: number; driver?: string }>> {
  const gpus: Array<{ vendor: string; name: string; vramGb?: number; driver?: string }> = [];
  const vendorIds: Record<string, string> = { '0x8086': 'Intel', '0x1002': 'AMD', '0x10de': 'NVIDIA', '0x1a03': 'ASPEED' };

  try {
    const cards = await readdir('/sys/class/drm');
    for (const card of cards) {
      if (!/^card\d+$/.test(card)) continue;
      const device = join('/sys/class/drm', card, 'device');
      let vendor = 'unknown';
      try {
        const raw = (await readFile(join(device, 'vendor'), 'utf8')).trim();
        vendor = vendorIds[raw.toLowerCase()] ?? raw;
      } catch {
        continue;
      }
      if (vendor === 'ASPEED') continue;
      gpus.push({ vendor, name: `${vendor} GPU (${card})` });
    }
  } catch {
    /* not Linux, or no DRM devices */
  }

  // lspci gives the human readable name and sometimes the VRAM size
  const lspci = await run('lspci', ['-mm']);
  if (lspci) {
    for (const line of lspci.split('\n')) {
      if (!/VGA compatible controller|3D controller|Display controller/i.test(line)) continue;
      const vendor = /Intel/i.test(line) ? 'Intel' : /AMD|ATI/i.test(line) ? 'AMD' : /NVIDIA/i.test(line) ? 'NVIDIA' : 'unknown';
      const device = line.match(/Device:\s*"([^"]+)"/)?.[1];
      const mem = line.match(/Memory at\s+\S+\s+size=\s*(\d+)\s*(\w+)/i);
      let vramGb: number | undefined;
      if (mem?.[1] && mem[2]) {
        const value = Number(mem[1]);
        const unit = mem[2].toUpperCase();
        vramGb =
          unit.startsWith('G') ? value : unit.startsWith('M') ? value / 1024 : unit.startsWith('K') ? value / 1024 ** 2 : undefined;
      }
      const existing = gpus.find((g) => g.vendor === vendor);
      if (existing) {
        existing.name = device ?? existing.name;
        if (vramGb) existing.vramGb = vramGb;
      } else {
        gpus.push({ vendor, name: device ?? `${vendor} GPU`, vramGb });
      }
    }
  }
  return gpus;
}

async function detectMacGpus(): Promise<Array<{ vendor: string; name: string; vramGb?: number; driver?: string }>> {
  const out = await run('system_profiler', ['SPDisplaysDataType', '-json'], 8000);
  if (!out) return [];
  try {
    const parsed = JSON.parse(out) as {
      SPDisplaysDataType?: Array<{
        sppci_model?: string;
        _spdisplays_vram?: string;
        spdisplays_vram?: string;
        sppci_vram?: string;
      }>;
    };
    return (parsed.SPDisplaysDataType ?? []).map((g) => ({
      vendor: /apple/i.test(g.sppci_model ?? '') ? 'Apple' : 'unknown',
      name: g.sppci_model ?? 'GPU',
      vramGb:
        g.sppci_vram ?? g._spdisplays_vram ?? g.spdisplays_vram
          ? vramFromBytes(Number(String(g.sppci_vram ?? g._spdisplays_vram ?? g.spdisplays_vram).replace(/\D/g, '')))
          : undefined,
    }));
  } catch {
    return [];
  }
}

export type DetectedHardware = HardwareInfo & { notes: string[]; vramGb?: number };

/**
 * The hardware does not change while the program runs, but detecting it
 * costs a subprocess (lspci on Linux, PowerShell on Windows). The
 * interface asks for the health every few seconds, so the result is
 * cached for a while — and `fresh` asks for a new look.
 */
const CACHE_MS = 30_000;
let cache: { at: number; value: DetectedHardware } | undefined;

function copyOf(hw: DetectedHardware): DetectedHardware {
  return { ...hw, gpus: hw.gpus.map((g) => ({ ...g })), notes: [...hw.notes] };
}

export async function detectHardware(options?: { fresh?: boolean }): Promise<DetectedHardware> {
  if (!options?.fresh && cache && Date.now() - cache.at < CACHE_MS) {
    return copyOf(cache.value);
  }
  const value = await detectHardwareOnce();
  cache = { at: Date.now(), value };
  return copyOf(value);
}

/** Forget the cached detection (the hardware may have changed). */
export function invalidateHardwareCache(): void {
  cache = undefined;
}

async function detectHardwareOnce(): Promise<DetectedHardware> {
  const notes: string[] = [];
  const platform = process.platform;
  let gpus: Array<{ vendor: string; name: string; vramGb?: number; driver?: string }> = [];

  if (platform === 'win32') {
    gpus = await detectWindowsGpus();
    if (!gpus.length) notes.push('Windows GPU list not available (PowerShell query failed).');
    else notes.push('GPU list read with PowerShell; VRAM above 4 GB is not reported by Windows.');
  } else if (platform === 'darwin') {
    gpus = await detectMacGpus();
    if (!gpus.length) notes.push('macOS GPU list not available.');
  } else {
    gpus = await detectLinuxGpus();
    if (!gpus.length) notes.push('No GPU found through /sys/class/drm or lspci.');
  }

  if (!gpus.some((g) => g.vendor === 'NVIDIA')) {
    const nvidia = await detectNvidia();
    if (nvidia.length) gpus.push(...nvidia);
  }

  const knownVram = gpus.map((g) => g.vramGb).filter((v): v is number => typeof v === 'number');
  const vramGb = knownVram.length > 0 ? Math.max(...knownVram) : undefined;
  if (vramGb === undefined) {
    notes.push('VRAM size not detected: choose the profile manually.');
  }

  return {
    platform,
    arch: process.arch,
    cpuModel: cpus()[0]?.model ?? 'unknown CPU',
    totalMemGb: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
    gpus,
    hasGpu: gpus.length > 0,
    notes,
    vramGb,
  };
}


/**
 * Is there an Intel GPU on this machine?
 *
 * It matters because SD.Next needs `--use-ipex` on Intel Arc (Windows and
 * Linux): without it the engine falls back to the CPU.
 */
export function isIntelGpu(hw: { gpus?: Array<{ vendor?: string; name?: string }> }): boolean {
  return (hw.gpus ?? []).some((gpu) => /intel|arc/i.test(`${gpu.vendor ?? ''} ${gpu.name ?? ''}`));
}
