/**
 * Outil MCP : health
 * Score de sante global du projet.
 * Scanne l'index complet et detecte les problemes structurels.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { resolveImportPath } from '../utils/import-resolver.js';
import { toShortPath } from '../utils/path.js';

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  file?: string;
}

export interface HealthResult {
  grade: HealthGrade;
  score: number;
  fileCount: number;
  issues: HealthIssue[];
  metrics: {
    brokenImports: number;
    orphanFiles: number;
    highRiskFiles: number;
    circularDeps: number;
    largeFiles: number;
    totalExports: number;
    totalImports: number;
  };
}

export function runHealth(index: ProjectIndex, graph?: DependencyGraph): HealthResult {
  const g = graph ?? DependencyGraph.fromIndex(index);
  const issues: HealthIssue[] = [];
  let penalty = 0;

  const files = Object.entries(index.files);
  let brokenImports = 0;
  let orphanFiles = 0;
  let highRiskFiles = 0;
  let circularDeps = 0;
  let largeFiles = 0;
  let totalExports = 0;
  let totalImports = 0;

  // -- 1. Imports casses (resolution complete) --
  for (const [filePath, node] of files) {
    totalImports += node.imports.length;
    totalExports += node.exports.length;

    for (const imp of node.imports) {
      if (!imp.source.startsWith('.')) continue;

      const resolved = resolveImportPath(filePath, imp.source, index.files);
      if (!resolved) {
        brokenImports++;
        issues.push({
          severity: 'error',
          category: 'Import casse',
          message: `Import "${imp.name}" from "${imp.source}" — cible introuvable`,
          file: filePath,
        });
      }
    }
  }
  penalty += brokenImports * 5;

  // -- 2. Fichiers orphelins --
  for (const [filePath] of files) {
    const dependents = g.getDependents(filePath);
    const deps = g.getDependencies(filePath);
    const normalized = filePath.replace(/\\/g, '/');

    const isEntryPoint = normalized.includes('index.ts') ||
      normalized.includes('index.js') ||
      normalized.includes('main.ts') ||
      normalized.includes('cli.ts') ||
      normalized.includes('/app/') ||
      normalized.includes('route.ts') ||
      normalized.includes('route.js');

    if (dependents.length === 0 && deps.length === 0 && !isEntryPoint) {
      orphanFiles++;
      issues.push({
        severity: 'warning',
        category: 'Fichier orphelin',
        message: 'Ni importe ni importateur — potentiellement du code mort',
        file: filePath,
      });
    }
  }
  penalty += orphanFiles * 2;

  // -- 3. Fichiers a haut risque --
  for (const [filePath] of files) {
    const dependents = g.getDependents(filePath);
    if (dependents.length >= 10) {
      highRiskFiles++;
      issues.push({
        severity: 'warning',
        category: 'Fichier a haut risque',
        message: `${dependents.length} fichiers en dependent — toute modification impacte en cascade`,
        file: filePath,
      });
    }
  }
  penalty += highRiskFiles * 3;

  // -- 4. Dependances circulaires (Tarjan — SCC) --
  const sccs = findStronglyConnectedComponents(g, files.map(([f]) => f));
  circularDeps = sccs.length;
  for (const scc of sccs) {
    issues.push({
      severity: 'error',
      category: 'Dependance circulaire',
      message: scc.map(toShortPath).join(' <-> '),
    });
  }
  penalty += circularDeps * 8;

  // -- 5. Fichiers volumineux --
  for (const [filePath, node] of files) {
    if (node.exports.length >= 15) {
      largeFiles++;
      issues.push({
        severity: 'info',
        category: 'Fichier volumineux',
        message: `${node.exports.length} exports — envisager de decouper`,
        file: filePath,
      });
    }
  }
  penalty += largeFiles;

  // -- Score final --
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const grade = scoreToGrade(score);

  if (brokenImports === 0) {
    issues.push({ severity: 'info', category: 'Imports', message: 'Aucun import casse detecte' });
  }
  if (circularDeps === 0) {
    issues.push({ severity: 'info', category: 'Dependances', message: 'Aucune dependance circulaire' });
  }

  return {
    grade, score, fileCount: files.length, issues,
    metrics: { brokenImports, orphanFiles, highRiskFiles, circularDeps, largeFiles, totalExports, totalImports },
  };
}

function scoreToGrade(score: number): HealthGrade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Tarjan — trouve les composantes fortement connexes (cycles de toute taille).
 * Retourne uniquement les SCC de taille >= 2 (les vrais cycles).
 */
function findStronglyConnectedComponents(graph: DependencyGraph, filePaths: string[]): string[][] {
  let indexCounter = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const result: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, indexCounter);
    lowlinks.set(v, indexCounter);
    indexCounter++;
    stack.push(v);
    onStack.add(v);

    for (const w of graph.getDependencies(v)) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);

      // Uniquement les cycles (SCC de taille >= 2)
      if (scc.length >= 2) {
        result.push(scc);
      }
    }
  }

  for (const v of filePaths) {
    if (!indices.has(v)) {
      strongconnect(v);
    }
  }

  return result;
}

/** Formate le resultat pour affichage MCP */
export function formatHealthResult(result: HealthResult): string {
  const lines: string[] = [];

  lines.push(`## Health : ${result.grade} (${result.score}/100)`);
  lines.push(`**Fichiers indexes** : ${result.fileCount}`);
  lines.push(`**Imports** : ${result.metrics.totalImports} | **Exports** : ${result.metrics.totalExports}`);

  lines.push('');
  lines.push('### Metriques');
  lines.push(`| Metrique | Valeur |`);
  lines.push(`|---|---|`);
  lines.push(`| Imports casses | ${result.metrics.brokenImports} |`);
  lines.push(`| Fichiers orphelins | ${result.metrics.orphanFiles} |`);
  lines.push(`| Fichiers haut risque | ${result.metrics.highRiskFiles} |`);
  lines.push(`| Dependances circulaires | ${result.metrics.circularDeps} |`);
  lines.push(`| Fichiers volumineux | ${result.metrics.largeFiles} |`);

  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const infos = result.issues.filter((i) => i.severity === 'info');

  if (errors.length > 0) {
    lines.push('');
    lines.push('### Erreurs');
    for (const issue of errors) {
      lines.push(`- [${issue.category}] ${issue.message}${issue.file ? ` (${toShortPath(issue.file)})` : ''}`);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('### Avertissements');
    for (const issue of warnings) {
      lines.push(`- [${issue.category}] ${issue.message}${issue.file ? ` (${toShortPath(issue.file)})` : ''}`);
    }
  }

  if (infos.length > 0) {
    lines.push('');
    lines.push('### Info');
    for (const issue of infos) {
      lines.push(`- ${issue.message}`);
    }
  }

  return lines.join('\n');
}
