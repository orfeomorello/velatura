/**
 * Build the release bundle.
 *
 * The result is a folder that can be dropped anywhere on the machine:
 *
 *   app/
 *     dist/velatura.js        ← the whole program in one file (esbuild)
 *     apps/ui/dist/           ← the interface (static files)
 *     manifests/models.yaml   ← the metadata about the weights
 *     profiles/*.yaml         ← the hardware profiles
 *     package.json
 *
 * The layout mirrors the repository on purpose: the code that looks for
 * `manifests/models.yaml` and `apps/ui/dist` finds them without changes.
 */
import { build } from 'esbuild';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version;
const out = join(root, 'release', 'app');

// only the app folder is rebuilt: the archives and the installers of the
// release folder are not ours to delete (the test suite calls this script)
await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'dist'), { recursive: true });

// --- the program ------------------------------------------------------------
const result = await build({
  entryPoints: [join(root, 'packages', 'cli', 'src', 'index.ts')],
  outfile: join(out, 'dist', 'velatura.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20.19',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  banner: {
    // the CommonJS dependencies (commander, fastify) use dynamic require():
    // in an ESM bundle we give them a real one
    js: [
      "import { createRequire as __velaturaCreateRequire } from 'node:module';",
      "const require = __velaturaCreateRequire(import.meta.url);",
    ].join('\n'),
  },
  logLevel: 'warning',
  metafile: true,
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`  dist/velatura.js  ${(bytes / 1e6).toFixed(2)} MB`);

// --- the interface ----------------------------------------------------------
await cp(join(root, 'apps', 'ui', 'dist'), join(out, 'apps', 'ui', 'dist'), { recursive: true });

// --- the data files ---------------------------------------------------------
await cp(join(root, 'manifests'), join(out, 'manifests'), { recursive: true });
await cp(join(root, 'profiles'), join(out, 'profiles'), { recursive: true });

// --- the package marker -----------------------------------------------------
await writeFile(
  join(out, 'package.json'),
  `${JSON.stringify(
    {
      name: 'velatura',
      version,
      type: 'module',
      description: 'A local studio for SD.Next',
      bin: { velatura: 'dist/velatura.js' },
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`  bundle ready in ${out}`);
