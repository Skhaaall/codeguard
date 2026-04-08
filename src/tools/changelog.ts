/**
 * Outil MCP : changelog
 * Compare l'ancien index (snapshot) avec l'index actuel.
 * Genere un diff lisible : fichiers, exports, routes, types ajoutes/supprimes.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import type { FileNode, ExportInfo, RouteInfo } from '../parsers/base-parser.js';

export interface ChangelogEntry {
  category: 'file' | 'export' | 'route' | 'type' | 'import';
  action: 'added' | 'removed' | 'modified';
  description: string;
  filePath: string;
}

export interface ChangelogResult {
  /** Snapshot disponible ? */
  hasSnapshot: boolean;
  /** Date du snapshot */
  snapshotDate: number | null;
  /** Date de l'index actuel */
  currentDate: number;
  /** Liste des changements */
  entries: ChangelogEntry[];
  /** Resume */
  summary: {
    filesAdded: number;
    filesRemoved: number;
    filesModified: number;
    exportsAdded: number;
    exportsRemoved: number;
    routesAdded: number;
    routesRemoved: number;
  };
}

export function runChangelog(current: ProjectIndex, snapshot: ProjectIndex | null): ChangelogResult {
  if (!snapshot) {
    return {
      hasSnapshot: false,
      snapshotDate: null,
      currentDate: current.indexedAt,
      entries: [],
      summary: {
        filesAdded: 0,
        filesRemoved: 0,
        filesModified: 0,
        exportsAdded: 0,
        exportsRemoved: 0,
        routesAdded: 0,
        routesRemoved: 0,
      },
    };
  }

  const entries: ChangelogEntry[] = [];
  const currentFiles = new Set(Object.keys(current.files));
  const snapshotFiles = new Set(Object.keys(snapshot.files));

  let filesAdded = 0;
  let filesRemoved = 0;
  let filesModified = 0;
  let exportsAdded = 0;
  let exportsRemoved = 0;
  let routesAdded = 0;
  let routesRemoved = 0;

  // Fichiers ajoutes
  for (const filePath of currentFiles) {
    if (!snapshotFiles.has(filePath)) {
      filesAdded++;
      entries.push({ category: 'file', action: 'added', description: `Nouveau fichier`, filePath });

      // Tous les exports de ce fichier sont "nouveaux"
      const node = current.files[filePath];
      for (const exp of node.exports) {
        exportsAdded++;
        entries.push({
          category: 'export',
          action: 'added',
          description: `Export ajoute : ${exp.name} (${exp.kind})`,
          filePath,
        });
      }
      for (const route of node.routes) {
        routesAdded++;
        entries.push({
          category: 'route',
          action: 'added',
          description: `Route ajoutee : ${route.method} ${route.path}`,
          filePath,
        });
      }
    }
  }

  // Fichiers supprimes
  for (const filePath of snapshotFiles) {
    if (!currentFiles.has(filePath)) {
      filesRemoved++;
      entries.push({ category: 'file', action: 'removed', description: `Fichier supprime`, filePath });

      const node = snapshot.files[filePath];
      for (const exp of node.exports) {
        exportsRemoved++;
        entries.push({
          category: 'export',
          action: 'removed',
          description: `Export supprime : ${exp.name} (${exp.kind})`,
          filePath,
        });
      }
      for (const route of node.routes) {
        routesRemoved++;
        entries.push({
          category: 'route',
          action: 'removed',
          description: `Route supprimee : ${route.method} ${route.path}`,
          filePath,
        });
      }
    }
  }

  // Fichiers modifies (presents dans les deux mais differents)
  for (const filePath of currentFiles) {
    if (!snapshotFiles.has(filePath)) continue;

    const oldNode = snapshot.files[filePath];
    const newNode = current.files[filePath];

    const changes = diffFileNode(oldNode, newNode);
    if (changes.length > 0) {
      filesModified++;
      for (const change of changes) {
        entries.push({ ...change, filePath });
        if (change.category === 'export') {
          if (change.action === 'added') exportsAdded++;
          if (change.action === 'removed') exportsRemoved++;
        }
        if (change.category === 'route') {
          if (change.action === 'added') routesAdded++;
          if (change.action === 'removed') routesRemoved++;
        }
      }
    }
  }

  return {
    hasSnapshot: true,
    snapshotDate: snapshot.indexedAt,
    currentDate: current.indexedAt,
    entries,
    summary: { filesAdded, filesRemoved, filesModified, exportsAdded, exportsRemoved, routesAdded, routesRemoved },
  };
}

