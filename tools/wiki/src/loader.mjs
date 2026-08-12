/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — CLI Module Resolver
 *
 *  `src/lib` is written for the Next.js bundler: it uses the `@/*`
 *  path alias and extensionless imports, neither of which Node's ESM
 *  resolver understands. Rather than contort the library (or force
 *  `.ts` extensions on the whole app), the CLI registers this hook.
 *
 *  Node ≥ 22.6 strips the types once the file is resolved; all this
 *  has to do is turn a bundler specifier into a real path.
 * ═══════════════════════════════════════════════════════════════
 */

import { existsSync, statSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), '../../..');
const SRC_ROOT = resolvePath(REPO_ROOT, 'src');
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.js', '.mjs'];

/** Appends the extension (or /index.ts) that makes a bare path a real file. */
function materialize(basePath) {
  if (existsSync(basePath) && statSync(basePath).isFile()) return basePath;
  for (const ext of EXTENSIONS) {
    const candidate = `${basePath}${ext}`;
    if (existsSync(candidate)) return candidate;
  }
  for (const ext of EXTENSIONS) {
    const candidate = resolvePath(basePath, `index${ext}`);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function resolve(specifier, context, nextResolve) {
  // `@/foo` → `<repo>/src/foo`
  if (specifier.startsWith('@/')) {
    const resolved = materialize(resolvePath(SRC_ROOT, specifier.slice(2)));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }

  // Extensionless relative imports from inside the repo.
  if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
    const parentDir = dirname(fileURLToPath(context.parentURL));
    const resolved = materialize(resolvePath(parentDir, specifier));
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
