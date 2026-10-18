<script lang="ts">
  import { onMount } from 'svelte';
  import { api, formatBytes, sessionToken, type ManifestEntry, type ScanRow } from '../lib/api';

  interface Profile {
    id: string;
    label: string;
    description?: string;
    models: Array<{ role: string; manifestId: string; file?: string }>;
  }

  interface ModelState {
    entry: ManifestEntry;
    status: 'installed' | 'incompatible' | 'missing';
    installedPath?: string;
    targetPath: string;
    expectedFile: string;
    sizeBytes?: number;
    scan?: { reasons: string[]; role: string; quant?: string; variant?: string };
    conflicts?: Array<{ path: string; name: string; role: string; variant?: string; reasons: string[] }>;
  }

  interface SetupState {
    config: { profileId: string };
    profiles: Profile[];
    baseModel?: {
      name: string;
      engineReady: boolean;
      listed: boolean;
      loaded: boolean;
      loadedClass?: string;
      managedReference?: boolean;
      referencePrepared?: boolean;
    } | null;
    qwenTurboSupport?: {
      ready: boolean;
      status: 'ready' | 'missing' | 'checksum-mismatch';
      id: string;
      label: string;
      repo: string;
      revision: string;
      file: string;
      sizeBytes: number;
      sha256: string;
      license: string;
      licenseUrl: string;
      path?: string;
      source?: string;
      partialBytes?: number;
      actualSha256?: string;
    };
    models: ModelState[];
  }

  interface SelectedModel {
    profileModel: Profile['models'][number];
    model: ModelState;
  }

  interface ScanResponse {
    installed: ScanRow[];
    foreign: ScanRow[];
  }

  interface Download {
    id: string;
    manifestId: string;
    label: string;
    bytes: number;
    total?: number;
    state: 'running' | 'done' | 'error';
    error?: string;
  }

  interface PlacementCheck {
    status?: 'installed' | 'incompatible' | 'missing';
    targetPath?: string;
    installedPath?: string;
    scan?: { reasons: string[]; compatible: boolean };
    error?: string;
  }

  let setup = $state<SetupState | undefined>(undefined);
  let scan = $state<ScanResponse>({ installed: [], foreign: [] });
  let downloads = $state<Record<string, Download>>({});
  let placementChecks = $state<Record<string, PlacementCheck>>({});
  let busy = $state<string | undefined>(undefined);
  let checkingPlacement = $state<string | undefined>(undefined);
  let qwenSupportLicenseAccepted = $state(false);
  let qwenSupportBusy = $state(false);
  let qwenSupportError = $state('');

  async function load() {
    try {
      setup = await api.get<SetupState>('/api/v1/setup/state');
    } catch {
      setup = undefined;
    }
    try {
      scan = await api.get<ScanResponse>('/api/v1/models/scan');
    } catch {
      scan = { installed: [], foreign: [] };
    }
  }

  function selectedProfile(): Profile | undefined {
    if (!setup) return undefined;
    return setup.profiles.find((profile) => profile.id === setup?.config.profileId) ?? setup.profiles[0];
  }

  function selectedModelStates(): SelectedModel[] {
    const profile = selectedProfile();
    if (!profile || !setup) return [];
    const selected: SelectedModel[] = [];
    for (const profileModel of profile.models) {
      const model = setup.models.find((candidate) => candidate.entry.id === profileModel.manifestId);
      if (model) selected.push({ profileModel, model });
    }
    return selected;
  }

  function otherModelStates(): ModelState[] {
    const selectedIds = new Set(selectedModelStates().map((item) => item.model.entry.id));
    return (setup?.models ?? []).filter((model) => !selectedIds.has(model.entry.id));
  }

  onMount(() => {
    void load();
    const refreshProfile = () => void load();
    window.addEventListener('velatura:profile', refreshProfile);
    const events = new EventSource(`/api/v1/queue/events?token=${encodeURIComponent(sessionToken())}`);
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as { type: string; download?: Download };
        if (event.type === 'download' && event.download) {
          downloads = { ...downloads, [event.download.id]: event.download };
          if (event.download.state !== 'running') setTimeout(load, 400);
        }
      } catch {
        /* ignore */
      }
    };
    events.onerror = () => events.close();
    return () => {
      window.removeEventListener('velatura:profile', refreshProfile);
      events.close();
    };
  });

  async function download(entry: ManifestEntry) {
    busy = entry.id;
    try {
      await api.post('/api/v1/models/fetch', { manifestId: entry.id });
    } finally {
      busy = undefined;
    }
  }

  async function downloadQwenTurboSupport() {
    if (!qwenSupportLicenseAccepted) return;
    qwenSupportBusy = true;
    qwenSupportError = '';
    try {
      const result = await api.post<{ ready?: boolean; error?: string }>(
        '/api/v1/qwen/turbo-support/fetch',
        { confirm: true, acceptLicense: true },
      );
      if (result.error) qwenSupportError = result.error;
      await load();
    } catch (err) {
      qwenSupportError = (err as Error).message;
    } finally {
      qwenSupportBusy = false;
    }
  }

  async function checkPlacement(item: SelectedModel) {
    const id = item.model.entry.id;
    checkingPlacement = id;
    placementChecks = { ...placementChecks, [id]: {} };
    try {
      const profile = selectedProfile();
      const result = await api.post<PlacementCheck>('/api/v1/models/check-placement', {
        manifestId: id,
        profileId: profile?.id,
      });
      placementChecks = { ...placementChecks, [id]: result };
      if (result.status === 'installed') await load();
    } catch (err) {
      placementChecks = { ...placementChecks, [id]: { error: (err as Error).message } };
    } finally {
      checkingPlacement = undefined;
    }
  }
