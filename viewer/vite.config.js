import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sceneLibrary } from './server/scene-library.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default defineConfig({
  base: './',
  // aholo-viewer resolves its workers relative to import.meta.url, so it must not be prebundled.
  optimizeDeps: { exclude: ['recast-navigation', '@manycore/aholo-viewer'] },
  build: { target: 'es2022', rollupOptions: { input: {
    aholo: fileURLToPath(new URL('./aholo/index.html', import.meta.url)),
  } } },
  plugins: [{name: 'scene-library', configureServer(server) {
    // Imported rooms in <repo>/data/scene-library, served at /__scenes during local development only.
    server.middlewares.use(sceneLibrary(root));
  }}],
});
