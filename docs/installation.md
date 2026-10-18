# Installation

Two steps: **Velatura** (the interface) and **SD.Next** (the engine). The wizard
can do the second one for you.

---

## 1. Velatura

One command. It installs Velatura in your own home folder: no administrator
rights, nothing system-wide, and it creates the `velatura` command for you.
It first checks for **Node.js 20.19 or later**. If found, it reuses that executable
and downloads nothing; otherwise it installs a portable Node runtime in Velatura's
folder, checking its SHA-256. An older system Node is left untouched.

> | Your system | Terminal | Command |
> |---|---|---|
> | **Windows** | **PowerShell** | `irm https://github.com/orfeomorello/velatura/raw/main/installer/install.ps1 \| iex` |
> | Linux | a terminal | `curl -fsSL https://github.com/orfeomorello/velatura/raw/main/installer/install.sh \| bash` |
> | macOS | the terminal | `curl -fsSL https://github.com/orfeomorello/velatura/raw/main/installer/install.sh \| bash` |
>
> **On Windows, open PowerShell** (Windows key → `powershell` → Enter) and paste
> the first line. Do not type `bash install.sh` in the Windows terminal: `bash`
> there is the Linux subsystem (WSL), and Velatura would be installed *inside* it.
> The two installers are not interchangeable: `install.sh` is for Linux and macOS,
> `install.ps1` is for Windows.

**Linux / macOS**

```bash
curl -fsSL https://github.com/orfeomorello/velatura/raw/main/installer/install.sh | bash
```

**Windows** (PowerShell)

```powershell
irm https://github.com/orfeomorello/velatura/raw/main/installer/install.ps1 | iex
```

**From an archive you already downloaded:**

```bash
bash installer/install.sh --from ./release/velatura-app-0.1.4.tar.gz
```

```powershell
powershell -ExecutionPolicy Bypass -File installer/install.ps1 -From .\release\velatura-app-0.1.4.zip
```

What the installer does:

1. checks for Node.js **20.19 or later** and reuses it if present; only if it is
   missing or too old does it download a portable runtime (≈30 MB) into
   `~/.velatura/runtime` (`%LOCALAPPDATA%\velatura\runtime` on Windows), then
   check its SHA-256 against nodejs.org's official list;
2. installs the program into `~/.velatura/app`;
3. creates the `velatura` command, and a shortcut — on the desktop and in the
   start menu on Windows, in the applications menu on Linux;
4. checks common SD.Next locations for your operating system. The setup wizard validates any folder you enter and offers an install in a user-writable folder if no usable copy is found; the installer itself never clones SD.Next.

Then, open a **new terminal** (a terminal that was already open may not have
refreshed its PATH) and run:

```text
velatura
```

On Windows you can also use the desktop shortcut. The browser opens at
`http://127.0.0.1:7865` and the setup wizard starts.
A second `velatura` in another terminal prints the address of the one that is
already running.

**To uninstall**, the installer takes away exactly what it put in your home
folder — the program, the runtime, the command, the shortcut and the line in
your PATH — and nothing else:

```bash
bash installer/install.sh --uninstall
```

```powershell
powershell -ExecutionPolicy Bypass -File installer/install.ps1 -Uninstall
```

The pictures and the models are inside the folder of the program, so they go
away with it; the script says so before it removes anything.

---

## 2. SD.Next, the engine

### The easy way

In the wizard's **Engine** step, Velatura checks common system-specific locations
for the SD.Next startup script (`webui.bat` on Windows; `webui.sh` on Linux and
macOS) and the `launch.py` entrypoint. On Windows, the candidate list includes
`C:\sdnext` as well as user-folder locations. If it finds no usable copy, you can enter another folder for validation
or choose **Install SD.Next**. The wizard checks Git and Python 3.10+ first
(Python 3.12 is recommended by SD.Next). Clicking **Install SD.Next** is the
explicit confirmation: only then does Velatura clone the official repository
and start SD.Next's own first-run setup. The destination is a new or empty
folder; Velatura refuses to overwrite a non-empty folder. The first start can
take many minutes and download several GB; Velatura waits for the SD.Next API
to respond before offering **Use this installation**. Model weights are a separate step.

### By hand

**Windows — PowerShell** (not Bash/WSL):

```powershell
git clone https://github.com/vladmandic/sdnext
Set-Location sdnext
.\webui.bat
```

**Linux / macOS — terminal:**

```bash
git clone https://github.com/vladmandic/sdnext
cd sdnext
./webui.sh
```

