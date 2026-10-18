import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkDiskSpace, formatBytes, JsonlStore } from '../src/storage.js';
import { loadProfiles, parseProfiles } from '../src/profiles.js';

describe('jsonl store', () => {
  it('appends and reads back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-jsonl-'));
    const store = new JsonlStore<{ id: string }>(join(dir, 'history.jsonl'));
    await store.append({ id: 'a' });
    await store.append({ id: 'b' });
    const all = await store.readAll();
    expect(all.map((r) => r.id)).toEqual(['a', 'b']);
    expect((await store.read(1)).map((r) => r.id)).toEqual(['b']);
  });

  it('skips a broken line instead of losing everything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-jsonl-'));
    const path = join(dir, 'history.jsonl');
    await writeFile(path, '{"id":"a"}\n{"id":"b"\n{"id":"c"}\n', 'utf8');
    const store = new JsonlStore<{ id: string }>(path);
    expect((await store.readAll()).map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('rewrites the file without leaving a broken one behind', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-jsonl-'));
    const path = join(dir, 'history.jsonl');
    const store = new JsonlStore<{ id: string; files?: string[] }>(path);
    await store.append({ id: 'a', files: ['/store/a.png'] });
    await store.append({ id: 'b', files: ['/store/b.png'] });

    // a picture was deleted: the history must not point at it any more
    const records = await store.readAll();
    for (const record of records) {
      record.files = record.files?.filter((file) => file !== '/store/a.png');
    }
    await store.rewrite(records);

    const after = await store.readAll();
    expect(after.map((r) => r.id)).toEqual(['a', 'b']);
    expect(after[0]?.files).toEqual([]);
    expect(after[1]?.files).toEqual(['/store/b.png']);
    // the file is still a valid jsonl
    expect((await readFile(path, 'utf8')).split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('is empty when the file does not exist', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-jsonl-'));
    const store = new JsonlStore<{ id: string }>(join(dir, 'nope.jsonl'));
    expect(await store.readAll()).toEqual([]);
  });
});

describe('profiles', () => {
  it('reads the sampling and the extra passes from YAML', () => {
    const [profile] = parseProfiles(`
- id: test
  label: Test
  vramGb: 12
  steps: 6
  resolution: 768
  emphasis: speed
  sampling:
    samplerName: Euler
    cfgScale: 5.5
  post:
    hires:
      enabled: true
      scale: 2
      steps: 8
    detailer:
      enabled: true
      strength: 0.4
      steps: 12
  engine:
    args: ["--api", "--xpu"]
  models:
    - role: dit
      manifestId: dit-turbo-gguf-q4
`);
    expect(profile).toBeDefined();
    expect(profile!.sampling?.samplerName).toBe('Euler');
    expect(profile!.sampling?.cfgScale).toBe(5.5);
    expect(profile!.post?.hires?.enabled).toBe(true);
    expect(profile!.post?.hires?.scale).toBe(2);
    expect(profile!.post?.detailer?.steps).toBe(12);
    expect(profile!.engine?.args).toEqual(['--api', '--xpu']);
    expect(profile!.models[0]?.manifestId).toBe('dit-turbo-gguf-q4');
  });

  it('inherits the built-in Qwen base and pipeline for legacy YAML profiles missing both fields', () => {
    const [profile] = parseProfiles(`
- id: lowvram
  label: Low VRAM
  vramGb: 13
  steps: 8
  resolution: 1024
  emphasis: speed
  engine:
    args: ["--api"]
  models:
    - role: dit
      manifestId: dit-turbo-gguf-q4
`);
    expect(profile?.engine?.args).toEqual(['--api']);
    expect(profile?.engine?.pipeline).toBe('Autodetect');
    expect(profile?.engine?.checkpoint).toBe('Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4');
  });

  it('loads exactly the pinned Low SDNQ and Full BF16 YAML profiles', async () => {
    const dir = fileURLToPath(new URL('../../../profiles/', import.meta.url));
    const profiles = await loadProfiles(dir);
    expect(profiles.map((profile) => profile.id)).toEqual(['lowvram', 'full']);
    expect(profiles.map((profile) => profile.engine?.checkpoint)).toEqual([
      'Velatura-Qwen-Image-2.1-Turbo-SDNQ-UINT4',
      'Velatura-Qwen-Image-2.1-Turbo-BF16',
    ]);
    expect(profiles.map((profile) => profile.engine?.pipeline)).toEqual(['Autodetect', 'Autodetect']);
    for (const id of ['lowvram', 'full']) {
      const yaml = await readFile(join(dir, `${id}.yaml`), 'utf8');
      expect(yaml).toMatch(/pipeline:\s*["']?Autodetect/);
      expect(yaml).toMatch(/steps:\s*8/);
    }
  });

  it('ignores stale third-party and legacy profile YAML files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-profiles-'));
    await writeFile(
      join(dir, 'custom.yaml'),
      '- id: custom\n  label: Custom\n  vramGb: 20\n  steps: 4\n  resolution: 1024\n  emphasis: quality\n  models: []\n',
      'utf8',
    );
    await writeFile(join(dir, 'standard.yaml'), '- id: standard\n  label: Old\n  models: []\n', 'utf8');
    const profiles = await loadProfiles(dir);
    expect(profiles.map((profile) => profile.id)).toEqual(['lowvram', 'full']);
  });

  it('falls back to exactly the two built-in profiles when the folder is empty', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-profiles-'));
    const profiles = await loadProfiles(dir);
    expect(profiles.map((profile) => profile.id)).toEqual(['lowvram', 'full']);
  });
});

describe('disk space', () => {
  it('says when there is room', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-disk-'));
    const result = await checkDiskSpace(join(dir, 'model.safetensors'), 1024);
    expect(result.ok).toBe(true);
    expect(result.neededBytes).toBeGreaterThan(1024); // the margin
    expect(result.freeBytes).toBeGreaterThan(0);
  });

  it('refuses a file that does not fit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'velatura-disk-'));
    // more than any disk has
    const result = await checkDiskSpace(join(dir, 'model.safetensors'), 10 ** 15);
    expect(result.ok).toBe(false);
    expect(result.problem).toContain('not enough space');
  });

  it('does not block the download when the disk cannot be read', async () => {
    const result = await checkDiskSpace('/this/path/does/not/exist/model.safetensors', 1024);
    expect(result.ok).toBe(true);
  });

  it('formats the sizes in a readable way', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1.5e9)).toBe('1.50 GB');
  });
});