/** Compare deux FileNode et retourne les differences */
function diffFileNode(oldNode: FileNode, newNode: FileNode): Omit<ChangelogEntry, 'filePath'>[] {
  const changes: Omit<ChangelogEntry, 'filePath'>[] = [];

  // Diff exports
  const oldExports = new Map(oldNode.exports.map((e) => [exportKey(e), e]));
  const newExports = new Map(newNode.exports.map((e) => [exportKey(e), e]));

  for (const [key, exp] of newExports) {
    if (!oldExports.has(key)) {
      changes.push({ category: 'export', action: 'added', description: `Export ajoute : ${exp.name} (${exp.kind})` });
    }
  }
  for (const [key, exp] of oldExports) {
    if (!newExports.has(key)) {
      changes.push({
        category: 'export',
        action: 'removed',
        description: `Export supprime : ${exp.name} (${exp.kind})`,
      });
    }
  }

  // Diff routes
  const oldRoutes = new Map(oldNode.routes.map((r) => [routeKey(r), r]));
  const newRoutes = new Map(newNode.routes.map((r) => [routeKey(r), r]));

  for (const [key, route] of newRoutes) {
    if (!oldRoutes.has(key)) {
      changes.push({
        category: 'route',
        action: 'added',
        description: `Route ajoutee : ${route.method} ${route.path}`,
      });
    }
  }
  for (const [key, route] of oldRoutes) {
    if (!newRoutes.has(key)) {
      changes.push({
        category: 'route',
        action: 'removed',
        description: `Route supprimee : ${route.method} ${route.path}`,
      });
    }
  }

  // Diff types (proprietes ajoutees/supprimees dans les interfaces)
  const oldTypes = new Map(oldNode.types.map((t) => [t.name, t]));
  const newTypes = new Map(newNode.types.map((t) => [t.name, t]));

  for (const [name, newType] of newTypes) {
    const oldType = oldTypes.get(name);
    if (!oldType) continue; // nouveau type = deja couvert par les exports

    const oldProps = new Set(oldType.properties.map((p) => `${p.name}:${p.type}`));
    const newProps = new Set(newType.properties.map((p) => `${p.name}:${p.type}`));

    for (const prop of newProps) {
      if (!oldProps.has(prop)) {
        const propName = prop.split(':')[0];
        changes.push({
          category: 'type',
          action: 'modified',
          description: `Type ${name} : propriete ajoutee "${propName}"`,
        });
      }
    }
    for (const prop of oldProps) {
      if (!newProps.has(prop)) {
        const propName = prop.split(':')[0];
        changes.push({
          category: 'type',
          action: 'modified',
          description: `Type ${name} : propriete supprimee "${propName}"`,
        });
      }
    }
  }

  // Diff imports (nouveaux imports / imports supprimes)
  const oldImportSources = new Set(oldNode.imports.map((i) => i.source));
  const newImportSources = new Set(newNode.imports.map((i) => i.source));

  for (const source of newImportSources) {
    if (!oldImportSources.has(source)) {
      changes.push({ category: 'import', action: 'added', description: `Import ajoute : ${source}` });
    }
  }
  for (const source of oldImportSources) {
    if (!newImportSources.has(source)) {
      changes.push({ category: 'import', action: 'removed', description: `Import supprime : ${source}` });
    }
  }

  return changes;
}

function exportKey(exp: ExportInfo): string {
  return `${exp.name}:${exp.kind}`;
}

function routeKey(route: RouteInfo): string {
  return `${route.method}:${route.path}`;
}

/** Formate le resultat pour affichage MCP */
export function formatChangelogResult(result: ChangelogResult): string {
  const lines: string[] = [];

  lines.push('## Changelog');

  if (!result.hasSnapshot) {
    lines.push('');
    lines.push('> Pas de snapshot disponible. Le changelog sera disponible apres le prochain reindex.');
    lines.push("> (Le reindex sauvegarde automatiquement un snapshot de l'ancien index)");
    return lines.join('\n');
  }

  if (result.snapshotDate === null) return lines.join('\n');
  const snapshotDate = new Date(result.snapshotDate).toLocaleString('fr-FR');
  const currentDate = new Date(result.currentDate).toLocaleString('fr-FR');
  lines.push(`- Avant : ${snapshotDate}`);
  lines.push(`- Apres : ${currentDate}`);

  const s = result.summary;
  if (s.filesAdded + s.filesRemoved + s.filesModified === 0) {
    lines.push('');
    lines.push('> Aucun changement detecte depuis le dernier reindex.');
    return lines.join('\n');
  }

  lines.push(`- Fichiers : +${s.filesAdded} / -${s.filesRemoved} / ~${s.filesModified}`);
  lines.push(`- Exports : +${s.exportsAdded} / -${s.exportsRemoved}`);
  lines.push(`- Routes : +${s.routesAdded} / -${s.routesRemoved}`);

  // Grouper par fichier
  const byFile = new Map<string, ChangelogEntry[]>();
  for (const entry of result.entries) {
    const existing = byFile.get(entry.filePath) ?? [];
    existing.push(entry);
    byFile.set(entry.filePath, existing);
  }

  for (const [filePath, entries] of byFile) {
    lines.push('');
    const shortPath = filePath.replace(/\\/g, '/').replace(/.*\/src\//, 'src/');
    const fileEntry = entries.find((e) => e.category === 'file');
    const icon = fileEntry?.action === 'added' ? '(+)' : fileEntry?.action === 'removed' ? '(-)' : '(~)';
    lines.push(`### ${icon} ${shortPath}`);

    for (const entry of entries) {
      if (entry.category === 'file') continue; // deja dans le titre
      const prefix = entry.action === 'added' ? '+' : entry.action === 'removed' ? '-' : '~';
      lines.push(`- ${prefix} ${entry.description}`);
    }
  }

  return lines.join('\n');
}
