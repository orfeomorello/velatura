# Velatura

**A simplified local interface for Qwen-Image 2.1** built on top of [SD.Next](https://github.com/vladmandic/sdnext).

> Community project — not affiliated with SD.Next.
> *Velatura* is the Italian term for a transparent finishing glaze applied over a painting: SD.Next is the engine, Velatura gives it a clean, zero-friction interface.

---

## Highlights

- **Modern AI Interface** — One clean screen: active image stage in the center, dockable session filmstrip, and a GPT-style composer dock at the bottom (`+` to attach 1–4 reference images, prompt input, optional `⚙️` settings popover, and **Generate**).
- **100% Local & Private** — Runs on your machine with any GPU supported by SD.Next (NVIDIA CUDA, AMD ROCm, Intel Arc IPEX, Apple Silicon). Includes a 2-pass secure overwrite wipe for prompt history, logs (`sdnext.log`), and generated images.
- **Zero-touch SD.Next orchestration** — Velatura connects to or launches SD.Next in the background, assembles the local Qwen-Image 2.1 Diffusers reference from your weights without downloading redundant 17 GB base checkpoints, and manages model placement automatically.
- **Smart Model Manager** — Inspects `.safetensors` headers directly, verifies SHA-256 checksums, and links existing weights (via hardlinks/junctions) without duplicating disk space.
- **Hardware Profiles** — Built-in **Low** (`SDNQ UINT4`, ~12.4 GB on disk, ideal for 12–16 GB VRAM GPUs) and **Full** (`BF16`, ~32.4 GB on disk, for high-VRAM systems) Qwen-Image 2.1 Turbo profiles.

---

## Quick Start

### 1. Run from source

```bash
npm install
npm run build
node packages/cli/dist/index.js serve
```

Velatura opens at `http://127.0.0.1:7865`.
- On your **first run**, the guided Setup checks your SD.Next path, hardware profile, and model files.
- On **every subsequent launch**, Velatura opens directly into the **Studio** prompt view.

### 2. One-line Installer

**Windows (PowerShell):**
```powershell
irm https://github.com/orfeomorello/velatura/raw/main/installer/install.ps1 | iex
velatura
```

**Linux / macOS:**
```bash
curl -fsSL https://github.com/orfeomorello/velatura/raw/main/installer/install.sh | bash
velatura
```

---

## CLI Reference

```bash
velatura                        # Start Velatura server and open the Studio in your browser
velatura serve --port 7866      # Run on a custom port
velatura setup                  # Guided terminal setup
velatura doctor                 # Inspect hardware, SD.Next path, and installed models
velatura models list            # List manifest models and disk status
velatura models bundle lowvram  # Download all missing files for a profile (with SHA-256 check)
velatura models verify          # Verify sizes and SHA-256 hashes of installed models
velatura models scan <path>     # Inspect a model file header (.safetensors / .gguf)
velatura files                  # Show real disk paths for images, configs, and logs
velatura forget                 # Remove Velatura local state and history
```

---

## Architecture

```text
Browser (Svelte 5 Web UI)
        │  REST + SSE (/api/v1/*)
        ▼
Velatura Server (Node.js + Fastify)
  · Model Manager (SHA-256 verification, header scanner, zero-copy Diffusers reference)
  · Job Queue (single-GPU serialization, live step/ETA progress, JSONL history)
  · SD.Next Lifecycle & API Client
        │  HTTP 127.0.0.1:7860 (/sdapi/v1/*)
        ▼
SD.Next Engine  →  Qwen-Image 2.1 Turbo  →  Local GPU (NVIDIA / AMD / Intel Arc)
```

| Package | Description |
|---|---|
| `packages/core` | Model manifest, `.safetensors` header scanner, SHA-256 verifier, hardware profiles, payload builder |
| `packages/server` | Fastify API server, SD.Next lifecycle manager, local Diffusers reference builder, job queue |
| `packages/cli` | `velatura` command-line interface |
| `apps/ui` | Svelte 5 web application (Studio, Setup, Models, System) |
| `manifests/models.yaml` | Pinned repository revisions, file sizes, SHA-256 hashes, and licenses |
| `profiles/*.yaml` | `lowvram` (Turbo SDNQ UINT4) and `full` (Turbo BF16) profile definitions |

---

## Development

```bash
npm install
npm run dev          # Start Vite + Fastify server in watch mode
npm test             # Run Vitest unit & integration suite
npm run typecheck    # Run TypeScript checks across all workspaces
npm run build        # Build core, server, cli, and UI
```

---

## Relationship with SD.Next & License

Velatura is an independent, community-built companion client designed to work alongside **[SD.Next](https://github.com/vladmandic/sdnext)**:

- **Respecting SD.Next:** Velatura does **not** fork, vendor, modify, or redistribute any SD.Next source code or binaries.
- **Clean API boundary:** SD.Next is installed separately on your machine in its own folder under its own upstream license (AGPL-3.0). Velatura communicates with SD.Next exclusively over its standard local HTTP REST API (`/sdapi/v1/*`) and launches it with an isolated `--config` session file so your personal SD.Next configuration is never altered.
- **Velatura source code:** Licensed under the **Apache License 2.0** ([`LICENSE`](LICENSE), [`NOTICE`](NOTICE), [`THIRD_PARTY.md`](THIRD_PARTY.md)).
- **Model weights:** Not distributed in this repository. Qwen-Image 2.1 weights are downloaded directly by the user from Hugging Face and remain subject to their respective upstream licenses (see [`MODEL-LICENSES.md`](MODEL-LICENSES.md)).
