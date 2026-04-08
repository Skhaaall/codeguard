/**
 * Outil MCP : impact
 * "Je modifie ce fichier — qu'est-ce qui est touche ?"
 */

import type { ProjectIndex } from '../storage/index-store.js';
import { ImpactResolver } from '../graph/impact-resolver.js';
import type { ImpactResult } from '../graph/impact-resolver.js';

export function runImpactAnalysis(index: ProjectIndex, filePath: string): ImpactResult {
  const resolver = new ImpactResolver(index);
  return resolver.resolve(filePath);
}

/** Formate le resultat pour affichage MCP (texte lisible) */
export function formatImpactResult(result: ImpactResult): string {
  const lines: string[] = [];

  lines.push(`## Impact : ${result.sourceFile}`);
  lines.push(`**Risque** : ${result.risk.toUpperCase()} — ${result.riskReasons.join(', ')}`);
  lines.push(`**Fichiers impactes** : ${result.impactCount}`);

  if (result.directDependents.length > 0) {
    lines.push('');
    lines.push('### Dependants directs');
    for (const dep of result.directDependents) {
      lines.push(`- ${dep}`);
    }
  }

  if (result.allDependents.length > result.directDependents.length) {
    lines.push('');
    lines.push('### Cascade (transitif)');
    const indirect = result.allDependents.filter((d) => !result.directDependents.includes(d));
    for (const dep of indirect) {
      lines.push(`- ${dep}`);
    }
  }

  if (result.affectedRoutes.length > 0) {
    lines.push('');
    lines.push('### Routes API affectees');
    for (const route of result.affectedRoutes) {
      lines.push(`- ${route.method} ${route.path} (${route.handler})`);
    }
  }

  if (result.affectedExports.length > 0) {
    lines.push('');
    lines.push('### Exports concernes');
    lines.push(result.affectedExports.join(', '));
  }

  return lines.join('\n');
}
