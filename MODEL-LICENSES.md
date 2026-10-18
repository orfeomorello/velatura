# Model licences

**Velatura does not distribute any model weights.** The files below are
downloaded by the user, on their machine, from the upstream repositories, and
their licences belong to their authors. Velatura shows the licence **before**
the download starts and records it in the manifest.

## Qwen-Image 2.1 (the only model family in scope)

| Model | Repository | Licence | Commercial use |
|---|---|---|---|
| Qwen-Image 2.1 | [`Qwen/Qwen-Image-2.1`](https://huggingface.co/Qwen/Qwen-Image-2.1) | **Qwen Research License** | ❌ no |
| Qwen-Image 2.1 Turbo | [`Qwen/Qwen-Image-2.1-Turbo`](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo) | **Qwen Research License** | ❌ no |
| Qwen-Image 2.1 (GGUF, Turbo) | [`unsloth/Qwen-Image-2.1-Turbo-GGUF`](https://huggingface.co/unsloth/Qwen-Image-2.1-Turbo-GGUF) | Qwen Research (redistribution) | ❌ no |
| Qwen-Image 2.1 (GGUF, base) | [`unsloth/Qwen-Image-2.1-GGUF`](https://huggingface.co/unsloth/Qwen-Image-2.1-GGUF) | Qwen Research (redistribution) | ❌ no |
| Qwen-Image 2.1 (single-file INT8/BF16, encoder, VAE) | [`Comfy-Org/Qwen-Image-2.1`](https://huggingface.co/Comfy-Org/Qwen-Image-2.1) | Qwen Research (redistribution) | ❌ no |
| Lightning 4-step LoRA | [`lightx2v/Qwen-Image-2.1-Lightning`](https://huggingface.co/lightx2v/Qwen-Image-2.1-Lightning) | see the model card | ❌ research use |

The canonical licence text lives with the model:
<https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE>

> **Consequence, stated plainly:** because the only supported weights are under the
> Qwen Research License, an installation of Velatura is **non-commercial**. The code
> itself is Apache-2.0 and can be reused commercially, but any deployment that uses
> these weights is not.
>
> The Apache-2.0 line (Qwen-Image / Qwen-Image-Edit 2509 / 2511 / 2512, 20B) remains
> the escape hatch for a commercial deployment — it is out of scope in this project
> today, and the architecture does not forbid adding it later.

## Third-party model files found on your machine

Velatura can detect model files that already exist in your other installations
(ComfyUI, Forge, another SD.Next). Those files keep their own licences, and
Velatura only reads their headers to recognise them — it never modifies or
redistributes them.

## Please read the licence before you use the weights

`manifests/models.yaml` records, for every file: the repository, the pinned
revision, the exact file name, the size, the SHA-256 and the licence string
taken from the model card. The application shows the same information in the
interface, next to the download button.