The launcher creates the virtual environment and installs the libraries on the
first run. That first start can take several minutes and requires an internet
connection; model weights remain a separate choice.

### GPU Backends (NVIDIA, AMD, Intel Arc)

SD.Next supports **NVIDIA (CUDA)**, **AMD (ROCm / ZLUDA)**, **Intel Arc (IPEX / XPU)**, and **Apple Silicon (MPS)**.

For **Intel Arc** GPUs, SD.Next requires `--use-ipex` so it uses the XPU backend instead of falling back to CPU. When Velatura's hardware detection sees an Intel GPU, it adds `--use-ipex` automatically when starting SD.Next.

### Keep the saved SD.Next default

When Velatura starts SD.Next, it gives that process a private copy of the
SD.Next config under `~/.velatura/sdnext-session/` (on Windows,
`%LOCALAPPDATA%\\velatura\\sdnext-session\\`). This is necessary because
SD.Next may save model settings while loading a checkpoint, even when the
selection came from a per-generation request. Qwen can remain loaded for the
Velatura session, while the original startup model remains unchanged. On an
explicit **Stop**, Velatura merges ordinary SD.Next settings back but restores
the original model, pipeline, component, Diffusers-cache, Hugging Face-cache and
offline-mode values. If the original config changed at the same time, Velatura
leaves it untouched.

If SD.Next is already running outside Velatura, stop it first and start it with
Velatura before asking Velatura to switch to Qwen. If Qwen is not already loaded
with the profile's exact pipeline and components, Velatura will refuse to send
a generation request to an unmanaged engine rather than risk changing its saved
default. Velatura never downloads the Qwen base as part of this process.

### GGUF support and offline mode

A Low-VRAM profile using a `.gguf` transformer also needs the `gguf` Python package inside SD.Next's virtual environment. Velatura checks it before starting an existing SD.Next environment and again before Qwen generation. If no venv exists yet, the first startup can create it; Velatura rechecks before generation. If the package is missing, the app shows its details and waits for an explicit **Download, install, and start SD.Next** action. The pinned PyPI wheel is `gguf` 0.19.0, 118,475 bytes, MIT, SHA-256 `70bcd10edfe697fb2dad6e40af2234b9d8ece9a41a99761405121ebda1c3c1cd`.

Velatura verifies the package's declared Python and library requirements before downloading. It downloads and checksum-checks only the wheel, then installs into SD.Next's venv with pip's index and dependency resolution disabled. It never turns off offline mode and never downloads Qwen model weights. If the existing requirements are missing or too old, Velatura downloads nothing and reports them. Full technical details are in [`troubleshooting-gguf.md`](./troubleshooting-gguf.md).

---

## 3. The models

The default profile (**Low VRAM**) needs four files, about 11 GB in total:

| Component | File | Folder in SD.Next | Size |
|---|---|---|---|
| DiT (Turbo, 4-bit) | `qwen-image-2.1-turbo-Q4_K_M.gguf` | `models/UNET/` | 4.20 GB |
| Text encoder (Qwen3-VL, w4a8) | `qwen3vl_8b_w4a8.safetensors` | `models/Text-encoder/` | 6.31 GB |
| VAE 2.1 (bf16) | `qwen_image_2.1_vae_bf16.safetensors` | `models/VAE/` | 0.68 GB |
| Lightning 4-step LoRA | `pytorch_lora_weights.safetensors` | `models/Lora/` | 0.07 GB |

Two ways to get them, with the same weight:

- **Download** — the wizard shows the licence first, then downloads and checks
  the SHA-256.
- **You already have them** — point at the file and Velatura places it in the
  right folder, after reading it to be sure of what it is.

If you prefer to do it by hand, `velatura export` writes a text file with the
exact names, folders, sizes, checksums and licences.

### The local Qwen Turbo reference and profile components

SD.Next needs a Diffusers model directory to assemble the Qwen21 pipeline. Velatura creates a
small, app-managed reference directory containing pinned configuration files and the Turbo
8-step sigma schedule. The transformer/DiT, text encoder and VAE weights come from the profile's
local SD.Next components; the selected VAE is verified and linked into the reference (copied only
if the filesystem cannot create a hard link). Velatura does **not** download or require the full
Qwen base transformer or text-encoder weights.

SD.Next's Qwen 2.1 loader maps a single-file text-encoder selection to a Qwen3-VL config
repository. To keep this fully offline, Velatura sets a private session-only `hfcache_dir` and
seeds its cache with **only** `config.json`, copied from the pinned local reference. It contains
no model weights and makes no network request. SD.Next's saved Hugging Face cache path is restored
when the managed session stops.

