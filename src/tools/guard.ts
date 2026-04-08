/**
 * Outil MCP : guard
 * "Est-ce safe de modifier ce fichier ?"
 * Analyse les risques AVANT modification et donne une recommandation.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import type { ProjectIndex } from '../storage/index-store.js';
import { ImpactResolver } from '../graph/impact-resolver.js';
import type { ImpactResult } from '../graph/impact-resolver.js';
import { isGitRepo, getFileLog, getChangedLines, getFileDiffStats } from '../utils/git.js';

export interface GuardWarning {
  level: 'info' | 'warn' | 'danger';
  message: string;
}

export interface FileHistory {
  /** Derniers commits qui ont touche ce fichier (max 10) */
  recentCommits: {
    hash: string;
    date: string;
    author: string;
    message: string;
    /** Fonctions dont les lignes sont dans le diff de ce commit */
    functionsChanged: string[];
    /** Lignes ajoutees/supprimees dans ce commit */
    linesAdded: number;
    linesRemoved: number;
  }[];
  /** Nombre total de modifications dans les 30 derniers jours */
  modificationCount30d: number;
  /** Auteurs distincts sur les 30 derniers jours */
  authors: string[];
}

export interface FunctionCoverage {
  functionName: string;
  line: number;
  /** Fichier de test qui semble couvrir cette fonction (ou null) */
  testFile: string | null;
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
  /** Historique git recent du fichier */
  fileHistory: FileHistory | null;
  /** true si le fichier a ete modifie >= 5 fois en 7 jours */
  isHotspot: boolean;
  /** Couverture tests par fonction (heuristique) */
  testCoverage: FunctionCoverage[];
}

