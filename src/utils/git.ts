/**
 * Utilitaires git pour CodeGuard.
 * Fonctions partagees entre guard (historique), check (signatures), et whatsnew.
 * Toutes les commandes sont synchrones (execSync) — acceptable pour des commandes rapides.
 */

import { execSync } from 'node:child_process';
import { logger } from './logger.js';

export interface GitCommit {
  hash: string;
  date: string;
  author: string;
  message: string;
}

export interface FileDiffStats {
  added: number;
  removed: number;
}

/**
 * Verifie que le projet est un repo git initialise.
 */
export function isGitRepo(projectRoot: string): boolean {
  try {
    execSync('git rev-parse --is-inside-work-tree', {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Derniers commits sur un fichier.
 * Retourne max `maxCount` commits, optionnellement filtres par date.
 */
export function getFileLog(projectRoot: string, filePath: string, maxCount = 10, since?: string): GitCommit[] {
  try {
    const sinceArg = since ? ` --since="${since}"` : '';
    const cmd = `git log --format="%h|%ai|%an|%s" --max-count=${maxCount}${sinceArg} --follow -- "${filePath}"`;

    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return [];

    return output.split('\n').map((line) => {
      const parts = line.split('|');
      const hash = parts[0];
      const date = parts[1]?.trim() ?? '';
      const author = parts[2]?.trim() ?? '';
      const message = parts.slice(3).join('|').trim();
      return { hash, date, author, message };
    });
  } catch (err) {
    logger.warn('git log failed', { filePath, error: String(err) });
    return [];
  }
}

/**
 * Lignes modifiees dans un commit pour un fichier.
 * Parse les @@ hunks du diff pour extraire les numeros de lignes touchees.
 */
export function getChangedLines(projectRoot: string, commitHash: string, filePath: string): number[] {
  try {
    const cmd = `git diff ${commitHash}~1..${commitHash} -- "${filePath}"`;

    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines: number[] = [];
    // Parse les hunks @@ -old,len +new,len @@
    const hunkPattern = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm;
    let match: RegExpExecArray | null;

    while ((match = hunkPattern.exec(output)) !== null) {
      const start = parseInt(match[1], 10);
      const count = match[2] ? parseInt(match[2], 10) : 1;
      for (let i = start; i < start + count; i++) {
        lines.push(i);
      }
    }

    return lines;
  } catch (err) {
    // Cas normal : premier commit (pas de parent) ou fichier renomme
    logger.warn('git diff failed', { commitHash, filePath, error: String(err) });
    return [];
  }
}

/**
 * Lignes ajoutees/supprimees dans un commit pour un fichier.
 * Utilise --numstat pour obtenir les compteurs.
 */
export function getFileDiffStats(projectRoot: string, commitHash: string, filePath: string): FileDiffStats {
  try {
    const cmd = `git diff --numstat ${commitHash}~1..${commitHash} -- "${filePath}"`;

    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return { added: 0, removed: 0 };

    // Format: "added\tremoved\tfilename"
    const parts = output.split('\t');
    const added = parseInt(parts[0], 10) || 0;
    const removed = parseInt(parts[1], 10) || 0;

    return { added, removed };
  } catch {
    return { added: 0, removed: 0 };
  }
}

/**
 * Fichiers modifies depuis une date.
 * Retourne la liste avec le statut (A = ajoute, M = modifie, D = supprime).
 */
export function getChangedFilesSince(projectRoot: string, since: string): { file: string; status: 'A' | 'M' | 'D' }[] {
  try {
    const cmd = `git log --name-status --since="${since}" --format=""`;

    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return [];

    const seen = new Map<string, 'A' | 'M' | 'D'>();

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const statusChar = trimmed[0];
      const file = trimmed.slice(1).trim();

      if (!file) continue;
      if (statusChar !== 'A' && statusChar !== 'M' && statusChar !== 'D') continue;

      // Garder le dernier statut connu (le plus recent en premier dans git log)
      if (!seen.has(file)) {
        seen.set(file, statusChar);
      }
    }

    return Array.from(seen.entries()).map(([file, status]) => ({ file, status }));
  } catch (err) {
    logger.warn('git log --name-status failed', { since, error: String(err) });
    return [];
  }
}

/**
 * Fichiers les plus modifies depuis une date (hotfiles).
 * Retourne les top N fichiers tries par nombre de commits.
 */
export function getHotFiles(projectRoot: string, since: string, top = 5): { file: string; count: number }[] {
  try {
    const cmd = `git log --name-only --since="${since}" --format=""`;

    const output = execSync(cmd, {
      cwd: projectRoot,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    if (!output) return [];

    const counts = new Map<string, number>();

    for (const line of output.split('\n')) {
      const file = line.trim();
      if (!file) continue;
      counts.set(file, (counts.get(file) ?? 0) + 1);
    }

    return Array.from(counts.entries())
      .map(([file, count]) => ({ file, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, top);
  } catch (err) {
    logger.warn('git log --name-only failed', { since, error: String(err) });
    return [];
  }
}