The Qwen processor also needs `processor/tokenizer.json` (11,422,650 bytes). The Models page
shows its exact SHA-256, the upstream `qwen-research` licence and licence link before offering a
download. The user must explicitly accept the non-commercial terms and click the download button.
Velatura first checks an existing local/Hugging Face cache and reuses a copy only if its SHA-256
matches. A download is pinned to an immutable repository revision and is promoted to its final
name only after size and SHA-256 validation.

Velatura prepares and indexes the reference automatically when a profile is applied. It never
falls back to an unrelated checkpoint, and the generation flow does not download model weights.
The managed SD.Next process uses an isolated config copy with private `diffusers_dir` and
`hfcache_dir` paths and `offline_mode=true`; when the session stops, the user's original saved model,
cache-directory and offline-mode settings are restored.

---

## 4. Change the profile while it is running

The profile is not a one-time choice. On the next generation, Velatura validates the profile's
local DiT, text encoder and VAE, refreshes SD.Next's local reference index when needed, applies the
per-generation Qwen selections and verifies the checkpoint/pipeline after the request. It does not
use `/options` to persist Qwen as the user's global startup model.

If a required component, the small processor tokenizer, the `Qwen21` pipeline, or SD.Next's local
Diffusers indexing is unavailable, Velatura gives a clear reason and stops before sending the
image-generation request. The full Qwen base weights are never an automatic fallback or download.

## 5. Check

```bash
velatura doctor
```

It lists the engine, the folders, the manifest, the profiles, the GPU and its
VRAM, the version of diffusers inside the SD.Next environment, the solver the
profile uses — and, file by file, the size and the checksum of what the active
profile needs. `velatura models list` does the same for the model files. To trace a failed test or generation, check the local diagnostic log shown in `velatura files` and on the Files page; it records job stages and SD.Next endpoint status without storing prompts or reference-image data.

## 6. The test drive

The last step of the wizard renders one real image with the active profile and
tells you how long it took. It is the first honest measurement of the machine:
if it is slow, you know before you start a session.

## 7. The files you already own

```bash
velatura models import --from ~/models --profile lowvram
```

Velatura reads the header of every file in the folder, places it in the right
SD.Next folder, and accepts a community quantisation with a different name —
as long as it plays the same role. If the quantisation is heavier than the one
the profile was written for (a Q5 instead of a Q4), the profile adapts itself
and the interface says so: you are not asked to download a file you already have.

In Setup and on the Models page, the main list follows the selected profile;
other model variants are separated because they are not needed for it. The
**Check folder** action first checks the expected SD.Next destination.
Only if no compatible file is found there does Setup offer a path field to import
an existing copy from elsewhere.

## 8. The loop: edit the result again

Under every result there is an *edit again* button: the image becomes the
reference of the next job, with the prompt already in the box. When a job had
a reference image, a before/after slider is there too — drag it to wipe one
into the other.

Above the prompt there are the six intent chips of the specification (*style*,
*pose*, *appearance*, *remove*, *add*, *text*). A chip does not run anything
by itself: it writes a well-formed sentence in the box, and you can edit the
sentence before you send it. The sentence adapts to the number of reference
images, because "apply the style of Image 1 to Image 2" only makes sense with
two images.

## 9. Where the pictures are, and how to delete them

Every picture Velatura makes is written on this machine, in a plain folder:

```
~/.velatura/images/2026-10-16/2f897d47-1.png
```

The *Files* page of the interface writes the real path of everything: the
program, the settings, the history, the pictures, the model files in the
folders of SD.Next, and the half-downloaded `.part` files of an interrupted
download. From the same page you can open the folder in the file manager, copy
a path, delete one picture or all of them.

Three things worth knowing:

- the pictures you use as a **reference are never written to disk**: they are
  read, used and dropped. Only the results stay;
- a delete is refused if the path is not inside the Velatura image folder, or
  if the file is not an image. The same check runs from the terminal;
- a delete frees the **memory** too. While Velatura is open the results are
  also kept in RAM, to show the gallery: deleting a picture removes the file
  *and* the copy in memory, and the history stops pointing at it.

```bash
velatura files                 # the list, with the real paths
velatura files --clear-images  # delete the pictures
velatura files --clear-partials # delete the half-downloaded model files
```

## 10. Delete everything

```bash
velatura forget              # the settings, the history and the pictures
velatura forget --models     # and the model files it placed
```

The same thing is in the interface, under *Privacy* in the sidebar. Nothing of
yours ever left the computer, and nothing stays behind when you ask.