export function runGuard(index: ProjectIndex, filePath: string): GuardResult {
  const resolver = new ImpactResolver(index);
  const impact = resolver.resolve(filePath);
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

  // -- Historique git + hotspot --
  let fileHistory: FileHistory | null = null;
  let isHotspot = false;

  if (isGitRepo(index.projectRoot)) {
    // Derniers commits (max 10, 30 jours)
    const recentCommits = getFileLog(index.projectRoot, filePath, 10, '30 days ago');

    if (recentCommits.length > 0) {
      // Fonctions du fichier pour croisement avec les lignes modifiees
      const allFunctions = [...(node?.functions ?? []), ...(node?.classes ?? []).flatMap((c) => c.methods)];

      const enrichedCommits = recentCommits.map((commit) => {
        const changedLines = getChangedLines(index.projectRoot, commit.hash, filePath);
        const functionsChanged = findChangedFunctions(allFunctions, changedLines);
        const stats = getFileDiffStats(index.projectRoot, commit.hash, filePath);
        return {
          ...commit,
          functionsChanged,
          linesAdded: stats.added,
          linesRemoved: stats.removed,
        };
      });

      const authors = [...new Set(recentCommits.map((c) => c.author))];

      fileHistory = {
        recentCommits: enrichedCommits,
        modificationCount30d: recentCommits.length,
        authors,
      };

      // Hotspot : >= 5 commits en 7 jours
      const commits7d = getFileLog(index.projectRoot, filePath, 100, '7 days ago');
      isHotspot = commits7d.length >= 5;

      if (isHotspot) {
        warnings.push({
          level: 'danger',
          message: `HOTSPOT — modifie ${commits7d.length} fois en 7 jours. Fichier instable, considerer le stabiliser avant d'y toucher.`,
        });
      }
    }
  }

  // -- Couverture tests --
  const testCoverage = node ? findTestCoverage(index.projectRoot, filePath, node) : [];

  const untestedFns = testCoverage.filter((c) => !c.testFile);
  if (untestedFns.length > 0 && testCoverage.length > 0) {
    const ratio = `${testCoverage.length - untestedFns.length}/${testCoverage.length}`;
    warnings.push({
      level: untestedFns.length === testCoverage.length ? 'danger' : 'warn',
      message: `Couverture tests : ${ratio} fonctions testees. Sans test : ${untestedFns.map((f) => f.functionName).join(', ')}.`,
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
    fileHistory,
    isHotspot,
    testCoverage,
  };
}

/**
 * Croise les lignes modifiees avec les fonctions du fichier.
 * Heuristique : une fonction est "touchee" si une ligne modifiee
 * est entre sa ligne de debut et la ligne de debut de la fonction suivante.
 */
function findChangedFunctions(functions: { name: string; line: number }[], changedLines: number[]): string[] {
  if (functions.length === 0 || changedLines.length === 0) return [];

  // Trier les fonctions par ligne
  const sorted = [...functions].sort((a, b) => a.line - b.line);
  const changed = new Set<string>();

  for (const lineNum of changedLines) {
    // Trouver la fonction qui contient cette ligne
    for (let i = 0; i < sorted.length; i++) {
      const fn = sorted[i];
      const nextFnLine = sorted[i + 1]?.line ?? Infinity;
      if (lineNum >= fn.line && lineNum < nextFnLine) {
        changed.add(fn.name);
        break;
      }
    }
  }

  return Array.from(changed);
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

  // Historique git recent
  if (result.fileHistory && result.fileHistory.recentCommits.length > 0) {
    const h = result.fileHistory;
    lines.push('');
    lines.push(
      `### Historique recent (${h.modificationCount30d} modif. en 30j, ${h.authors.length} auteur${h.authors.length > 1 ? 's' : ''} : ${h.authors.join(', ')})`,
    );

    for (const commit of h.recentCommits) {
      const dateLabel = formatRelativeDate(commit.date);
      const diffLabel = formatDiffStats(commit.linesAdded, commit.linesRemoved);
      const fns = commit.functionsChanged.length > 0 ? ` → ${commit.functionsChanged.join(', ')}` : '';
      lines.push(`- ${dateLabel} | ${commit.author} | (${commit.hash}) ${commit.message} ${diffLabel}${fns}`);
    }

    // Resume contextuel
    const allChangedFns = new Set(h.recentCommits.flatMap((c) => c.functionsChanged));
    if (allChangedFns.size > 0) {
      lines.push(`⚠ Fonctions modifiees recemment : ${[...allChangedFns].join(', ')}. Verifier avant de reecrire.`);
    }
  }

  // Couverture tests
  if (result.testCoverage.length > 0) {
    const tested = result.testCoverage.filter((c) => c.testFile);
    const untested = result.testCoverage.filter((c) => !c.testFile);

    lines.push('');
    lines.push(`### Couverture tests (${tested.length}/${result.testCoverage.length})`);
    for (const c of result.testCoverage) {
      const icon = c.testFile ? '✓' : '✗';
      const detail = c.testFile ? basename(c.testFile) : 'PAS DE TEST';
      lines.push(`- ${c.functionName}() → ${detail} ${icon}`);
    }
    if (untested.length > 0) {
      lines.push(`⚠ ${untested.length} fonction(s) sans test. Modifier sans filet de securite.`);
    }
  }

  if (!result.safe) {
    lines.push('');
    lines.push('> Modification risquee. Verifier les fichiers listes ci-dessus apres le changement.');
  }

  return lines.join('\n');
}

/**
 * Detecte les fichiers de test qui couvrent les fonctions du fichier source.
 * Heuristique ~70-80% : cherche les fichiers .spec/.test, puis grep les noms de fonctions.
 */
function findTestCoverage(
  projectRoot: string,
  filePath: string,
  node: { functions: { name: string; line: number }[]; classes?: { methods: { name: string; line: number }[] }[] },
): FunctionCoverage[] {
  const normalized = filePath.replace(/\\/g, '/');

  // Extraire le nom de base sans extension (ex: "guard" depuis "src/tools/guard.ts")
  const base = basename(normalized).replace(/\.(ts|tsx|js|jsx)$/, '');

  // Patterns de fichiers de test a chercher
  const dir = dirname(filePath);
  const candidates: string[] = [
    join(dir, `${base}.spec.ts`),
    join(dir, `${base}.test.ts`),
    join(dir, `${base}.spec.tsx`),
    join(dir, `${base}.test.tsx`),
    join(dir, '__tests__', `${base}.ts`),
    join(dir, '__tests__', `${base}.test.ts`),
  ];

  // Chercher aussi dans test/, tests/ a la racine
  for (const testDir of ['test', 'tests', '__tests__']) {
    candidates.push(
      join(projectRoot, testDir, `${base}.spec.ts`),
      join(projectRoot, testDir, `${base}.test.ts`),
      join(projectRoot, testDir, `**${base}**`),
    );
  }

  // Trouver le premier fichier de test qui existe
  const testFiles: string[] = [];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      testFiles.push(candidate);
    }
  }

  // Lire le contenu des fichiers de test
  let testContent = '';
  for (const tf of testFiles) {
    try {
      testContent += readFileSync(tf, 'utf-8') + '\n';
    } catch {
      // Fichier illisible, on continue
    }
  }

  // Toutes les fonctions (top-level + methodes de classes)
  const allFunctions = [...node.functions, ...(node.classes ?? []).flatMap((c) => c.methods)];

  return allFunctions.map((fn) => {
    let testFile: string | null = null;

    if (testContent) {
      // Chercher le nom de la fonction dans le contenu des tests
      // Patterns : describe('fnName'), it('should fnName'), test('fnName'), fnName(
      const namePattern = new RegExp(
        `(?:describe|it|test)\\s*\\(\\s*['"\`].*${escapeRegex(fn.name)}|${escapeRegex(fn.name)}\\s*\\(`,
      );
      if (namePattern.test(testContent)) {
        testFile = testFiles[0].replace(/\\/g, '/');
      }
    }

    return { functionName: fn.name, line: fn.line, testFile };
  });
}

/** Echappe les caracteres speciaux pour un regex */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Transforme une date git en format relatif lisible ("il y a 3j", "il y a 2 sem.") */
function formatRelativeDate(gitDate: string): string {
  const date = new Date(gitDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "aujourd'hui";
  if (diffDays === 1) return 'hier';
  if (diffDays < 7) return `il y a ${diffDays}j`;
  if (diffDays < 30) return `il y a ${Math.floor(diffDays / 7)} sem.`;
  return `il y a ${Math.floor(diffDays / 30)} mois`;
}

/** Formate les stats de diff en "+12 -3" compact */
function formatDiffStats(added: number, removed: number): string {
  if (added === 0 && removed === 0) return '';
  const parts: string[] = [];
  if (added > 0) parts.push(`+${added}`);
  if (removed > 0) parts.push(`-${removed}`);
  return `(${parts.join(' ')})`;
}
