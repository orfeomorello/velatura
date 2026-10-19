# Changelog

All notable changes to Velatura are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.5] — 2026-10-19

### Added
- **Quick Actions for one reference image** in Studio: *Real Phone Photo*, *Pro DSLR Portrait*, *Anime Style*, *3D Pixar / Cartoon*, *Enhance & Details*, *Cinematic Relight*, *Clean Background* and *Oil Painting*. Each action writes a dedicated, editable prompt and sets a tuned edit strength and negative prompt.
- **Fusion actions for two reference images**: *Copy Pose*, *Character Swap*, *Transfer Style*, *Outfit Swap* and *Place in Scene*, with `Image 1` / `Image 2` badges on the thumbnails and a one-click *Swap Image 1 ↔ Image 2* button.
- **Magic Prompt Enhancer** (`✨ Enhance`): expands a short idea into a detailed prompt using SD.Next's built-in Prompt Enhance (`/sdapi/v1/prompt-enhance`) and a small local LLM (default `Qwen/Qwen3-0.6B`; SmolLM2, Qwen2.5, Qwen3.5 and Qwen3-VL are selectable in the generation settings).
  - `↩ Undo` restores the prompt you wrote before enhancing.
  - A progress panel shows the elapsed time and current stage, with a *Cancel* button; the first use downloads and caches the model once.
- Server endpoints `GET /api/v1/prompt-enhance/models` and `POST /api/v1/prompt-enhance`.
- The composer footer now shows the current edit strength and the selected enhancer model.

### Changed
- SD.Next `offline_mode` is lifted only for the duration of a prompt-enhance call (so the small enhancer model can be fetched on first use) and restored immediately afterwards. Image generation still runs fully offline.
- *Enhance* is disabled while the prompt box is empty.

## [0.1.4] — 2026-10-18

### Added
- First public release: local Studio for Qwen-Image and Flux.2 Klein on top of SD.Next, guided setup, model downloads with licence and SHA-256 checks, queue, privacy controls and format/resolution presets.

### Fixed
- Windows `[Errno 22] Invalid argument` caused by an orphaned SD.Next process writing to closed stdio pipes; the managed engine now stops when Velatura shuts down.
- The startup screen stays visible until SD.Next and the profile are fully initialised, instead of switching to Studio before *Engine ready*.

[0.1.5]: https://github.com/orfeomorello/velatura/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/orfeomorello/velatura/releases/tag/v0.1.4
