/**
 * Resolution d'imports — source unique de verite.
 * Utilise partout : dependency-graph, check, health.
 * Gere la convention ESM (import from './foo.js' → fichier reel foo.ts).
 */

import { resolve, dirname } from 'node:path';

/** Ensemble de chemins de fichiers connus (cles de l'index) */
export type FileSet = { [filePath: string]: unknown };

const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

/**
 * Resout un chemin d'import relatif vers un chemin absolu dans l'index.
 * Retourne le chemin tel qu'il existe dans fileSet, ou null si introuvable.
 */
export function resolveImportPath(fromFile: string, importSource: string, fileSet: FileSet): string | null {
  const dir = dirname(fromFile);
  const base = resolve(dir, importSource);

  // Construire les bases a tester :
  // 1. Le chemin tel quel
  // 2. Le chemin sans l'extension JS (convention ESM : import './foo.js' → fichier foo.ts)
  const bases = [base];
  for (const jsExt of JS_EXTENSIONS) {
    if (base.endsWith(jsExt)) {
      bases.push(base.slice(0, -jsExt.length));
      break;
    }
  }

  for (const b of bases) {
    // Forward slashes (Unix / normalized)
    const fwd = b.replace(/\\/g, '/');
    if (fileSet[fwd] !== undefined) return fwd;
    for (const ext of TS_EXTENSIONS) {
      const candidate = fwd + ext;
      if (fileSet[candidate] !== undefined) return candidate;
    }

    // Backslashes (Windows)
    const win = b.replace(/\//g, '\\');
    if (fileSet[win] !== undefined) return win;
    for (const ext of TS_EXTENSIONS) {
      const candidate = win + ext;
      if (fileSet[candidate] !== undefined) return candidate;
    }
  }

  return null;
}

/**
 * Verifie si un import relatif depuis fromFile pointe vers targetFile.
 * Utilise la resolution complete (pas juste le nom de base).
 */
export function importPointsTo(importSource: string, targetFile: string, fromFile: string, fileSet: FileSet): boolean {
  const resolved = resolveImportPath(fromFile, importSource, fileSet);
  return resolved === targetFile;
}
