/**
 * Build the served native-editor bundle.
 *
 * Output: ../../web/native-editor/native-editor.js
 * Served by the existing Host static route as
 * `/opentake-studio-route-b/app/native-editor/native-editor.js`.
 *
 * React and ReactDOM are bundled into the artifact intentionally: the DSH
 * client module only guarantees `require('react')`, and the native editor needs
 * a ReactDOM client root inside its ShadowRoot. No package export is required;
 * the artifact is a same-origin static file.
 */

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const WEB = path.join(REPO, 'web');
const requireFromWeb = createRequire(path.join(WEB, 'package.json'));
const viteEntry = requireFromWeb.resolve('vite');
const { build } = await import(pathToFileURL(viteEntry).href);

const outDir = path.resolve(HERE, '../web/native-editor');
await build({
  configFile: false,
  root: REPO,
  publicDir: false,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
  },
  build: {
    target: 'chrome120',
    minify: true,
    sourcemap: false,
    emptyOutDir: true,
    outDir,
    lib: {
      entry: path.join(WEB, 'src/native/browser-entry.js'),
      formats: ['es'],
      fileName: () => 'native-editor.js',
    },
    rollupOptions: {
      output: {
        entryFileNames: 'native-editor.js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
console.log(`[native-editor] built ${path.join(outDir, 'native-editor.js')}`);
