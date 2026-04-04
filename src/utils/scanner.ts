/**
 * Scanner de fichiers — parcourt le projet et retourne les fichiers a indexer.
 * Respecte .gitignore et les dossiers a ignorer (node_modules, .next, dist...).
 */

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { shouldIgnorePath, shouldIgnoreFile, isSupportedFile } from '../parsers/detector.js';

export interface ScanResult {
  files: string[];
  scannedDirs: number;
  ignoredDirs: number;
  duration: number;
}

/** Scanne un projet et retourne tous les fichiers supportes */
export function scanProject(projectRoot: string): ScanResult {
  const start = Date.now();
  const files: string[] = [];
  let scannedDirs = 0;
  let ignoredDirs = 0;

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Permission denied ou lien symbolique casse
    }

    scannedDirs++;

    for (const entry of entries) {
      // Ignorer les liens symboliques (risque de traversee hors projet)
      if (entry.isSymbolicLink()) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        if (shouldIgnorePath(entry.name)) {
          ignoredDirs++;
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile()) {
        if (shouldIgnoreFile(entry.name)) continue;
        if (!isSupportedFile(fullPath)) continue;

        // Ignorer les fichiers de declaration (.d.ts)
        if (entry.name.endsWith('.d.ts')) continue;

        files.push(fullPath);
      }
    }
  }

  walk(projectRoot);

  return {
    files,
    scannedDirs,
    ignoredDirs,
    duration: Date.now() - start,
  };
}
