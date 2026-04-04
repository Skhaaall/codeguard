/**
 * Outil MCP : graph
 * Genere un diagramme Mermaid du graphe de dependances.
 * Deux modes : complet (tout le projet) ou focus (centre sur un fichier).
 */

import type { ProjectIndex } from '../storage/index-store.js';
import { DependencyGraph } from '../graph/dependency-graph.js';

export interface GraphResult {
  /** Code Mermaid du diagramme */
  mermaid: string;
  /** Nombre de noeuds dans le diagramme */
  nodeCount: number;
  /** Nombre d'aretes dans le diagramme */
  edgeCount: number;
  /** Mode utilise */
  mode: 'full' | 'focus';
}

export function generateGraph(
  index: ProjectIndex,
  focusFile?: string,
): GraphResult {
  const graph = DependencyGraph.fromIndex(index);
  const edges = graph.getEdges();

  if (focusFile) {
    return generateFocusGraph(graph, index, focusFile);
  }
  return generateFullGraph(graph, index, edges);
}

/** Graphe complet du projet */
function generateFullGraph(
  graph: DependencyGraph,
  index: ProjectIndex,
  edges: ReturnType<DependencyGraph['getEdges']>,
): GraphResult {
  const lines: string[] = ['graph LR'];
  const nodeIds = new Map<string, string>();
  let nodeCounter = 0;

  function getNodeId(filePath: string): string {
    if (!nodeIds.has(filePath)) {
      nodeIds.set(filePath, `N${nodeCounter++}`);
    }
    return nodeIds.get(filePath)!;
  }

  // Declarer les noeuds avec des labels courts
  const allFiles = new Set<string>();
  for (const edge of edges) {
    allFiles.add(edge.from);
    allFiles.add(edge.to);
  }

  for (const filePath of allFiles) {
    const id = getNodeId(filePath);
    const label = shortLabel(filePath);
    const shape = getNodeShape(filePath, index);
    lines.push(`  ${id}${shape[0]}"${label}"${shape[1]}`);
  }

  // Aretes
  for (const edge of edges) {
    const fromId = getNodeId(edge.from);
    const toId = getNodeId(edge.to);
    lines.push(`  ${fromId} --> ${toId}`);
  }

  // Styles par type de fichier
  const styles = generateStyles(allFiles, index, nodeIds);
  lines.push(...styles);

  return {
    mermaid: lines.join('\n'),
    nodeCount: allFiles.size,
    edgeCount: edges.length,
    mode: 'full',
  };
}

/** Graphe centre sur un fichier (dependances + dependants a 2 niveaux) */
function generateFocusGraph(
  graph: DependencyGraph,
  index: ProjectIndex,
  focusFile: string,
): GraphResult {
  const lines: string[] = ['graph LR'];
  const nodeIds = new Map<string, string>();
  let nodeCounter = 0;
  const relevantFiles = new Set<string>();
  const relevantEdges: Array<{ from: string; to: string }> = [];

  function getNodeId(filePath: string): string {
    if (!nodeIds.has(filePath)) {
      nodeIds.set(filePath, `N${nodeCounter++}`);
    }
    return nodeIds.get(filePath)!;
  }

  // Le fichier focus
  relevantFiles.add(focusFile);

  // Dependances directes (ce fichier importe)
  const deps = graph.getDependencies(focusFile);
  for (const dep of deps) {
    relevantFiles.add(dep);
    relevantEdges.push({ from: focusFile, to: dep });
  }

  // Dependants directs (qui importe ce fichier)
  const dependents = graph.getDependents(focusFile);
  for (const dep of dependents) {
    relevantFiles.add(dep);
    relevantEdges.push({ from: dep, to: focusFile });

    // Dependants de niveau 2
    const level2 = graph.getDependents(dep);
    for (const dep2 of level2) {
      if (!relevantFiles.has(dep2)) {
        relevantFiles.add(dep2);
        relevantEdges.push({ from: dep2, to: dep });
      }
    }
  }

  // Declarer les noeuds
  for (const filePath of relevantFiles) {
    const id = getNodeId(filePath);
    const label = shortLabel(filePath);
    const shape = getNodeShape(filePath, index);
    lines.push(`  ${id}${shape[0]}"${label}"${shape[1]}`);
  }

  // Aretes
  for (const edge of relevantEdges) {
    const fromId = getNodeId(edge.from);
    const toId = getNodeId(edge.to);
    lines.push(`  ${fromId} --> ${toId}`);
  }

  // Style focus
  const focusId = getNodeId(focusFile);
  lines.push(`  style ${focusId} fill:#ff6b6b,stroke:#c92a2a,stroke-width:3px,color:#fff`);

  // Styles par type
  const styles = generateStyles(relevantFiles, index, nodeIds);
  lines.push(...styles);

  return {
    mermaid: lines.join('\n'),
    nodeCount: relevantFiles.size,
    edgeCount: relevantEdges.length,
    mode: 'focus',
  };
}

