<script lang="ts">
  import { onMount } from 'svelte';
  import { api, formatBytes, type Job } from '../lib/api';
  import { clearStudioSession } from '../lib/studio';

  interface Paths {
    install: {
      app: string;
      config: string;
      history: string;
      images: string;
      logs: string;
      logFile: string;
      sdnext: string | null;
    };
    images: {
      dir: string;
      count: number;
      totalBytes: number;
      files: Array<{
        path: string;
        folder: string;
        name: string;
        sizeBytes: number;
        modifiedAt: string;
      }>;
    };
    partials: Array<{ path: string; sizeBytes: number }>;
  }

  let paths = $state<Paths | undefined>(undefined);
  let historyCount = $state(0);
  let busy = $state(false);
  let note = $state('');

  async function load() {
    try {
      const [p, h] = await Promise.all([
        api.get<Paths>('/api/v1/paths'),
        api.get<{ jobs: Job[] }>('/api/v1/history?limit=500').catch(() => ({ jobs: [] })),
      ]);
      paths = p;
      historyCount = h.jobs.length;
    } catch (err) {
      note = (err as Error).message;
    }
  }

  onMount(load);

  async function openFolder(path: string) {
    note = '';
    const result = await api.post<{ error?: string }>('/api/v1/open', { path });
    if (result.error) note = result.error;
  }

  async function clearHistory() {
    if (
      !confirm(
        'Securely overwrite and erase all saved prompts, request history, and SD.Next prompt logs (sdnext.log)?',
      )
    )
      return;
    busy = true;
    note = '';
    try {
      await api.post('/api/v1/history/clear', {});
      clearStudioSession();
      note = 'Prompt history and SD.Next engine logs were overwritten (zeros + random bytes) and wiped.';
      await load();
    } catch (err) {
      note = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function clearImages() {
    const count = paths?.images.count ?? 0;
    if (!count) return;
    if (!confirm(`Securely overwrite and delete all ${count} generated image(s) from disk and memory?`)) return;
    busy = true;
    note = '';
    try {
      const result = await api.post<{ deleted: number }>('/api/v1/images/clear', {});
      clearStudioSession();
      note = `${result.deleted} image(s) overwritten on disk and removed from RAM.`;
      await load();
    } catch (err) {
      note = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function removeSingleImage(path: string) {
    if (!confirm(`Securely overwrite and delete this image?\n\n${path}`)) return;
    busy = true;
    note = '';
    try {
      await api.delete('/api/v1/images', { path });
      note = 'Image securely overwritten and deleted.';
      await load();
    } catch (err) {
      note = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function clearTempAndLogs() {
    busy = true;
    note = '';
    try {
      const [partialsRes, logsRes] = await Promise.all([
        api.post<{ deleted: number }>('/api/v1/partials/clear', {}),
        api.post<{ deleted: number; wipedEngineLogs?: string[] }>('/api/v1/logs/clear', {}),
      ]);
      note = `Securely overwritten and cleaned ${partialsRes.deleted} temporary file(s) and ${logsRes.deleted} log file(s) (including sdnext.log).`;
      await load();
    } catch (err) {
      note = (err as Error).message;
    } finally {
      busy = false;
    }
  }

  async function cleanAllPrivacyData() {
    if (
      !confirm(
        'Securely overwrite (2-pass shred) and wipe ALL sensitive data?\n\n• Prompt & request history (history.jsonl)\n• SD.Next engine log (sdnext.log)\n• Generated images (disk + RAM)\n• Temporary .part files & Velatura logs\n\nYour installed AI models and SD.Next setup will NOT be touched.',
      )
    )
      return;
    busy = true;
    note = '';
    try {
      await Promise.all([
        api.post('/api/v1/history/clear', {}),
        api.post('/api/v1/images/clear', {}),
        api.post('/api/v1/partials/clear', {}),
        api.post('/api/v1/logs/clear', {}),
      ]);
      clearStudioSession();
      note = 'Secure wipe complete: all prompts, history, sdnext.log, images, and temporary files were overwritten and erased.';
      await load();
    } catch (err) {
      note = (err as Error).message;
    } finally {
      busy = false;
    }
  }
</script>

<h2>Privacy & Secure Wipe</h2>
<p class="subtitle">
  Velatura is 100% local. When you erase data here, files are not merely unlinked: they are
  <strong>overwritten on disk with 2 passes (zeros + cryptographic random bytes)</strong> before truncation and deletion,
  and SD.Next's own <span class="mono">sdnext.log</span> (which records encoded prompts) is wiped in place.
</p>

{#if note}
  <div class="notice ok small" style="margin-bottom:16px">{note}</div>
{/if}

{#if !paths}
  <div class="panel muted">Inspecting local data…</div>
{:else}
  <!-- Quick Clean All Banner -->
  <div class="panel privacy-hero">
    <div>
      <h3 class="panel-title">Secure Privacy Sweep (2-Pass Overwrite)</h3>
      <p class="muted small" style="margin:4px 0 0">
        Overwrite and destroy all prompt history, <strong>SD.Next engine logs (<span class="mono">sdnext.log</span>)</strong>,
        generated images (disk & RAM), interrupted <span class="mono">.part</span> files, and diagnostic logs.
        <strong>Your AI models and SD.Next installation are preserved.</strong>
      </p>
    </div>
    <button class="primary" disabled={busy} onclick={cleanAllPrivacyData}>
      Secure Wipe All Trace Data
    </button>
  </div>

  <div class="privacy-grid">
    <!-- 1. Prompts & History + sdnext.log -->
    <div class="panel privacy-card">
      <div>
        <div class="flex" style="justify-content:space-between">
          <h3 class="panel-title">Prompts, History & Engine Log</h3>
          <span class="badge">{historyCount} saved</span>
        </div>
        <p class="muted small">
          Shreds <span class="mono">{paths.install.history}</span>, clears in-memory session jobs, and overwrites SD.Next's
          <span class="mono">sdnext.log</span> so no encoded prompt text remains on disk.
        </p>
      </div>
      <div class="flex" style="margin-top:12px">
        <button class="ghost" disabled={busy} onclick={clearHistory}>
          Shred Prompts & Logs
        </button>
      </div>
    </div>

    <!-- 2. Generated Images -->
    <div class="panel privacy-card">
      <div>
        <div class="flex" style="justify-content:space-between">
          <h3 class="panel-title">Generated Images</h3>
          <span class="badge">{paths.images.count} files · {formatBytes(paths.images.totalBytes)}</span>
        </div>
        <p class="muted small">
          Stored in <span class="mono">{paths.images.dir}</span>. Overwrites image bytes before deletion and frees RAM copies. Reference images attached to prompts are never written to disk.
        </p>
      </div>
      <div class="flex" style="margin-top:12px;gap:8px">
        <button class="ghost" disabled={busy || paths.images.count === 0} onclick={clearImages}>
          Shred All Images
        </button>
        <button class="ghost small" onclick={() => openFolder(paths!.install.images)}>
          Open Folder
        </button>
      </div>
    </div>

    <!-- 3. Temporary Files & Diagnostic Logs -->
    <div class="panel privacy-card">
      <div>
        <div class="flex" style="justify-content:space-between">
          <h3 class="panel-title">Temporary Files & Diagnostic Logs</h3>
          <span class="badge">{paths.partials.length} partial file(s)</span>
        </div>
        <p class="muted small">
          Overwrites and removes interrupted downloads (<span class="mono">.part</span>), Velatura logs (<span class="mono">{paths.install.logFile}</span>), and <span class="mono">sdnext.log</span>.
        </p>
      </div>
      <div class="flex" style="margin-top:12px;gap:8px">
        <button class="ghost" disabled={busy} onclick={clearTempAndLogs}>
          Shred Temp Files & Logs
        </button>
        <button class="ghost small" onclick={() => openFolder(paths!.install.logs)}>
          Open Logs Folder
        </button>
      </div>
    </div>
  </div>

  {#if paths.images.files.length > 0}
    <div class="panel" style="margin-top:16px">
      <h3 class="panel-title">Individual Generated Images ({paths.images.count})</h3>
      <div class="filelist" style="margin-top:10px">
        {#each paths.images.files as image (image.path)}
          <div class="filerow">
            <div style="min-width:0">
              <div class="mono small" style="word-break:break-all">{image.name}</div>
              <div class="muted small">
                {formatBytes(image.sizeBytes)} · {new Date(image.modifiedAt).toLocaleString()}
              </div>
            </div>
            <div class="flex" style="gap:6px">
              <button class="ghost small" onclick={() => openFolder(image.folder)}>Open folder</button>
              <button class="ghost small" disabled={busy} onclick={() => removeSingleImage(image.path)}>Shred</button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}
{/if}
