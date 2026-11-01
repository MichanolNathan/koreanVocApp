import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

// Génère dist/sw.js au build : précache tous les fichiers émis (coquille + assets
// hashés + icônes + manifest). Le code du SW vit dans scripts/sw-template.js.
function serviceWorker(): Plugin {
  return {
    name: 'generate-service-worker',
    apply: 'build',
    closeBundle() {
      const dist = join(here, 'dist');
      const collect = (dir: string): string[] =>
        readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
          const path = join(dir, entry.name);
          return entry.isDirectory() ? collect(path) : [path];
        });
      const files = collect(dist)
        .map((path) => ({ url: '/' + relative(dist, path).replaceAll('\\', '/'), path }))
        .filter(({ url }) => url !== '/sw.js')
        .sort((a, b) => a.url.localeCompare(b.url));
      // Version = empreinte du contenu : tout changement de build invalide le cache.
      const hash = createHash('sha256');
      for (const { path } of files) hash.update(readFileSync(path));
      const version = hash.digest('hex').slice(0, 12);
      const template = readFileSync(join(here, 'scripts', 'sw-template.js'), 'utf8');
      writeFileSync(
        join(dist, 'sw.js'),
        template
          .replaceAll('__PRECACHE_URLS__', JSON.stringify(files.map(({ url }) => url)))
          .replaceAll('__VERSION__', version),
      );
      this.info(`sw.js généré — ${files.length} fichiers précacheés, version ${version}`);
    },
  };
}

export default defineConfig({
  plugins: [react(), serviceWorker()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
