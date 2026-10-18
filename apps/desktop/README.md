# Velatura Desktop — the optional native shell

This is the **optional** part of Velatura. The product is the local web app:
`velatura serve` opens it in your browser, and everything works.

This shell adds what a browser cannot give you:

- a **native window** (no browser chrome, no tab bar)
- a **tray icon** and native notifications
- **native file dialogs** (choose the SD.Next folder, choose model files)
- **drag & drop with real file paths** — the natural way to use the
  "I already have the models" flow

It is built with [tinyjs](https://tinyjs.app) (MIT): a ~6 MB app, no Electron,
no bundled Chromium, no open ports.

## Build and run

```bash
# once
curl -fsSL https://tinyjs.app/install | sh          # macOS / Linux
irm https://tinyjs.app/install.ps1 | iex             # Windows

cd apps/desktop
npm install                # nothing to install: tinyjs has no dependencies
tinyjs dev                 # development, with hot reload
tinyjs build               # dist/ (portable folder on Windows/Linux, .app on macOS)
```

## How it works

1. The backend (`src/backend/main.js`) starts the **same** Velatura server the
   browser mode uses: `velatura serve --no-open --port 0`.
2. The CLI prints a machine readable line with the URL and the session token:
   `VELATURA_URL=http://127.0.0.1:7865/#token=…`
3. The shell hands the window over to that URL.

The shell contains **no product logic**: the queue, the model manager and the
verification all live in the server, so the two front ends can never disagree.

## What still needs to be confirmed on a real machine

`tinyjs` is a young project (first release 2026-07) and Windows/Linux are
still marked beta. Before the shell is promoted from "optional" to "default",
these points have to be checked on Windows 11 with a real Arc A770:

- [ ] the exact API for **drag & drop with real paths** (the page must be able
      to hand a path to the backend, and the backend to answer
      `POST /api/v1/models/import`)
- [ ] **native file dialogs** used to pick the SD.Next folder
- [ ] **tray icon + notifications** ("generation finished")
- [ ] the **capability gate** for the hosted origin (`127.0.0.1:7865`): the
      web app must be allowed to call the bridge for file paths, and nothing else
- [ ] behaviour when the Velatura server is already running (the shell should
      attach to it instead of starting a second one)

Until those are verified, the browser mode stays the default — which is the
whole point of keeping the shell optional.
