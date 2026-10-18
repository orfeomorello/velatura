# Releasing

Velatura is published as a **set of files**, not as a package manager artifact:
a small archive with the program, plus two installer scripts.

## What is published

| File | For |
|---|---|
| `velatura-app-<version>.tar.gz` | Linux and macOS |
| `velatura-app-<version>.zip` | Windows |
| `velatura-<version>.zip` | everything in one file, for the people who download it by hand |
| `SHASUMS256.txt` | the checksums of the archives |

The archive contains the program (one bundled JavaScript file), the interface
(static files), the manifest and the profiles. It is about **450 KB**.
The installer first reuses a compatible system Node.js 20.19 or later, before
considering a private runtime already installed in Velatura. Only if neither is
usable does it download a portable Node runtime (≈30 MB), and it refuses to
unpack it unless its SHA-256 matches nodejs.org's official list. **The downloaded
application archive is checked too**, against the release `SHASUMS256.txt`, in
both installers; a missing list, missing entry or mismatch stops installation
before that archive is unpacked.

The archives are written in Node itself (`scripts/archive.mjs`): the
release does **not** need `tar`, `zip` or 7-Zip, so it can be built on any
machine — including Windows, where `zip` does not exist. The two archives
always hold exactly the same files, and `scripts/archive.test.ts` checks
them with a reader written separately from the writer.

## How to publish

```bash
npm install
npm run typecheck
npx vitest run
node scripts/check-installers.mjs
node scripts/make-release.mjs
git tag v0.1.4
git push origin v0.1.4
```

The workflow in `.github/workflows/release.yml` runs the tests, builds the
release and attaches only files matching the tag's version. `scripts/make-release.mjs`
creates the two platform archives, the full convenience ZIP and the checksums.
The `release/SHASUMS256.txt` copied inside the full ZIP lists the platform archives;
the root `SHASUMS256.txt` uploaded beside the assets also lists the full ZIP, avoiding
a self-referential hash. No external `zip` utility is used. Older files left in
`release/` are not included in a new version's full ZIP or uploaded to GitHub.

## The install command

Once the release is published, the one-line install is:

```bash
curl -fsSL https://github.com/orfeomorello/velatura/raw/v0.1.4/installer/install.sh | bash
```

```powershell
irm https://github.com/orfeomorello/velatura/raw/v0.1.4/installer/install.ps1 | iex
```

The version in the URL can be `main` to always get the latest.

**The two paths are different, and both are tested.** `install.sh` can take a
local archive (`--from`) or a base URL (`--url`); the second one downloads the
archive and the list of the checksums. `packages/cli/test/installer.test.ts`
runs both, end to end, in a temporary `HOME`. The same for `install.ps1`,
with `-From` and `-Url` — that one is only checked statically, because
PowerShell is not everywhere (see below).

## Checking the installers without installing

```bash
node scripts/check-installers.mjs
```

It checks the syntax of `install.sh` (when there is a `bash` around) and the
text of both scripts: the switches, the checksum of the runtime, the launcher,
the user PATH, the `webui.bat` of SD.Next, and the PowerShell traps. It does
not fail when `bash` is missing — it says so and keeps the other checks.

The same checks are inside the test suite (`packages/cli/test/installers.test.ts`),
so `npm test` covers them on every system, Windows included.

### The traps that cost time

- **In PowerShell, `"$var.ext"` is a property access**, not a concatenation:
  the extension disappears and the URL breaks. The safe form is the
  subexpression: `"$($var).ext"`. It was wrong in two places of `install.ps1`.
- **A batch file with LF line endings is read badly by `cmd.exe`.** The
  launcher is written with CRLF, in ASCII, without a byte order mark.
- **`sha256sum` does not exist on macOS.** `install.sh` uses `sha256_of()`,
  which falls back to `shasum -a 256`. If neither SHA-256 tool is available, the
  private runtime or downloaded application cannot be verified and installation stops.
- **The `install.ps1` launcher sets `VELATURA_CONFIG_DIR`** to the install
  folder, so the configuration and the pictures stay together.

## Before the first public release

- [x] replace `OWNER` in the README, the installers and the workflow with `orfeomorello/velatura`;
- [x] bump `VERSION` in `installer/install.sh` and `installer/install.ps1` to match the tag —
      the installer builds the name of the archive it downloads;
- [x] decide on the licence of the *weights*: the manifest says `qwen-research`
      (non-commercial), and the licence must be shown before every download;
- [x] add a `NOTICE` entry clarifying that SD.Next (AGPL-3.0) is an external engine accessed strictly via its local HTTP API.

## What is not published

No weights, no VAE, no encoder, no LoRA, no tokenizer — only metadata
(`manifests/models.yaml`). The program never redistributes a model.
