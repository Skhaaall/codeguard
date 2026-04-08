/**
 * Resolution d'imports — source unique de verite.
 * Utilise partout : dependency-graph, check, health.
 * Gere :
 *   - Convention ESM (import from './foo.js' → fichier reel foo.ts)
 *   - Path aliases TypeScript (import from '@/lib/utils' → src/lib/utils.ts)
 */

import { resolve, dirname, join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';

/** Ensemble de chemins de fichiers connus (cles de l'index) */
export type FileSet = { [filePath: string]: unknown };

/** Un alias : pattern → liste de remplacements */
export interface PathAlias {
  prefix: string; // ex: "@/"
  targets: string[]; // ex: ["src/"]  (chemins absolus apres resolution)
}

const JS_EXTENSIONS = ['.js', '.jsx', '.mjs', '.cjs'];
const TS_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

// Cache des aliases par projet (eviter de relire tsconfig a chaque appel)
const aliasCache = new Map<string, PathAlias[]>();

/**
 * Charge les path aliases depuis les tsconfig.json du projet.
 * Cherche dans la racine, dans backend/ et frontend/ (monorepo).
 */
export function loadPathAliases(projectRoot: string): PathAlias[] {
  if (aliasCache.has(projectRoot)) return aliasCache.get(projectRoot)!;

  const aliases: PathAlias[] = [];
  const tsconfigPaths = [
    join(projectRoot, 'tsconfig.json'),
    join(projectRoot, 'backend', 'tsconfig.json'),
    join(projectRoot, 'frontend', 'tsconfig.json'),
  ];

  for (const tsconfigPath of tsconfigPaths) {
    if (!existsSync(tsconfigPath)) continue;

    try {
      const raw = readFileSync(tsconfigPath, 'utf-8');
      // Essayer le JSON brut d'abord, puis nettoyer les commentaires en fallback
      let config: { compilerOptions?: { paths?: Record<string, string[]>; baseUrl?: string }; [k: string]: unknown };
      try {
        config = JSON.parse(raw);
      } catch {
        // Retirer les commentaires (hors des strings) et trailing commas
        const cleaned = raw
          .replace(/("(?:[^"\\]|\\.)*")|\/\/.*$/gm, (_, str) => str ?? '')
          .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//g, (_, str) => str ?? '')
          .replace(/,\s*([\]}])/g, '$1');
        config = JSON.parse(cleaned);
      }

      const paths = config?.compilerOptions?.paths;
      const baseUrl = config?.compilerOptions?.baseUrl ?? '.';
      const tsconfigDir = dirname(tsconfigPath);
      const resolvedBaseUrl = resolve(tsconfigDir, baseUrl);

      if (paths && typeof paths === 'object') {
        for (const [pattern, targets] of Object.entries(paths)) {
          if (!Array.isArray(targets)) continue;

          // Pattern : "@/*" → prefix "@/"
          const prefix = pattern.replace(/\*$/, '');

          for (const target of targets) {
            // Target : "src/*" → "src/"
            const targetDir = (target as string).replace(/\*$/, '');
            const resolvedTarget = resolve(resolvedBaseUrl, targetDir);
            aliases.push({ prefix, targets: [resolvedTarget] });
          }
        }
      }
    } catch {
      // tsconfig invalide — ignorer
    }
  }

  aliasCache.set(projectRoot, aliases);
  return aliases;
}

/** Vide le cache des aliases (pour les tests ou apres reindex) */
export function clearAliasCache(): void {
  aliasCache.clear();
}

/**
 * Resout un chemin d'import vers un chemin absolu dans l'index.
 * Supporte : chemins relatifs, convention ESM, path aliases TypeScript.
 */
export function resolveImportPath(
  fromFile: string,
  importSource: string,
  fileSet: FileSet,
  projectRoot?: string,
): string | null {
  // 1. Imports relatifs (./ ou ../)
  if (importSource.startsWith('.')) {
    return resolveRelativeImport(fromFile, importSource, fileSet);
  }

  // 2. Path aliases (@/... ou tout alias configure)
  if (projectRoot) {
    const aliases = loadPathAliases(projectRoot);
    for (const alias of aliases) {
      if (importSource.startsWith(alias.prefix)) {
        const rest = importSource.slice(alias.prefix.length);
        for (const targetDir of alias.targets) {
          const resolved = resolve(targetDir, rest);
          const result = tryResolveWithExtensions(resolved, fileSet);
          if (result) return result;
        }
      }
    }
  }

  // 3. Non resolu (package externe ou alias inconnu)
  return null;
}

/** Resout un import relatif (./foo, ../bar) */
function resolveRelativeImport(fromFile: string, importSource: string, fileSet: FileSet): string | null {
  const dir = dirname(fromFile);
  const base = resolve(dir, importSource);

  // Tester avec et sans extension JS (convention ESM)
  const bases = [base];
  for (const jsExt of JS_EXTENSIONS) {
    if (base.endsWith(jsExt)) {
      bases.push(base.slice(0, -jsExt.length));
      break;
    }
  }

  for (const b of bases) {
    const result = tryResolveWithExtensions(b, fileSet);
    if (result) return result;
  }

  return null;
}

/** Essaie de trouver un fichier dans le fileSet avec les extensions TS courantes */
function tryResolveWithExtensions(basePath: string, fileSet: FileSet): string | null {
  // Forward slashes
  const fwd = basePath.replace(/\\/g, '/');
  if (fileSet[fwd] !== undefined) return fwd;
  for (const ext of TS_EXTENSIONS) {
    const candidate = (fwd + ext).replace(/\\/g, '/');
    if (fileSet[candidate] !== undefined) return candidate;
  }

  // Backslashes (Windows)
  const win = basePath.replace(/\//g, '\\');
  if (fileSet[win] !== undefined) return win;
  for (const ext of TS_EXTENSIONS) {
    const candidate = (win + ext).replace(/\//g, '\\');
    if (fileSet[candidate] !== undefined) return candidate;
  }

  return null;
}

/**
 * Verifie si un import depuis fromFile pointe vers targetFile.
 */
export function importPointsTo(
  importSource: string,
  targetFile: string,
  fromFile: string,
  fileSet: FileSet,
  projectRoot?: string,
): boolean {
  const resolved = resolveImportPath(fromFile, importSource, fileSet, projectRoot);
  return resolved === targetFile;
}
