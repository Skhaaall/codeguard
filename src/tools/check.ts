/**
 * Outil MCP : check
 * Verification post-modification — detecte les casses apres un changement.
 * Re-parse le fichier modifie, compare avec l'ancien index, signale les problemes.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectIndex } from '../storage/index-store.js';
import type { FileNode } from '../parsers/base-parser.js';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { importPointsTo } from '../utils/import-resolver.js';
import { resolveImportPath } from '../utils/import-resolver.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface CheckIssue {
  severity: IssueSeverity;
  message: string;
  file: string;
}

export interface CheckResult {
  filePath: string;
  issueCount: number;
  issues: CheckIssue[];
  removedExports: string[];
  addedExports: string[];
  brokenImports: BrokenImport[];
  /** Fonctions exportees dont la signature a change */
  signatureChanges: SignatureChange[];
  reindexed: boolean;
  /** Index mis a jour (l'appelant doit le sauvegarder) */
  updatedIndex: ProjectIndex;
}

export interface BrokenImport {
  importingFile: string;
  symbolName: string;
}

export interface SignatureChange {
  functionName: string;
  oldParams: string;
  newParams: string;
  /** Fichiers qui appellent cette fonction et doivent etre verifies */
  callers: string[];
}

export async function runCheck(index: ProjectIndex, filePath: string): Promise<CheckResult> {
  // Travailler sur une copie pour ne pas muter l'original
  const updatedIndex: ProjectIndex = {
    ...index,
    files: { ...index.files },
  };

  const issues: CheckIssue[] = [];
  const removedExports: string[] = [];
  const addedExports: string[] = [];
  const brokenImports: BrokenImport[] = [];

  const oldNode = index.files[filePath];
  const oldExportNames = new Set((oldNode?.exports ?? []).map((e) => e.name));

  // -- Re-parser le fichier modifie --
  let newNode: FileNode | null = null;
  let reindexed = false;

  try {
    const parser = new TypeScriptParser();
    if (parser.canParse(filePath)) {
      newNode = await parser.parseFile(filePath);
      updatedIndex.files[filePath] = newNode;
      updatedIndex.fileCount = Object.keys(updatedIndex.files).length;
      updatedIndex.indexedAt = Date.now();
      reindexed = true;
    }
  } catch (error) {
    issues.push({
      severity: 'error',
      message: `Impossible de re-parser : ${error instanceof Error ? error.message : String(error)}`,
      file: filePath,
    });
  }

  if (!newNode) {
    return {
      filePath,
      issueCount: issues.length,
      issues,
      removedExports,
      addedExports,
      brokenImports,
      signatureChanges: [],
      reindexed,
      updatedIndex,
    };
  }

  // -- Comparer les exports --
  const newExportNames = new Set(newNode.exports.map((e) => e.name));

  for (const name of oldExportNames) {
    if (!newExportNames.has(name)) removedExports.push(name);
  }
  for (const name of newExportNames) {
    if (!oldExportNames.has(name)) addedExports.push(name);
  }

  // -- Detecter les imports casses (resolution complete, pas par nom de base) --
  if (removedExports.length > 0) {
    const graph = DependencyGraph.fromIndex(updatedIndex);
    const dependents = graph.getDependents(filePath);

    for (const depFile of dependents) {
      const depNode = updatedIndex.files[depFile];
      if (!depNode) continue;

      for (const imp of depNode.imports) {
        if (!imp.source.startsWith('.')) continue;
        if (!importPointsTo(imp.source, filePath, depFile, updatedIndex.files, updatedIndex.projectRoot)) continue;

        if (removedExports.includes(imp.name)) {
          brokenImports.push({ importingFile: depFile, symbolName: imp.name });
          issues.push({
            severity: 'error',
            message: `Import casse : "${imp.name}" n'est plus exporte par ${filePath}`,
            file: depFile,
          });
        }
      }
    }
  }

  // -- Suppressions sans casse immediate --
  if (removedExports.length > 0 && brokenImports.length === 0) {
    issues.push({
      severity: 'warning',
      message: `${removedExports.length} export(s) supprime(s) : ${removedExports.join(', ')}. Aucun import casse detecte.`,
      file: filePath,
    });
  }

  // -- Comparer les types (changement de shape) --
  if (oldNode) {
    for (const newType of newNode.types) {
      const oldType = oldNode.types.find((t) => t.name === newType.name);
      if (!oldType) continue;

      const oldProps = new Set(oldType.properties.map((p) => p.name));
      const newProps = new Set(newType.properties.map((p) => p.name));

      const removedProps = [...oldProps].filter((p) => !newProps.has(p));
      if (removedProps.length > 0) {
        issues.push({
          severity: 'warning',
          message: `Type "${newType.name}" : propriete(s) supprimee(s) : ${removedProps.join(', ')}.`,
          file: filePath,
        });
      }

      const addedRequiredProps = newType.properties
        .filter((p) => !oldProps.has(p.name) && !p.isOptional)
        .map((p) => p.name);

      if (addedRequiredProps.length > 0) {
        issues.push({
          severity: 'warning',
          message: `Type "${newType.name}" : nouvelle(s) propriete(s) requise(s) : ${addedRequiredProps.join(', ')}.`,
          file: filePath,
        });
      }
    }
  }

  // -- Detecter les changements de signature des fonctions exportees --
  const signatureChanges: SignatureChange[] = [];

  if (oldNode) {
    const oldExportedFns = [
      ...oldNode.functions.filter((f) => f.isExported),
      ...oldNode.classes.flatMap((c) => c.methods.filter((m) => m.isExported)),
    ];
    const newExportedFns = [
      ...newNode.functions.filter((f) => f.isExported),
      ...newNode.classes.flatMap((c) => c.methods.filter((m) => m.isExported)),
    ];

    for (const oldFn of oldExportedFns) {
      const newFn = newExportedFns.find((f) => f.name === oldFn.name);
      if (!newFn) continue; // Fonction supprimee — deja gere par removedExports

      const oldSig = formatParams(oldFn.parameters);
      const newSig = formatParams(newFn.parameters);

      if (oldSig !== newSig) {
        // Trouver les fichiers qui appellent cette fonction
        const graph = DependencyGraph.fromIndex(updatedIndex);
        const dependents = graph.getDependents(filePath);
        const callers: string[] = [];

        for (const depFile of dependents) {
          const depNode = updatedIndex.files[depFile];
          if (!depNode) continue;

          // Verifier que le fichier importe bien cette fonction
          const importsFn = depNode.imports.some(
            (imp) =>
              imp.name === oldFn.name &&
              imp.source.startsWith('.') &&
              importPointsTo(imp.source, filePath, depFile, updatedIndex.files, updatedIndex.projectRoot),
          );
          if (importsFn) {
            callers.push(depFile);
          }
        }

        signatureChanges.push({
          functionName: oldFn.name,
          oldParams: `(${oldSig})`,
          newParams: `(${newSig})`,
          callers,
        });

        const severity: IssueSeverity =
          newFn.parameters.length < oldFn.parameters.length ||
          newFn.parameters.some((p, i) => !p.isOptional && (!oldFn.parameters[i] || oldFn.parameters[i].isOptional))
            ? 'error'
            : 'warning';

        issues.push({
          severity,
          message: `Signature modifiee : ${oldFn.name}(${oldSig}) → ${oldFn.name}(${newSig})${callers.length > 0 ? ` — ${callers.length} appelant(s) a verifier` : ''}`,
          file: filePath,
        });
      }
    }
  }

  // -- Verifier les imports du fichier modifie (resolution complete) --
  for (const imp of newNode.imports) {
    if (imp.source.startsWith('.')) {
      const resolved = resolveImportPath(filePath, imp.source, updatedIndex.files, updatedIndex.projectRoot);
      if (!resolved) {
        issues.push({
          severity: 'error',
          message: `Import vers "${imp.source}" — fichier cible introuvable.`,
          file: filePath,
        });
      }
    }
  }

  // -- Detection code mort (exports sans importeur) --
  const deadExports: string[] = [];
  const normalizedPath = filePath.replace(/\\/g, '/');
  const isEntryPoint =
    /\/(index|main|app|server)\.(ts|tsx|js)$/.test(normalizedPath) ||
    /\.(controller|module|route)\.(ts|js)$/.test(normalizedPath);

  if (!isEntryPoint && newNode.exports.length > 0) {
    const graph = DependencyGraph.fromIndex(updatedIndex);

    for (const exp of newNode.exports) {
      // Verifier si au moins un fichier importe ce symbole depuis ce fichier
      const dependents = graph.getDependents(filePath);
      const hasImporter = dependents.some((depFile) => {
        const depNode = updatedIndex.files[depFile];
        if (!depNode) return false;
        return depNode.imports.some(
          (imp) =>
            imp.name === exp.name &&
            imp.source.startsWith('.') &&
            importPointsTo(imp.source, filePath, depFile, updatedIndex.files, updatedIndex.projectRoot),
        );
      });

      if (!hasImporter) {
        deadExports.push(exp.name);
      }
    }

    if (deadExports.length > 0) {
      issues.push({
        severity: 'info',
        message: `Code mort potentiel : ${deadExports.join(', ')} — exporte(s) mais jamais importe(s).`,
        file: filePath,
      });
    }
  }

  // -- Detection incoherence de patterns dans le dossier --
  const patternIssues = detectPatternInconsistencies(filePath);
  for (const pi of patternIssues) {
    issues.push({ severity: 'warning', message: pi, file: filePath });
  }

  // -- Nouveaux exports --
  if (addedExports.length > 0) {
    issues.push({
      severity: 'info',
      message: `${addedExports.length} nouvel(s) export(s) : ${addedExports.join(', ')}`,
      file: filePath,
    });
  }

  return {
    filePath,
    issueCount: issues.filter((i) => i.severity === 'error' || i.severity === 'warning').length,
    issues,
    removedExports,
    addedExports,
    brokenImports,
    signatureChanges,
    reindexed,
    updatedIndex,
  };
}

