# Changelog

All notable changes to Velatura are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.6] — 2026-10-22

### Added
- **Canvas-extension arrows** on a small stage dock: ← and → add a quarter of the width, ↑ and ↓ a quarter of the height (aligned to 16 px, capped at 2048 px per side). The new strip is prepared in the browser with the photo's edge colour stretched and blurred, the job runs at the extended size, and the aspect preset in the composer is not touched. The caption shows the current pixel size and an arrow disables when its side reaches the cap.
- **An attached photo takes the stage straight away**, at its own size, with the same dock, before any job exists; the last photo added is the one on the stage, and `Ctrl+Z`-undo restores the previous stage state.
- **View-only zoom**: `+`/`−` buttons and the mouse wheel (100–400%), mouse-drag or touch panning while magnified, arrow-key panning, `Ctrl+Z` undo of the last command from outside the text box. The view resets when a new picture takes the stage and during the before/after compare.
- **Variations** button on a finished result: resends the job with one seed over the one that produced it — same prompt, same references, one job per click — so the next picture is a sibling, not a new throw of the dice.

### Changed
- The camera-orbit arrows are gone: the base model returned the input image unchanged for every "turn the camera" wording, so the stage arrows now extend the canvas instead.
- **Menu presets no longer start a job by themselves** — on an attached photo or on a finished result: a preset from *Edits ▾* writes the instruction and parameters and waits for *Apply edit*. When a result is on the stage, that result becomes the job reference only after the instruction is confirmed; cancelling the dialog leaves nothing attached.
- *Save PNG* is now styled as the primary action with a download glyph (the download link previously matched no `button.primary` styling).
- New Studio internals: `StageNudge.svelte` (stage dock), `CommandMenu.svelte`, `canvas-extend` and `edit-tools` modules with tests; the camera chip family is removed from the command menu.

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

[0.1.6]: https://github.com/orfeomorello/velatura/compare/v0.1.5...v0.1.6
[0.1.5]: https://github.com/orfeomorello/velatura/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/orfeomorello/velatura/releases/tag/v0.1.4
