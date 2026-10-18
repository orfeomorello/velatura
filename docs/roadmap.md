# Roadmap

The truth about what is done, what is being verified and what is next.

## Done and tested

- **Model manager** (`packages/core`): manifest parsing and validation,
  SHA-256 verification, **semantic file scanner** (GGUF + Safetensors headers:
  architecture, quantisation, parameter count, vision tower), placement
  (copy / hardlink / symlink / use-in-place), hardware profiles.
- **Manifest generator**: `node scripts/generate-manifest.mjs` reads the
  Hugging Face API and produces pinned revisions, real sizes and real
  SHA-256 values (the LFS oid *is* the sha256 of the file).
- **Server** (`packages/server`): REST + SSE API, session token, model
  download with progress, import, verification, the job queue, the SD.Next
  client and the engine lifecycle (start, detect the port from the log, stop).
- **CLI** (`packages/cli`): `serve`, `setup`, `doctor`, `models list|scan|import`,
  `shell`.
- **Interface** (`apps/ui`): Svelte 5, in English — Models, Generate, Queue.
- **31 automated tests**, no GPU and no gigabytes required.

## To verify on real hardware (NVIDIA / AMD / Intel GPUs)

1. Does the installed `diffusers` support the **8-step Turbo schedule**? If
   not, the images come out wrong — this is the single biggest risk.
2. Does SD.Next load the **`qwen_image` architecture** GGUF on XPU? If not,
   fall back to the single-file INT8 ConvRot checkpoint.
3. Real timings, for the honest ETA: seconds per image per profile, and the
   VRAM actually used.
4. The interaction between `hires` / `detailer` and the edit models.

## Next

- [x] The **setup wizard** in the interface: engine detection, hardware and profile,
      the model check-list (download / I already have it), final verification.
- [x] Hardware detection (GPU, VRAM) — honest about what it cannot read.
- [ ] A better **model picker** inside the generate screen (the engine's own list, live).
- [x] The **engine is really wired**: progress and preview read from `/sdapi/v1/progress`,
      cancel calls `/sdapi/v1/interrupt`, the payload is built from the profile.
- [x] **Profiles on disk** (`profiles/*.yaml`): steps, guidance, second pass, detailer, engine flags.
- [x] **History on disk** (JSONL, one line per finished job).
- [x] **Bundle install**: one button for the whole profile, licence first, SHA-256 after.
- [x] **Export the instructions**: for the people who want to do it by hand.
- [x] **The lifecycle of the engine is really ours**: start (reading the port from its log),
      stop — but only an engine we started — and the engine wakes up by itself when a job
      is queued.
- [x] **The installer**: one command on Linux, macOS and Windows. It reuses system
      Node.js 20.19+ when present; otherwise it downloads a checksum-verified portable
      runtime, installs the program in the home folder, creates the `velatura` command and
      a shortcut, and looks for the engine.
- [x] **The wizard can install SD.Next for you**: it checks that Git and Python are
      there, clones the official repository and shows the log while the environment is built.
- [x] The **Intel Arc** case: `--use-ipex` is added automatically when the hardware check
      sees an Intel GPU.
- [x] The **session token** survives a page reload, and a second instance prints the
      address of the first one.
- [x] The **payload is checked against the SD.Next parameters** (`enable_hr`, `hr_scale`,
      `hr_second_pass_steps`, `hr_denoising_strength`, `detailer_enabled`, `detailer_steps`,
      `detailer_strength`, `sampler_name`, `schedulers_sigma`, `override_settings`).
- [ ] The gallery: history, before/after, reproducibility of the parameters.
- [ ] The **optional native shell**: drag & drop with real paths, tray,
      notifications (see `apps/desktop/README.md` for the checklist).
- [ ] A portable runtime downloader, so the user does not need Node installed.
- [ ] Packaging for Windows (portable folder + signed installer).

## Deliberately out of scope

- Cloud providers, accounts, telemetry.
- The 20B Apache-2.0 Qwen-Image-Edit line (out of scope by decision; the
  architecture does not forbid adding it).
- Redistributing model weights: never.
