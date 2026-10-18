/**
 * Velatura Desktop — the optional native shell.
 *
 * It contains no product logic: it starts the Velatura server (the same
 * command line the browser mode uses) and shows its UI in a native window.
 *
 * Everything tinyjs-specific is isolated in this file, so the rest of the
 * project never depends on the shell.
 */
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Where the Velatura CLI lives. */
function findCli() {
  if (process.env.VELATURA_CLI) return process.env.VELATURA_CLI;
  // dev: this file lives at <repo>/apps/desktop/src/backend/main.js
  const dev = resolve(here, '..', '..', '..', '..', 'packages', 'cli', 'dist', 'index.js');
  return dev;
}

function cliCommand() {
  const cli = findCli();
  if (process.platform === 'win32') return [process.execPath, [cli, 'serve', '--no-open', '--port', '0']];
  return [process.execPath, [cli, 'serve', '--no-open', '--port', '0']];
}

export async function init(app) {
  const state = { url: null, error: null, log: [] };

  const [cmd, args] = cliCommand();
  const proc = tjs.spawn([cmd, ...args], { stdout: 'pipe', stderr: 'pipe' });

  const url = await new Promise((resolvePromise) => {
    let buffer = '';
    const timer = setTimeout(() => resolvePromise(null), 60_000);

    proc.stdout.on('data', (chunk) => {
      const text = new TextDecoder().decode(chunk);
      buffer += text;
      state.log.push(text);
      const match = /VELATURA_URL=(http:\/\/\S+)/.exec(buffer);
      if (match) {
        clearTimeout(timer);
        resolvePromise(match[1]);
      }
    });
    proc.stderr.on('data', (chunk) => {
      state.log.push(new TextDecoder().decode(chunk));
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      state.error = `the Velatura server stopped (code ${code})`;
      resolvePromise(null);
    });
  });

  state.url = url;

  // ---- the bridge the page can call -------------------------------------
  app.url = () => state.url;
  app.status = () => ({
    url: state.url,
    error: state.error,
    log: state.log.slice(-20),
  });
  app.stop = () => {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    return true;
  };
}
