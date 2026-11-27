import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

// Emits /sw.js (no hash in the name) at build time from frontend/sw/sw.js, with the build id and the list of files to fetch at install: the entry chunk,
// its static imports and styles, and the exam route with ITS imports (what a learner needs to reload an exam offline). With VITE_SERVICE_WORKER=off it
// emits the RETIRING worker (sw/sw-retire.js) instead, which removes any installed worker and its caches.

export const SW_DIR = join(import.meta.dirname, 'sw');
export const EXAM_PAGE = 'features/assessments/exam/ExamPage';

export interface SwConfig {
  buildId: string;
  precache: string[];
}

/** The worker text for a configuration (pure: the unit tests call it). */
export function renderServiceWorker(template: string, config: SwConfig): string {
  if (!template.includes('__SW_CONFIG__'))
    throw new Error('the worker template has no __SW_CONFIG__ placeholder');
  return template.replace('__SW_CONFIG__', JSON.stringify(config));
}

export interface ChunkInfo {
  fileName: string;
  /** file names of the chunks it imports statically */
  imports: string[];
  /** file names of its stylesheets */
  css: string[];
  isEntry: boolean;
  /** the source module of the chunk, when it has one */
  facadeModuleId: string | null;
}

/** URL paths of the entry chunk(s), the exam route chunk and everything either imports statically (stylesheets included), sorted. */
export function precacheList(chunks: ChunkInfo[]): string[] {
  const byFile = new Map(chunks.map((c) => [c.fileName, c]));
  const out = new Set<string>();
  const visit = (file: string) => {
    const chunk = byFile.get(file);
    if (!chunk || out.has(`/${file}`)) return;
    out.add(`/${file}`);
    for (const css of chunk.css) out.add(`/${css}`);
    for (const dep of chunk.imports) visit(dep);
  };
  for (const c of chunks) {
    const exam = c.facadeModuleId?.replace(/\\/g, '/').includes(EXAM_PAGE) === true;
    if (c.isEntry || exam) visit(c.fileName);
  }
  return [...out].sort();
}

export function serviceWorkerPlugin(opts: { buildId: string; retire: boolean }): Plugin {
  return {
    name: 'lms-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      if (opts.retire) {
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: readFileSync(join(SW_DIR, 'sw-retire.js'), 'utf8'),
        });
        return;
      }
      const chunks: ChunkInfo[] = [];
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        const css = (item as { viteMetadata?: { importedCss?: Set<string> } }).viteMetadata
          ?.importedCss;
        chunks.push({
          fileName: item.fileName,
          imports: item.imports,
          css: css ? [...css] : [],
          isEntry: item.isEntry,
          facadeModuleId: item.facadeModuleId,
        });
      }
      const precache = precacheList(chunks);
      if (!precache.some((p) => p.includes('/assets/')))
        throw new Error('the service worker plugin found no entry chunk to precache');
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: renderServiceWorker(readFileSync(join(SW_DIR, 'sw.js'), 'utf8'), {
          buildId: opts.buildId,
          precache,
        }),
      });
    },
  };
}
