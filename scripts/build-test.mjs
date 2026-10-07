/**
 * Bundles what the unit tests import into dist-test/.
 *
 * The pure modules build as-is. The MCP server needs Electron, so it builds
 * against a stub (test/support/electron-stub.cjs) that is just enough for the
 * tool layer to load and run under plain Node.
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'dist-test');

await Promise.all([
    build({
        entryPoints: ['geometry', 'uitree', 'windows'].map(m => join(root, 'src/shared', `${m}.ts`)),
        bundle: true,
        platform: 'node',
        format: 'esm',
        outdir: out,
        logLevel: 'error'
    }),
    build({
        entryPoints: [join(root, 'test/support/harness.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node22',
        outfile: join(out, 'harness.cjs'),
        alias: { electron: join(root, 'test/support/electron-stub.cjs') },
        logLevel: 'error'
    })
]);