</script>

<h2>Models</h2>
<p class="subtitle">
  This page follows the selected profile. It shows only the files that profile needs; other model
  variants are kept in a separate, collapsed list. Licences are shown beside each download.
</p>

{#if !setup}
  <div class="panel"><p class="muted">Could not load the model status. Check that SD.Next is configured, then reload this page.</p></div>
{:else if !selectedProfile()}
  <div class="panel"><p class="muted">No profile is configured yet. Choose one in Setup first.</p></div>
{:else}
  <div class="panel">
    <h3 style="margin:0 0 6px;font-size:15px">{selectedProfile()?.label}</h3>
    <p class="muted small" style="margin:0 0 12px">
      {selectedProfile()?.description} The table below is the complete component list for this profile.
      The other Turbo variants are not required.
    </p>
    {#if setup.baseModel}
      <div class="notice" style="margin:0 0 14px">
        <strong>{setup.baseModel.managedReference ? `Velatura-managed ${setup.baseModel.name} reference` : `Separate SD.Next base model: ${setup.baseModel.name}`}</strong>
        {#if setup.baseModel.managedReference}
          {#if !setup.qwenTurboSupport?.ready}
            <div class="small" style="margin-top:4px">
              Velatura needs one small tokenizer support file ({formatBytes(setup.qwenTurboSupport?.sizeBytes ?? 11_422_650)}) to assemble the Diffusers reference. This is not a model-weight file. Your installed DiT, text encoder and VAE are reused; the full Qwen base weights are not downloaded.
            </div>
            {#if setup.qwenTurboSupport}
              <div class="model-meta" style="margin-top:6px">
                <span>Licence: {setup.qwenTurboSupport.license}</span>
                <a href={setup.qwenTurboSupport.licenseUrl} target="_blank" rel="noreferrer">Read terms</a>
                <span>{setup.qwenTurboSupport.repo} · {setup.qwenTurboSupport.file}</span>
              </div>
              <div class="model-hash-line mono" style="margin-top:4px;overflow-wrap:anywhere">SHA-256: {setup.qwenTurboSupport.sha256}</div>
              {#if setup.qwenTurboSupport.status === 'checksum-mismatch'}
                <div class="small" style="margin-top:4px">A local copy did not match the pinned checksum. A new copy is promoted only after verification succeeds.</div>
              {/if}
              {#if setup.qwenTurboSupport.partialBytes}
                <div class="small" style="margin-top:4px">A partial download can be resumed ({formatBytes(setup.qwenTurboSupport.partialBytes)}).</div>
              {/if}
              <label class="small" style="display:flex;gap:8px;align-items:flex-start;margin-top:8px">
                <input type="checkbox" bind:checked={qwenSupportLicenseAccepted} />
                <span>I have reviewed the Qwen Research License and accept its non-commercial terms for this support-file download.</span>
              </label>
              <button class="primary" style="margin-top:8px" disabled={!qwenSupportLicenseAccepted || qwenSupportBusy} onclick={downloadQwenTurboSupport}>
                {qwenSupportBusy ? 'Downloading…' : 'Download Qwen Turbo support file'}
              </button>
              {@const supportDownload = Object.values(downloads).find((item) => item.manifestId === setup.qwenTurboSupport?.id)}
              {#if supportDownload?.state === 'running'}
                <div class="small" style="margin-top:6px">Downloading {formatBytes(supportDownload.bytes)} of {formatBytes(supportDownload.total ?? setup.qwenTurboSupport.sizeBytes)}…</div>
              {:else if supportDownload?.state === 'error'}
                <div class="notice err small" style="margin-top:6px">{supportDownload.error ?? 'The download failed.'}</div>
              {/if}
              {#if qwenSupportError}<div class="notice err small" style="margin-top:6px">{qwenSupportError}</div>{/if}
            {/if}
          {:else}
            <div class="small" style="margin-top:4px">
              The tokenizer is verified. When the managed engine starts, Velatura prepares this local reference automatically from the installed profile components. The full Qwen base model is not required.
            </div>
            {#if setup.qwenTurboSupport?.path}<code class="model-full-path">Verified support file: {setup.qwenTurboSupport.path}</code>{/if}
            {#if setup.baseModel.referencePrepared && setup.baseModel.listed}<div class="small" style="margin-top:4px">The local reference has been prepared and indexed by SD.Next.</div>{/if}
          {/if}
        {:else if !setup.baseModel.engineReady}
          <div class="small" style="margin-top:4px">Start the managed engine from Velatura to prepare the profile's local reference automatically.</div>
        {:else if !setup.baseModel.listed}
          <div class="small" style="margin-top:4px">This SD.Next instance does not list the required reference. Start the managed engine from Velatura; no other model will be substituted.</div>
        {:else if setup.baseModel.loaded}
          <div class="small" style="margin-top:4px">SD.Next currently reports this base as loaded{#if setup.baseModel.loadedClass} ({setup.baseModel.loadedClass}){/if}.</div>
        {:else}
          <div class="small" style="margin-top:4px">Listed locally but not loaded. Velatura verifies the pipeline and components before generation.</div>
        {/if}
      </div>
    {/if}
    <div class="model-table-wrap">
      <table class="model-table">
        <colgroup>
          <col style="width:22%" />
          <col style="width:15%" />
          <col style="width:22%" />
          <col style="width:17%" />
          <col style="width:24%" />
        </colgroup>
        <thead>
          <tr>
            <th>Model</th>
            <th>Status</th>
            <th>File to use</th>
            <th>SD.Next folder</th>
            <th class="right">Choose how to add it</th>
          </tr>
        </thead>
        <tbody>
          {#each selectedModelStates() as selected (selected.model.entry.id)}
            {@const model = selected.model}
            {@const entry = model.entry}
            {@const dl = Object.values(downloads).find((item) => item.manifestId === entry.id)}
            {@const check = placementChecks[entry.id]}
            <tr>
              <td>
                <div class="model-component-name">{entry.label}</div>
                <div class="model-meta">
                  {#if entry.required === false}<span class="badge">Optional</span>{:else}<span>Required</span>{/if}
                  <span>{formatBytes(entry.sizeBytes)}</span>
                </div>
                <div class="model-meta">
                  <span>Licence: {entry.license}</span>
                  {#if entry.licenseUrl}
                    <a href={entry.licenseUrl} target="_blank" rel="noreferrer">Read terms</a>
                  {/if}
                </div>
                <div class="model-hash-line mono" title={entry.sha256 ?? 'No checksum listed'}>
                  SHA-256: {entry.sha256 ?? 'not listed in the manifest'}
                </div>
                {#if entry.license === 'unknown'}
                  <div class="notice small model-license-warning">
                    ⚠ Licence not declared. Review the model card before use. This file is optional.
                  </div>
                {/if}
                {#if entry.note}
                  <details class="model-details">
                    <summary>About this file</summary>
                    <div style="margin-top:4px">{entry.note}</div>
                  </details>
                {/if}
              </td>
              <td>
                {#if dl && dl.state === 'running'}
                  <span class="badge warn">Downloading {Math.round((dl.bytes / (dl.total || dl.bytes || 1)) * 100)}%</span>
                {:else if model.status === 'installed'}
                  <span class="badge ok">Ready</span>
                  <div class="model-status-note">A compatible file is in place.</div>
                {:else if model.status === 'incompatible'}
                  <span class="badge warn">Needs attention</span>
                  <div class="model-status-note">The file found cannot be used by this profile.</div>
                  {#if model.scan?.reasons.length}
                    <details class="model-details">
                      <summary>Technical details</summary>
                      {#each model.scan.reasons as reason}<div style="margin-top:4px">{reason}</div>{/each}
                    </details>
                  {/if}
                {:else}
                  <span class="badge">Not installed</span>
                {/if}
              </td>
              <td>
                <span class="model-file-line mono" title={model.expectedFile}>{model.expectedFile}</span>
              </td>
              <td>
                <div class="model-destination">SD.Next · models/{entry.dest}/</div>
                <details class="model-details">
                  <summary>Show full path</summary>
                  <code class="model-full-path">{model.targetPath || 'SD.Next folder not configured'}</code>
                </details>
              </td>
              <td>
                <div class="model-actions">
                  <button class="primary model-action" disabled={busy === entry.id} onclick={() => download(entry)}>
                    {dl && dl.state === 'running' ? 'Downloading…' : 'Download'}
                  </button>
                  <button
                    class="primary model-action"
                    disabled={checkingPlacement === entry.id}
                    onclick={() => checkPlacement(selected)}
                  >
                    {checkingPlacement === entry.id ? 'Checking…' : 'Check folder'}
                  </button>
                </div>
                {#if check?.error}
                  <div class="notice err small model-check-result">{check.error}</div>
                {:else if check?.status === 'installed'}
                  <div class="notice ok small model-check-result">
                    Found and compatible in this folder.
                    <code class="model-full-path">{check.installedPath ?? check.targetPath ?? model.targetPath}</code>
                  </div>
                {:else if check?.status === 'incompatible'}
                  <div class="notice err small model-check-result">
                    A file is present, but it cannot be used for this profile.
                    {#if check.scan?.reasons.length}
                      <details class="model-details">
                        <summary>Technical details</summary>
                        {#each check.scan.reasons as reason}<div style="margin-top:4px">{reason}</div>{/each}
                      </details>
                    {/if}
                  </div>
                {:else if check?.status === 'missing'}
                  <div class="notice small model-check-result">
                    Nothing compatible was found in the expected folder:
                    <code class="model-full-path">{check.targetPath ?? model.targetPath}</code>
                  </div>
                {/if}
              </td>
            </tr>
          {/each}
          {#if selectedModelStates().length === 0}
            <tr><td colspan="5" class="model-empty">No model files are configured for this profile.</td></tr>
          {/if}
        </tbody>
      </table>
    </div>
  </div>

  {#if otherModelStates().length > 0}
    <details class="panel" style="margin-top:14px">
      <summary>Other model variants — not required for {selectedProfile()?.label}</summary>
      <p class="muted small">
        These files belong to other profiles or are alternatives. You do not need to download them for
        the selected profile.
      </p>
      <table>
        <thead>
          <tr><th>Component</th><th>Status</th><th>File</th><th>Destination</th><th class="right">Action</th></tr>
        </thead>
        <tbody>
          {#each otherModelStates() as model (model.entry.id)}
            {@const entry = model.entry}
            {@const dl = Object.values(downloads).find((item) => item.manifestId === entry.id)}
            <tr>
              <td>
                <div>{entry.label}</div>
                <div class="muted small">{formatBytes(entry.sizeBytes)} · licence: {entry.license}</div>
                {#if entry.licenseUrl}<div class="small"><a href={entry.licenseUrl} target="_blank" rel="noreferrer">read licence</a></div>{/if}
                <div class="muted small" style="overflow-wrap:anywhere">SHA-256: <span class="mono">{entry.sha256 ?? 'not listed in the manifest'}</span></div>
              </td>
              <td>
                {#if dl && dl.state === 'running'}
                  <span class="badge warn">downloading {Math.round((dl.bytes / (dl.total || dl.bytes || 1)) * 100)}%</span>
                {:else if model.status === 'installed'}
                  <span class="badge ok">Installed</span>
                {:else if model.status === 'incompatible'}
                  <span class="badge warn">Needs attention</span>
                {:else}
                  <span class="badge">not found</span>
                {/if}
              </td>
              <td class="mono">{entry.file}</td>
              <td class="mono small" style="overflow-wrap:anywhere">{model.targetPath}</td>
              <td class="right">
                <button class="primary" disabled={busy === entry.id} onclick={() => download(entry)}>
                  {dl && dl.state === 'running' ? 'Downloading…' : 'Download'}
                </button>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </details>
  {/if}
{/if}

{#if scan.foreign.length > 0}
  <div class="panel">
    <h3 style="margin:0 0 10px;font-size:15px">Found in other local installations</h3>
    <table>
      <thead>
        <tr><th>File</th><th>Install</th><th>Detected</th></tr>
      </thead>
      <tbody>
        {#each scan.foreign as row (row.path)}
          <tr>
            <td class="mono">{row.name}</td>
            <td class="muted">{row.install}</td>
            <td>
              {#if row.compatible}
                <span class="badge ok">{row.role}{row.quant ? ` · ${row.quant}` : ''}</span>
              {:else}
                <span class="badge err">{row.role}</span>
                <div class="muted small">{row.reasons[0] ?? ''}</div>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<div class="panel">
  <h3 style="margin:0 0 8px;font-size:15px">Placing a file by hand</h3>
  <p class="muted small" style="margin-top:0">
    Copy a compatible model file into the expected folder shown above, then select <em>Check folder</em>.
    Velatura will confirm whether it can use that file with the selected profile.
  </p>
</div>