/**
 * Detecte les incoherences de patterns entre le fichier modifie et ses voisins de dossier.
 * Analyse statistique : si > 70% des fichiers du dossier suivent un pattern,
 * et le fichier modifie non, on signale.
 * Ignore les dossiers avec < 3 fichiers .ts (pas assez representatif).
 */
function detectPatternInconsistencies(filePath: string): string[] {
  const dir = dirname(filePath);
  const issues: string[] = [];

  // Lister les fichiers .ts freres (meme dossier)
  let siblings: string[];
  try {
    siblings = readdirSync(dir).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.(spec|test|e2e)\.(ts|tsx)$/.test(f));
  } catch {
    return [];
  }

  if (siblings.length < 3) return [];

  // Lire le contenu du fichier modifie
  let fileContent: string;
  try {
    fileContent = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  // Lire le contenu des freres (cache simple)
  const siblingContents = new Map<string, string>();
  for (const sib of siblings) {
    try {
      siblingContents.set(sib, readFileSync(join(dir, sib), 'utf-8'));
    } catch {
      // Fichier illisible, on l'ignore
    }
  }

  // Patterns a detecter
  const patterns: { name: string; test: (content: string) => boolean }[] = [
    {
      name: 'logger.error/warn dans les catch',
      test: (c) => /catch\s*\(/.test(c) && /logger\.(error|warn)/.test(c),
    },
    {
      name: 'validation zod ou class-validator',
      test: (c) => /from\s+['"]zod['"]/.test(c) || /from\s+['"]class-validator['"]/.test(c),
    },
    {
      name: 'decorateur @Injectable()',
      test: (c) => /@Injectable\(\)/.test(c),
    },
  ];

  for (const pattern of patterns) {
    // Compter combien de freres ont ce pattern
    let matchCount = 0;
    for (const [, content] of siblingContents) {
      if (pattern.test(content)) matchCount++;
    }

    const ratio = matchCount / siblingContents.size;
    const fileHasPattern = pattern.test(fileContent);

    if (ratio >= 0.7 && !fileHasPattern) {
      issues.push(
        `${matchCount}/${siblingContents.size} fichiers du dossier utilisent ${pattern.name} — celui-ci non.`,
      );
    }
  }

  return issues;
}

/** Formate les parametres d'une fonction en string lisible */
function formatParams(params: { name: string; type: string | null; isOptional: boolean }[]): string {
  return params
    .map((p) => {
      const opt = p.isOptional ? '?' : '';
      const type = p.type ? `: ${p.type}` : '';
      return `${p.name}${opt}${type}`;
    })
    .join(', ');
}

/** Formate le resultat pour affichage MCP */
export function formatCheckResult(result: CheckResult): string {
  const lines: string[] = [];

  const icon = result.issueCount === 0 ? 'OK' : 'PROBLEMES';
  lines.push(`## Check : ${icon} — ${result.filePath}`);
  lines.push(`**Re-indexe** : ${result.reindexed ? 'oui' : 'non'}`);

  if (result.removedExports.length > 0) {
    lines.push(`**Exports supprimes** : ${result.removedExports.join(', ')}`);
  }
  if (result.addedExports.length > 0) {
    lines.push(`**Exports ajoutes** : ${result.addedExports.join(', ')}`);
  }

  if (result.brokenImports.length > 0) {
    lines.push('');
    lines.push('### Imports casses');
    for (const bi of result.brokenImports) {
      lines.push(`- **${bi.importingFile}** importe "${bi.symbolName}" qui n'existe plus`);
    }
  }

  if (result.signatureChanges.length > 0) {
    lines.push('');
    lines.push('### Signatures modifiees');
    for (const sc of result.signatureChanges) {
      lines.push(`/!\\ ${sc.functionName}() : signature changee`);
      lines.push(`    Avant : ${sc.oldParams}`);
      lines.push(`    Apres : ${sc.newParams}`);
      if (sc.callers.length > 0) {
        lines.push(`    Appelants a verifier :`);
        for (const caller of sc.callers) {
          lines.push(`    - ${caller}`);
        }
        lines.push(`    ⚠ REGRESSION PROBABLE — ces fichiers appellent encore avec l'ancienne signature`);
      }
    }
  }

  if (result.issues.length > 0) {
    lines.push('');
    lines.push('### Problemes detectes');
    for (const issue of result.issues) {
      const prefix = issue.severity === 'error' ? '/!\\ ' : issue.severity === 'warning' ? '! ' : '';
      lines.push(`- ${prefix}[${issue.severity.toUpperCase()}] ${issue.message}`);
    }
  }

  if (result.issueCount === 0) {
    lines.push('');
    lines.push('> Aucun probleme detecte. Le fichier est coherent avec le reste du projet.');
  }

  return lines.join('\n');
}
