// Serves image derivatives from the cache in dev, reloads on content changes,
// and copies only the derivatives the built site references into the output.
import type { AstroIntegration } from 'astro';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_DIR, IMG_PREFIX } from './lib/env.ts';
import { IMG_CACHE_DIR } from './lib/images.ts';
import { loadSite, usedImageFiles } from './lib/load.ts';

const TYPES: Record<string, string> = { '.jpg': 'image/jpeg', '.avif': 'image/avif' };

export default function baryta(): AstroIntegration {
  return {
    name: 'baryta',
    hooks: {
      'astro:config:setup': ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: 'baryta-dev',
                configureServer(server) {
                  server.watcher.add(CONTENT_DIR);
                  server.watcher.on('all', (_event, file) => {
                    if (file.startsWith(CONTENT_DIR + path.sep) && /\.(ya?ml|md)$/.test(file)) {
                      server.ws.send({ type: 'full-reload' });
                    }
                  });
                  server.middlewares.use(IMG_PREFIX, async (req, res, next) => {
                    const name = path.basename((req.url ?? '').split('?')[0]!);
                    const file = path.join(IMG_CACHE_DIR, name);
                    const type = TYPES[path.extname(name)];
                    try {
                      if (!type || !(await stat(file)).isFile()) return next();
                    } catch {
                      return next();
                    }
                    res.setHeader('Content-Type', type);
                    createReadStream(file).pipe(res);
                  });
                },
              },
            ],
          },
        });
      },
      'astro:build:done': async ({ dir, logger }) => {
        const site = await loadSite({ contentDir: CONTENT_DIR, drafts: false });
        const out = path.join(fileURLToPath(dir), IMG_PREFIX);
        await mkdir(out, { recursive: true });
        const files = usedImageFiles(site);
        await Promise.all(files.map((f) => copyFile(path.join(IMG_CACHE_DIR, f), path.join(out, f))));
        logger.info(`copied ${files.length} image derivatives`);
        for (const g of site.galleries.filter((g) => g.visibility === 'private')) {
          logger.info(`private: ${g.slug} at ${g.path}`);
        }
      },
    },
  };
}
