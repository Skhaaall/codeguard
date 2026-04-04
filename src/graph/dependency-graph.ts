/**
 * Graphe de dependances oriente.
 * Chaque fichier est un noeud, chaque import est une arete.
 * Permet de naviguer dans les deux sens :
 *   - dependsOn : "ce fichier depend de..."
 *   - dependedBy : "ce fichier est utilise par..."
 */

import { resolve, dirname } from 'node:path';
import type { ProjectIndex } from '../storage/index-store.js';

export interface DependencyEdge {
  from: string; // fichier qui importe
  to: string;   // fichier importe
  imports: string[]; // noms importes
}

export class DependencyGraph {
  /** Fichier → fichiers dont il depend */
  private dependsOn = new Map<string, Set<string>>();
  /** Fichier → fichiers qui l'utilisent */
  private dependedBy = new Map<string, Set<string>>();
  /** Toutes les aretes avec le detail des imports */
  private edges: DependencyEdge[] = [];

  /** Construit le graphe a partir de l'index du projet */
  static fromIndex(index: ProjectIndex): DependencyGraph {
    const graph = new DependencyGraph();

    for (const [filePath, node] of Object.entries(index.files)) {
      for (const imp of node.imports) {
        // Ignorer les imports de packages externes (pas de ./ ou ../)
        if (!imp.source.startsWith('.')) continue;

        const resolvedTarget = resolveImportPath(filePath, imp.source, index);
        if (!resolvedTarget) continue;

        graph.addEdge(filePath, resolvedTarget, imp.name);
      }
    }

    return graph;
  }

  private addEdge(from: string, to: string, importName: string): void {
    // dependsOn
    if (!this.dependsOn.has(from)) this.dependsOn.set(from, new Set());
    this.dependsOn.get(from)!.add(to);

    // dependedBy (inverse)
    if (!this.dependedBy.has(to)) this.dependedBy.set(to, new Set());
    this.dependedBy.get(to)!.add(from);

    // Edge detail
    const existing = this.edges.find((e) => e.from === from && e.to === to);
    if (existing) {
      existing.imports.push(importName);
    } else {
      this.edges.push({ from, to, imports: [importName] });
    }
  }

  /** Fichiers dont `filePath` depend directement */
  getDependencies(filePath: string): string[] {
    return [...(this.dependsOn.get(filePath) ?? [])];
  }

  /** Fichiers qui importent `filePath` directement */
  getDependents(filePath: string): string[] {
    return [...(this.dependedBy.get(filePath) ?? [])];
  }

  /** Tous les fichiers qui importent `filePath`, directement ou en cascade (BFS) */
  getTransitiveDependents(filePath: string): string[] {
    const visited = new Set<string>();
    const queue = [filePath];

    while (queue.length > 0) {
      const current = queue.shift()!;
      const dependents = this.dependedBy.get(current);
      if (!dependents) continue;

      for (const dep of dependents) {
        if (!visited.has(dep)) {
          visited.add(dep);
          queue.push(dep);
        }
      }
    }

    return [...visited];
  }

  /** Toutes les aretes du graphe */
  getEdges(): DependencyEdge[] {
    return [...this.edges];
  }

  /** Nombre de noeuds uniques */
  getNodeCount(): number {
    const nodes = new Set<string>();
    for (const [from, deps] of this.dependsOn) {
      nodes.add(from);
      for (const d of deps) nodes.add(d);
    }
    return nodes.size;
  }

  /** Nombre d'aretes */
  getEdgeCount(): number {
    return this.edges.length;
  }
}

/**
 * Resout un chemin d'import relatif vers un chemin absolu.
 * Essaie les extensions courantes (.ts, .tsx, /index.ts, etc.)
 */
function resolveImportPath(fromFile: string, importSource: string, index: ProjectIndex): string | null {
  const dir = dirname(fromFile);
  const base = resolve(dir, importSource);
  const normalized = base.replace(/\\/g, '/');

  // Extensions a essayer
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];

  // Essayer le chemin exact d'abord
  if (index.files[normalized]) return normalized;

  // Essayer avec chaque extension
  for (const ext of extensions) {
    const candidate = normalized + ext;
    if (index.files[candidate]) return candidate;
  }

  // Essayer avec les backslashes (Windows)
  const winNormalized = base.replace(/\//g, '\\');
  if (index.files[winNormalized]) return winNormalized;

  for (const ext of extensions) {
    const candidate = winNormalized + ext;
    if (index.files[candidate]) return candidate;
  }

  return null;
}