/** Extrait un label court depuis un chemin de fichier */
function shortLabel(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const srcIdx = normalized.lastIndexOf('/src/');
  if (srcIdx !== -1) {
    return normalized.slice(srcIdx + 5).replace(/\.(ts|tsx|js|jsx)$/, '');
  }
  return normalized.split('/').slice(-2).join('/').replace(/\.(ts|tsx|js|jsx)$/, '');
}

/** Forme du noeud selon le type de fichier */
function getNodeShape(filePath: string, index: ProjectIndex): [string, string] {
  const node = index.files[filePath];
  const normalized = filePath.replace(/\\/g, '/');

  // Routes API = hexagone
  if (node?.routes && node.routes.length > 0) return ['{{', '}}'];
  if (/\/route\.(ts|js)$/.test(normalized)) return ['{{', '}}'];

  // Pages = rectangle arrondi
  if (/\/page\.(tsx?|jsx?)$/.test(normalized)) return ['(', ')'];

  // Types/interfaces purs = losange
  if (node && node.exports.length > 0 && node.exports.every((e) => e.isTypeOnly)) return ['{', '}'];

  // Defaut = rectangle
  return ['["', '"]'];
}

/** Genere les styles CSS par categorie de fichier */
function generateStyles(
  files: Set<string>,
  index: ProjectIndex,
  nodeIds: Map<string, string>,
): string[] {
  const styles: string[] = [];
  const parsers: string[] = [];
  const tools: string[] = [];
  const utils: string[] = [];
  const graph: string[] = [];

  for (const filePath of files) {
    const id = nodeIds.get(filePath);
    if (!id) continue;
    const normalized = filePath.replace(/\\/g, '/');

    if (normalized.includes('/parsers/')) parsers.push(id);
    else if (normalized.includes('/tools/')) tools.push(id);
    else if (normalized.includes('/utils/') || normalized.includes('/storage/')) utils.push(id);
    else if (normalized.includes('/graph/')) graph.push(id);
  }

  if (parsers.length > 0) styles.push(`  classDef parser fill:#4dabf7,stroke:#1971c2,color:#fff`);
  if (tools.length > 0) styles.push(`  classDef tool fill:#69db7c,stroke:#2b8a3e,color:#fff`);
  if (utils.length > 0) styles.push(`  classDef util fill:#ffd43b,stroke:#e67700,color:#333`);
  if (graph.length > 0) styles.push(`  classDef graphMod fill:#da77f2,stroke:#9c36b5,color:#fff`);

  if (parsers.length > 0) styles.push(`  class ${parsers.join(',')} parser`);
  if (tools.length > 0) styles.push(`  class ${tools.join(',')} tool`);
  if (utils.length > 0) styles.push(`  class ${utils.join(',')} util`);
  if (graph.length > 0) styles.push(`  class ${graph.join(',')} graphMod`);

  return styles;
}

/** Formate le resultat pour affichage MCP */
export function formatGraphResult(result: GraphResult): string {
  const lines: string[] = [];

  lines.push(`## Graphe de dependances (${result.mode === 'focus' ? 'focus' : 'complet'})`);
  lines.push(`**Noeuds** : ${result.nodeCount} | **Aretes** : ${result.edgeCount}`);
  lines.push('');
  lines.push('```mermaid');
  lines.push(result.mermaid);
  lines.push('```');

  return lines.join('\n');
}
