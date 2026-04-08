/**
 * Outil MCP : whatsnew
 * Resume des changements dans le projet depuis le dernier reindex.
 * A lancer en debut de session pour comprendre le contexte.
 * Combine les donnees git (commits, fichiers) avec l'index (signatures, routes).
 */

import type { ProjectIndex } from '../storage/index-store.js';
import type { RouteInfo } from '../parsers/base-parser.js';
import { isGitRepo, getChangedFilesSince, getHotFiles } from '../utils/git.js';

export interface WhatsnewResult {
  since: string;
  sinceLabel: string;
  filesModified: number;
  filesAdded: number;
  filesDeleted: number;
  /** Fonctions dont la signature a change */
  signatureChanges: { file: string; functionName: string; oldSig: string; newSig: string }[];
  /** Nouvelles routes API */
  newRoutes: { method: string; path: string; file: string }[];
  /** Routes supprimees */
  removedRoutes: { method: string; path: string }[];
  /** Fichiers les plus modifies (top 5) */
  hotFiles: { file: string; count: number }[];
}

export function runWhatsnew(
  index: ProjectIndex,
  snapshot: ProjectIndex | null,
  since?: string,
): WhatsnewResult {
  // Date de reference : parametre > date du snapshot > 7 jours par defaut
  const sinceDate = since
    ?? (snapshot ? new Date(snapshot.indexedAt).toISOString().slice(0, 10) : '7 days ago');

  const sinceLabel = snapshot && !since
    ? new Date(snapshot.indexedAt).toLocaleDateString('fr-FR')
    : sinceDate;

  const result: WhatsnewResult = {
    since: sinceDate,
    sinceLabel,
    filesModified: 0,
    filesAdded: 0,
    filesDeleted: 0,
    signatureChanges: [],
    newRoutes: [],
    removedRoutes: [],
    hotFiles: [],
  };

  // -- Donnees git --
  if (isGitRepo(index.projectRoot)) {
    const changedFiles = getChangedFilesSince(index.projectRoot, sinceDate);
    for (const cf of changedFiles) {
      if (cf.status === 'A') result.filesAdded++;
      else if (cf.status === 'M') result.filesModified++;
      else if (cf.status === 'D') result.filesDeleted++;
    }

    result.hotFiles = getHotFiles(index.projectRoot, sinceDate, 5);
  }

  // -- Comparaison snapshot vs index actuel --
  if (snapshot) {
    // Signatures modifiees
    for (const [filePath, newNode] of Object.entries(index.files)) {
      const oldNode = snapshot.files[filePath];
      if (!oldNode) continue;

      for (const newFn of newNode.functions.filter((f) => f.isExported)) {
        const oldFn = oldNode.functions.find((f) => f.name === newFn.name && f.isExported);
        if (!oldFn) continue;

        const oldSig = oldFn.parameters.map((p) => `${p.name}${p.isOptional ? '?' : ''}${p.type ? ': ' + p.type : ''}`).join(', ');
        const newSig = newFn.parameters.map((p) => `${p.name}${p.isOptional ? '?' : ''}${p.type ? ': ' + p.type : ''}`).join(', ');

        if (oldSig !== newSig) {
          result.signatureChanges.push({
            file: filePath,
            functionName: newFn.name,
            oldSig: `(${oldSig})`,
            newSig: `(${newSig})`,
          });
        }
      }
    }

    // Routes ajoutees/supprimees
    const oldRoutes = collectRoutes(snapshot);
    const newRoutes = collectRoutes(index);

    for (const [key, route] of newRoutes) {
      if (!oldRoutes.has(key)) {
        result.newRoutes.push({ method: route.method, path: route.path, file: route.filePath });
      }
    }
    for (const [key, route] of oldRoutes) {
      if (!newRoutes.has(key)) {
        result.removedRoutes.push({ method: route.method, path: route.path });
      }
    }
  }

  return result;
}

/** Collecte toutes les routes d'un index dans une Map cle → route */
function collectRoutes(index: ProjectIndex): Map<string, RouteInfo & { filePath: string }> {
  const routes = new Map<string, RouteInfo & { filePath: string }>();
  for (const [filePath, node] of Object.entries(index.files)) {
    for (const route of node.routes) {
      const key = `${route.method} ${route.path}`;
      routes.set(key, { ...route, filePath });
    }
  }
  return routes;
}

/** Formate le resultat pour affichage MCP */
export function formatWhatsnewResult(result: WhatsnewResult): string {
  const lines: string[] = [];

  const total = result.filesModified + result.filesAdded + result.filesDeleted;
  lines.push(`## Quoi de neuf (depuis le ${result.sinceLabel})`);
  lines.push('');

  if (total === 0 && result.signatureChanges.length === 0) {
    lines.push('Aucun changement detecte.');
    return lines.join('\n');
  }

  lines.push(`**${result.filesModified} fichier(s) modifie(s)** | ${result.filesAdded} ajoute(s) | ${result.filesDeleted} supprime(s)`);

  // Signatures modifiees
  if (result.signatureChanges.length > 0) {
    lines.push('');
    lines.push('### Signatures modifiees');
    for (const sc of result.signatureChanges) {
      const shortFile = sc.file.replace(/\\/g, '/').split('/').slice(-2).join('/');
      lines.push(`- ${sc.functionName}() dans ${shortFile} : ${sc.oldSig} → ${sc.newSig}`);
    }
    lines.push(`⚠ Verifier les appelants de ces fonctions.`);
  }

  // Nouvelles routes
  if (result.newRoutes.length > 0) {
    lines.push('');
    lines.push('### Nouvelles routes');
    for (const r of result.newRoutes) {
      const shortFile = r.file.replace(/\\/g, '/').split('/').slice(-2).join('/');
      lines.push(`- ${r.method} ${r.path} — ${shortFile}`);
    }
  }

  // Routes supprimees
  if (result.removedRoutes.length > 0) {
    lines.push('');
    lines.push('### Routes supprimees');
    for (const r of result.removedRoutes) {
      lines.push(`- ~~${r.method} ${r.path}~~`);
    }
  }

  // Fichiers les plus actifs
  if (result.hotFiles.length > 0) {
    lines.push('');
    lines.push('### Fichiers les plus actifs');
    lines.push('| Fichier | Modifications |');
    lines.push('|---|---|');
    for (const hf of result.hotFiles) {
      lines.push(`| ${hf.file} | ${hf.count} commit(s) |`);
    }
  }

  return lines.join('\n');
}
