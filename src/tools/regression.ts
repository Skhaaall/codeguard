/**
 * Outil MCP : regression_map
 * "Je modifie ce fichier — quelles pages/routes dois-je retester ?"
 * Utilise le graphe transitif pour trouver les fichiers "terminaux"
 * (pages, routes API, entry points) impactes par un changement.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import type { FileNode } from '../parsers/base-parser.js';
import { DependencyGraph } from '../graph/dependency-graph.js';

export interface RegressionTarget {
  /** Chemin du fichier terminal (page, route, entry point) */
  filePath: string;
  /** Type de cible */
  kind: 'page' | 'api-route' | 'entry-point' | 'component';
  /** URL/route associee si applicable */
  route?: string;
  /** Distance dans le graphe (1 = dependant direct, 2+ = transitif) */
  depth: number;
}

export interface RegressionResult {
  /** Fichier source modifie */
  sourceFile: string;
  /** Pages/routes a retester */
  targets: RegressionTarget[];
  /** Nombre total de cibles */
  targetCount: number;
}

export function runRegressionMap(index: ProjectIndex, filePath: string): RegressionResult {
  const graph = DependencyGraph.fromIndex(index);
  const targets: RegressionTarget[] = [];

  // BFS depuis le fichier modifie pour trouver les fichiers terminaux
  const visited = new Set<string>();
  const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];

  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    const dependents = graph.getDependents(file);

    for (const dep of dependents) {
      if (visited.has(dep)) continue;
      visited.add(dep);

      const node = index.files[dep];
      const kind = classifyFile(dep, node);

      if (kind) {
        targets.push({
          filePath: dep,
          kind,
          route: extractRoute(dep, node),
          depth: depth + 1,
        });
      }

      // Continuer le BFS meme si c'est une cible (il peut y avoir des cibles plus loin)
      queue.push({ file: dep, depth: depth + 1 });
    }
  }

  // Trier : pages et routes API d'abord, puis par profondeur
  targets.sort((a, b) => {
    const kindOrder = { 'page': 0, 'api-route': 1, 'entry-point': 2, 'component': 3 };
    const kindDiff = kindOrder[a.kind] - kindOrder[b.kind];
    if (kindDiff !== 0) return kindDiff;
    return a.depth - b.depth;
  });

  return {
    sourceFile: filePath,
    targets,
    targetCount: targets.length,
  };
}

/** Classifie un fichier selon son role dans le projet */
function classifyFile(
  filePath: string,
  node: FileNode | undefined,
): RegressionTarget['kind'] | null {
  const normalized = filePath.replace(/\\/g, '/');

  // Pages Next.js (app/**/page.tsx)
  if (/\/app\/.*\/page\.(tsx?|jsx?)$/.test(normalized)) return 'page';
  if (/\/pages\/.*\.(tsx?|jsx?)$/.test(normalized) && !normalized.includes('_app') && !normalized.includes('_document')) return 'page';

  // Routes API
  if (/\/app\/.*\/route\.(ts|js)$/.test(normalized)) return 'api-route';
  if (/\/api\/.*\.(ts|js)$/.test(normalized)) return 'api-route';

  // Controllers NestJS
  if (node?.classes.some((c: { decorators: string[] }) => c.decorators.includes('Controller'))) return 'api-route';

  // Routes detectees par le parser
  if (node?.routes && node.routes.length > 0) return 'api-route';

  // Entry points
  if (normalized.endsWith('/index.ts') || normalized.endsWith('/index.js')) {
    // Seulement les index a la racine de src/, pas les barrels internes
    if (normalized.includes('/src/index.') || normalized.includes('/main.')) return 'entry-point';
  }
  if (normalized.endsWith('/main.ts') || normalized.endsWith('/main.js')) return 'entry-point';

  // Composants React (fichiers dans components/ qui sont des feuilles)
  if (normalized.includes('/components/') && /\.(tsx|jsx)$/.test(normalized)) return 'component';

  return null;
}

/** Extrait la route/URL associee a un fichier */
function extractRoute(
  filePath: string,
  node: FileNode | undefined,
): string | undefined {
  const normalized = filePath.replace(/\\/g, '/');

  // Next.js page : deduire l'URL du chemin
  const pageMatch = normalized.match(/\/app(\/.*?)\/page\.(tsx?|jsx?)$/);
  if (pageMatch) {
    return pageMatch[1].replace(/\[([^\]]+)\]/g, ':$1') || '/';
  }

  // Next.js pages dir
  const pagesMatch = normalized.match(/\/pages(\/.*?)\.(tsx?|jsx?)$/);
  if (pagesMatch) {
    const route = pagesMatch[1].replace(/\/index$/, '') || '/';
    return route.replace(/\[([^\]]+)\]/g, ':$1');
  }

  // Next.js API route
  const apiMatch = normalized.match(/\/app(\/.*?)\/route\.(ts|js)$/);
  if (apiMatch) {
    return apiMatch[1].replace(/\[([^\]]+)\]/g, ':$1');
  }

  // Routes detectees par le parser
  if (node?.routes && node.routes.length > 0) {
    return node.routes.map((r: { method: string; path: string }) => `${r.method} ${r.path}`).join(', ');
  }

  return undefined;
}

function shortPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const srcIdx = normalized.lastIndexOf('/src/');
  if (srcIdx !== -1) return normalized.slice(srcIdx + 1);
  return normalized.split('/').slice(-3).join('/');
}

/** Formate le resultat pour affichage MCP */
export function formatRegressionResult(result: RegressionResult): string {
  const lines: string[] = [];

  lines.push(`## Regression Map : ${shortPath(result.sourceFile)}`);
  lines.push(`**Cibles a retester** : ${result.targetCount}`);

  if (result.targets.length === 0) {
    lines.push('');
    lines.push('> Aucune page, route ou entry point impacte. Pas de regression a craindre.');
    return lines.join('\n');
  }

  const pages = result.targets.filter((t) => t.kind === 'page');
  const apiRoutes = result.targets.filter((t) => t.kind === 'api-route');
  const entryPoints = result.targets.filter((t) => t.kind === 'entry-point');
  const components = result.targets.filter((t) => t.kind === 'component');

  if (pages.length > 0) {
    lines.push('');
    lines.push('### Pages a retester');
    for (const t of pages) {
      lines.push(`- ${t.route ?? shortPath(t.filePath)} (profondeur: ${t.depth})`);
    }
  }

  if (apiRoutes.length > 0) {
    lines.push('');
    lines.push('### Routes API affectees');
    for (const t of apiRoutes) {
      lines.push(`- ${t.route ?? shortPath(t.filePath)} (profondeur: ${t.depth})`);
    }
  }

  if (entryPoints.length > 0) {
    lines.push('');
    lines.push('### Entry points');
    for (const t of entryPoints) {
      lines.push(`- ${shortPath(t.filePath)} (profondeur: ${t.depth})`);
    }
  }

  if (components.length > 0) {
    lines.push('');
    lines.push('### Composants impactes');
    for (const t of components) {
      lines.push(`- ${shortPath(t.filePath)} (profondeur: ${t.depth})`);
    }
  }

  return lines.join('\n');
}
