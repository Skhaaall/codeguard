/**
 * Outil MCP : guard
 * "Est-ce safe de modifier ce fichier ?"
 * Analyse les risques AVANT modification et donne une recommandation.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import { ImpactResolver } from '../graph/impact-resolver.js';
import type { ImpactResult } from '../graph/impact-resolver.js';
import { DependencyGraph } from '../graph/dependency-graph.js';

export interface GuardWarning {
  level: 'info' | 'warn' | 'danger';
  message: string;
}

export interface GuardResult {
  filePath: string;
  /** Recommendation globale */
  safe: boolean;
  /** Risque global (herite de l'impact analysis) */
  risk: ImpactResult['risk'];
  /** Avertissements detailles */
  warnings: GuardWarning[];
  /** Fichiers a verifier apres la modification */
  filesToCheck: string[];
  /** Exports du fichier (ce qui peut casser les dependants) */
  exports: string[];
  /** Nombre total de fichiers impactes */
  impactCount: number;
}

export function runGuard(index: ProjectIndex, filePath: string): GuardResult {
  const resolver = new ImpactResolver(index);
  const impact = resolver.resolve(filePath);
  const graph = DependencyGraph.fromIndex(index);
  const node = index.files[filePath];

  const warnings: GuardWarning[] = [];

  // -- Analyse des risques --

  // Fichier tres partage
  const directDeps = impact.directDependents;
  if (directDeps.length >= 10) {
    warnings.push({
      level: 'danger',
      message: `Fichier tres partage : ${directDeps.length} fichiers l'importent directement. Toute modification peut casser en cascade.`,
    });
  } else if (directDeps.length >= 5) {
    warnings.push({
      level: 'warn',
      message: `${directDeps.length} fichiers importent ce fichier directement.`,
    });
  }

  // Exporte beaucoup de symboles
  const exports = node?.exports.map((e) => e.name) ?? [];
  if (exports.length >= 10) {
    warnings.push({
      level: 'warn',
      message: `${exports.length} exports — modifier un seul peut avoir un effet domino.`,
    });
  }

  // Fichier dans un domaine sensible
  const normalized = filePath.replace(/\\/g, '/');
  if (normalized.includes('/auth') || normalized.includes('/middleware') || normalized.includes('/guard')) {
    warnings.push({
      level: 'danger',
      message: 'Fichier dans un domaine sensible (auth/middleware/guard). Verifier la securite apres modification.',
    });
  }
  if (normalized.includes('schema.prisma') || normalized.includes('/models/')) {
    warnings.push({
      level: 'danger',
      message: 'Fichier lie au schema de donnees. Penser a prisma db push + verifier les DTOs et types frontend.',
    });
  }
  if (normalized.includes('/config') || normalized.includes('.config.')) {
    warnings.push({
      level: 'warn',
      message: 'Fichier de configuration. Impact potentiel sur tout le projet.',
    });
  }

  // Routes API impactees
  if (impact.affectedRoutes.length > 0) {
    warnings.push({
      level: 'warn',
      message: `${impact.affectedRoutes.length} route(s) API affectee(s) : ${impact.affectedRoutes.map((r) => `${r.method} ${r.path}`).join(', ')}`,
    });
  }

  // Cascade profonde
  const indirectCount = impact.allDependents.length - directDeps.length;
  if (indirectCount > 0) {
    warnings.push({
      level: 'info',
      message: `${indirectCount} fichier(s) impacte(s) en cascade (transitif).`,
    });
  }

  // Fichier non indexe (inconnu)
  if (!node) {
    warnings.push({
      level: 'info',
      message: 'Fichier absent de l\'index. Lancez "reindex" pour une analyse complete.',
    });
  }

  // -- Recommandation --
  const safe = impact.risk === 'low' || impact.risk === 'medium';

  // Fichiers a verifier : les dependants directs en priorite
  const filesToCheck = [...directDeps];
  // Ajouter les fichiers de routes impactes s'ils ne sont pas deja dans la liste
  for (const route of impact.affectedRoutes) {
    if (!filesToCheck.includes(route.filePath)) {
      filesToCheck.push(route.filePath);
    }
  }

  return {
    filePath,
    safe,
    risk: impact.risk,
    warnings,
    filesToCheck,
    exports,
    impactCount: impact.impactCount,
  };
}

/** Formate le resultat pour affichage MCP */
export function formatGuardResult(result: GuardResult): string {
  const lines: string[] = [];

  const icon = result.safe ? 'OK' : 'ATTENTION';
  lines.push(`## Guard : ${icon} — ${result.filePath}`);
  lines.push(`**Risque** : ${result.risk.toUpperCase()}`);
  lines.push(`**Fichiers impactes** : ${result.impactCount}`);

  if (result.warnings.length > 0) {
    lines.push('');
    lines.push('### Avertissements');
    for (const w of result.warnings) {
      const prefix = w.level === 'danger' ? '/!\\ ' : w.level === 'warn' ? '! ' : '';
      lines.push(`- ${prefix}${w.message}`);
    }
  }

  if (result.filesToCheck.length > 0) {
    lines.push('');
    lines.push('### Fichiers a verifier apres modification');
    for (const f of result.filesToCheck) {
      lines.push(`- ${f}`);
    }
  }

  if (result.exports.length > 0) {
    lines.push('');
    lines.push(`### Exports (${result.exports.length}) — ne pas supprimer/renommer sans verifier`);
    lines.push(result.exports.join(', '));
  }

  if (!result.safe) {
    lines.push('');
    lines.push('> Modification risquee. Verifier les fichiers listes ci-dessus apres le changement.');
  }

  return lines.join('\n');
}
