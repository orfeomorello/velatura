# Qwen GGUF support in SD.Next

## Missing `gguf` Python module

A Qwen profile that uses a `.gguf` DiT needs the `gguf` Python package inside SD.Next's own virtual environment. Velatura starts the Qwen session with SD.Next offline mode enabled so the engine cannot fetch model files. In current upstream SD.Next, the internal pip helper also returns early when that offline flag is set, so the loader cannot automatically install a missing Python package during model loading. The supplied runtime log shows offline mode and the missing import; because the exact SD.Next commit was not included, that mechanism is the best-supported explanation, not a locally verified source-level fact.

Velatura checks the SD.Next virtual-environment interpreter before starting or generating. If `gguf` is missing, the app shows the exact package metadata and waits for an explicit user action. It does not change the saved SD.Next settings, disable offline mode, or download Qwen weights.

The supported wheel is pinned to `gguf` 0.19.0:

- File: `gguf-0.19.0-py3-none-any.whl`
- Size: 118,475 bytes
- License: MIT
- SHA-256: `70bcd10edfe697fb2dad6e40af2234b9d8ece9a41a99761405121ebda1c3c1cd`
- Python: 3.10 or later
- Declared dependencies: `numpy >= 1.17`, `PyYAML >= 5.1`, `requests >= 2.25`, and `tqdm >= 4.27`

Before downloading, Velatura verifies that the declared dependencies already meet their minimum versions in the SD.Next environment. It downloads only the wheel after the user confirms, checks the exact size and SHA-256 before installing, then runs that venv's Python with `pip install --no-index --no-deps`. If a dependency is missing or outdated, no wheel is downloaded and Velatura reports what needs review. The helper remains in SD.Next's venv if Velatura data is later forgotten; the Forget action removes the cached wheel from Velatura but does not uninstall a package from SD.Next's shared Python environment.

The wheel is a small Python helper, not a model. It does not contain Qwen weights. If the wheel installs and the same import error remains, collect the new Velatura and SD.Next logs; do not turn off offline mode or fetch the full Qwen base pipeline as a workaround.

## Separate VAE warning

A VAE warning emitted while SD.Next is still using a different checkpoint is not proof that the Qwen VAE is invalid. Reassess it only after the Qwen pipeline has actually loaded successfully. A profile-preflight result alone does not prove the pipeline loaded or that an image was generated.
