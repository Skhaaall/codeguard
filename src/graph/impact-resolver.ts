/**
 * Calcul d'impact — "je modifie X, qu'est-ce qui casse ?"
 * Utilise le graphe de dependances pour un BFS transitif
 * et enrichit avec le contexte (routes, types, score de risque).
 */

import type { ProjectIndex } from '../storage/index-store.js';
import type { RouteInfo } from '../parsers/base-parser.js';
import { DependencyGraph } from './dependency-graph.js';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface ImpactResult {
  /** Fichier source de la modification */
  sourceFile: string;
  /** Fichiers impactes directement (1 niveau) */
  directDependents: string[];
  /** Tous les fichiers impactes (transitif) */
  allDependents: string[];
  /** Routes API affectees */
  affectedRoutes: RouteInfo[];
  /** Types/interfaces exportes qui changent potentiellement */
  affectedExports: string[];
  /** Score de risque global */
  risk: RiskLevel;
  /** Raisons du score de risque */
  riskReasons: string[];
  /** Nombre total de fichiers impactes */
  impactCount: number;
}

export class ImpactResolver {
  private graph: DependencyGraph;
  private index: ProjectIndex;

  constructor(index: ProjectIndex) {
    this.index = index;
    this.graph = DependencyGraph.fromIndex(index);
  }

  /** Calcule l'impact complet d'une modification sur un fichier */
  resolve(filePath: string): ImpactResult {
    const directDependents = this.graph.getDependents(filePath);
    const allDependents = this.graph.getTransitiveDependents(filePath);
    const affectedRoutes = this.findAffectedRoutes(allDependents);
    const affectedExports = this.findAffectedExports(filePath);
    const { risk, riskReasons } = this.calculateRisk(filePath, allDependents, affectedRoutes);

    return {
      sourceFile: filePath,
      directDependents,
      allDependents,
      affectedRoutes,
      affectedExports,
      risk,
      riskReasons,
      impactCount: allDependents.length,
    };
  }

  /** Trouve toutes les routes API dans les fichiers impactes */
  private findAffectedRoutes(dependents: string[]): RouteInfo[] {
    const routes: RouteInfo[] = [];
    for (const dep of dependents) {
      const node = this.index.files[dep];
      if (node?.routes.length) {
        routes.push(...node.routes);
      }
    }
    return routes;
  }

  /** Liste les exports du fichier modifie (ce qui peut casser les dependants) */
  private findAffectedExports(filePath: string): string[] {
    const node = this.index.files[filePath];
    if (!node) return [];
    return node.exports.map((e) => e.name);
  }

  /** Calcule le score de risque */
  private calculateRisk(
    filePath: string,
    allDependents: string[],
    affectedRoutes: RouteInfo[],
  ): { risk: RiskLevel; riskReasons: string[] } {
    const reasons: string[] = [];
    let score = 0;

    // Nombre de fichiers impactes
    if (allDependents.length >= 20) {
      score += 3;
      reasons.push(`${allDependents.length} fichiers impactes (cascade large)`);
    } else if (allDependents.length >= 10) {
      score += 2;
      reasons.push(`${allDependents.length} fichiers impactes`);
    } else if (allDependents.length >= 3) {
      score += 1;
      reasons.push(`${allDependents.length} fichiers impactes`);
    }

    // Routes API touchees
    if (affectedRoutes.length >= 5) {
      score += 3;
      reasons.push(`${affectedRoutes.length} routes API affectees`);
    } else if (affectedRoutes.length >= 1) {
      score += 1;
      reasons.push(`${affectedRoutes.length} route(s) API affectee(s)`);
    }

    // Fichier partage (beaucoup d'imports directs)
    const directDeps = this.graph.getDependents(filePath);
    if (directDeps.length >= 10) {
      score += 2;
      reasons.push(`Fichier tres partage (${directDeps.length} imports directs)`);
    }

    // Fichiers sensibles
    const normalized = filePath.replace(/\\/g, '/');
    if (normalized.includes('/auth') || normalized.includes('/middleware')) {
      score += 2;
      reasons.push('Fichier dans un domaine sensible (auth/middleware)');
    }
    if (normalized.includes('schema.prisma') || normalized.includes('/models/')) {
      score += 2;
      reasons.push('Fichier lie au schema de donnees');
    }

    // Calcul du niveau
    let risk: RiskLevel;
    if (score >= 6) risk = 'critical';
    else if (score >= 4) risk = 'high';
    else if (score >= 2) risk = 'medium';
    else risk = 'low';

    if (reasons.length === 0) {
      reasons.push('Impact limite');
    }

    return { risk, riskReasons: reasons };
  }
}
