/**
 * Outil MCP : health
 * Score de sante global du projet.
 * Scanne l'index complet et detecte les problemes structurels.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import { DependencyGraph } from '../graph/dependency-graph.js';

export type HealthGrade = 'A' | 'B' | 'C' | 'D' | 'F';

export interface HealthIssue {
  severity: 'error' | 'warning' | 'info';
  category: string;
  message: string;
  file?: string;
}

export interface HealthResult {
  /** Note globale (A = excellent, F = critique) */
  grade: HealthGrade;
  /** Score numerique (0-100) */
  score: number;
  /** Nombre total de fichiers indexes */
  fileCount: number;
  /** Problemes detectes */
  issues: HealthIssue[];
  /** Metriques detaillees */
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

export function runHealth(index: ProjectIndex): HealthResult {
  const graph = DependencyGraph.fromIndex(index);
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

  // -- 1. Imports casses --
  for (const [filePath, node] of files) {
    totalImports += node.imports.length;
    totalExports += node.exports.length;

    for (const imp of node.imports) {
      if (!imp.source.startsWith('.')) continue; // ignorer les packages externes

      // Verifier si le fichier cible existe dans l'index
      const deps = graph.getDependencies(filePath);
      const importBase = imp.source
        .replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '')
        .split('/')
        .pop() ?? '';

      const found = deps.some((d) => {
        const depBase = d.replace(/\\/g, '/').split('/').pop()?.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '') ?? '';
        return depBase === importBase;
      });

      if (!found && importBase) {
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
  // Chaque import casse = -5 points
  penalty += brokenImports * 5;

  // -- 2. Fichiers orphelins (pas importes, pas un entry point) --
  for (const [filePath] of files) {
    const dependents = graph.getDependents(filePath);
    const deps = graph.getDependencies(filePath);
    const normalized = filePath.replace(/\\/g, '/');

    // Un fichier est orphelin s'il n'est importe par personne ET n'est pas un entry point
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
  // Chaque orphelin = -2 points
  penalty += orphanFiles * 2;

  // -- 3. Fichiers a haut risque (tres partages) --
  for (const [filePath] of files) {
    const dependents = graph.getDependents(filePath);
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
  // Chaque fichier a haut risque = -3 points
  penalty += highRiskFiles * 3;

  // -- 4. Dependances circulaires --
  const circularPairs = detectCircularDeps(graph, files.map(([f]) => f));
  circularDeps = circularPairs.length;
  for (const [a, b] of circularPairs) {
    issues.push({
      severity: 'error',
      category: 'Dependance circulaire',
      message: `${shortPath(a)} <-> ${shortPath(b)}`,
    });
  }
  // Chaque circulaire = -8 points
  penalty += circularDeps * 8;

  // -- 5. Fichiers avec trop d'exports (potentiel god file) --
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
  // Chaque god file = -1 point
  penalty += largeFiles;

  // -- Score final --
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const grade = scoreToGrade(score);

  // Ajouter des infos positives
  if (brokenImports === 0) {
    issues.push({
      severity: 'info',
      category: 'Imports',
      message: 'Aucun import casse detecte',
    });
  }
  if (circularDeps === 0) {
    issues.push({
      severity: 'info',
      category: 'Dependances',
      message: 'Aucune dependance circulaire',
    });
  }

  return {
    grade,
    score,
    fileCount: files.length,
    issues,
    metrics: {
      brokenImports,
      orphanFiles,
      highRiskFiles,
      circularDeps,
      largeFiles,
      totalExports,
      totalImports,
    },
  };
}

function scoreToGrade(score: number): HealthGrade {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/** Detecte les dependances circulaires directes (A → B et B → A) */
function detectCircularDeps(graph: DependencyGraph, filePaths: string[]): [string, string][] {
  const seen = new Set<string>();
  const pairs: [string, string][] = [];

  for (const filePath of filePaths) {
    const deps = graph.getDependencies(filePath);
    for (const dep of deps) {
      const key = [filePath, dep].sort().join('|||');
      if (seen.has(key)) continue;
      seen.add(key);

      // Verifier si dep importe aussi filePath
      const reverseDeps = graph.getDependencies(dep);
      if (reverseDeps.includes(filePath)) {
        pairs.push([filePath, dep]);
      }
    }
  }

  return pairs;
}

function shortPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const srcIdx = normalized.lastIndexOf('/src/');
  if (srcIdx !== -1) return normalized.slice(srcIdx + 1);
  return normalized.split('/').slice(-3).join('/');
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
      lines.push(`- [${issue.category}] ${issue.message}${issue.file ? ` (${shortPath(issue.file)})` : ''}`);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('### Avertissements');
    for (const issue of warnings) {
      lines.push(`- [${issue.category}] ${issue.message}${issue.file ? ` (${shortPath(issue.file)})` : ''}`);
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
