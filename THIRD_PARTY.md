# Third-party components & license boundaries

Velatura is an independent companion client for [SD.Next](https://github.com/vladmandic/sdnext).

## External engine (not bundled, not copied)

| External Software | Upstream License | How Velatura interacts with it |
|---|---|---|
| [SD.Next](https://github.com/vladmandic/sdnext) | AGPL-3.0 | **External runtime engine — not bundled, forked, or copied.** Installed separately by the user in its own directory; Velatura communicates with it strictly as an external client over its standard local HTTP API (`/sdapi/v1/*`) using an isolated `--config` session file. |

No source code, UI code, or binary from SD.Next (or `sdnext-modernui`) is included in this repository.

## Direct npm dependencies (installed via package manager)

None of these packages are vendored in the repository; they are declared in `package.json` and installed by `npm`.

| Component | License | Role |
|---|---|---|
| [Fastify](https://fastify.dev) | MIT | Local HTTP server |
| [@fastify/static](https://github.com/fastify/fastify-static) | MIT | Serves the built web interface |
| [Svelte](https://svelte.dev) | MIT | Web user interface |
| [Vite](https://vite.dev) | MIT | Frontend build tool |
| [commander](https://github.com/tj/commander.js) | MIT | Command-line interface |
| [yaml](https://eemeli.org/yaml/) | ISC | Manifest and profile parsing |
| [vitest](https://vitest.dev) | MIT | Automated test suite |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Type checking and build |

## Not redistributed

- **No model weights:** `manifests/models.yaml` contains metadata only (repository, pinned revision, file name, destination folder, size, SHA-256, and license). See [`MODEL-LICENSES.md`](MODEL-LICENSES.md) for the upstream licenses of the models the application can download.
- **No SD.Next code or binaries:** Users install SD.Next directly from its official repository; Velatura acts purely as a local API client and workflow companion.
