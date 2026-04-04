/**
 * Outil MCP : check
 * Verification post-modification — detecte les casses apres un changement.
 * Re-parse le fichier modifie, compare avec l'ancien index, signale les problemes.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import type { FileNode, ExportInfo } from '../parsers/base-parser.js';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { DependencyGraph } from '../graph/dependency-graph.js';
import { logger } from '../utils/logger.js';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface CheckIssue {
  severity: IssueSeverity;
  message: string;
  /** Fichier affecte (le fichier verifie ou un dependant) */
  file: string;
}

export interface CheckResult {
  filePath: string;
  /** Nombre de problemes trouves */
  issueCount: number;
  issues: CheckIssue[];
  /** Exports supprimes par rapport a l'ancien index */
  removedExports: string[];
  /** Exports ajoutes */
  addedExports: string[];
  /** Imports potentiellement casses dans les dependants */
  brokenImports: BrokenImport[];
  /** True si le fichier a ete re-indexe avec succes */
  reindexed: boolean;
}

export interface BrokenImport {
  /** Fichier qui importe le symbole manquant */
  importingFile: string;
  /** Nom du symbole importe qui n'existe plus */
  symbolName: string;
}

export async function runCheck(
  index: ProjectIndex,
  filePath: string,
): Promise<CheckResult> {
  const issues: CheckIssue[] = [];
  const removedExports: string[] = [];
  const addedExports: string[] = [];
  const brokenImports: BrokenImport[] = [];

  const oldNode = index.files[filePath];
  const oldExports = oldNode?.exports ?? [];
  const oldExportNames = new Set(oldExports.map((e) => e.name));

  // -- Re-parser le fichier modifie --
  let newNode: FileNode | null = null;
  let reindexed = false;

  try {
    const parser = new TypeScriptParser();
    if (parser.canParse(filePath)) {
      newNode = await parser.parseFile(filePath);
      // Mettre a jour l'index en memoire
      index.files[filePath] = newNode;
      index.fileCount = Object.keys(index.files).length;
      index.indexedAt = Date.now();
      reindexed = true;
    }
  } catch (error) {
    issues.push({
      severity: 'error',
      message: `Impossible de re-parser le fichier : ${error instanceof Error ? error.message : String(error)}`,
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
      reindexed,
    };
  }

  // -- Comparer les exports --
  const newExportNames = new Set(newNode.exports.map((e) => e.name));

  for (const name of oldExportNames) {
    if (!newExportNames.has(name)) {
      removedExports.push(name);
    }
  }

  for (const name of newExportNames) {
    if (!oldExportNames.has(name)) {
      addedExports.push(name);
    }
  }

  // -- Detecter les imports casses --
  if (removedExports.length > 0) {
    const graph = DependencyGraph.fromIndex(index);
    const dependents = graph.getDependents(filePath);

    for (const depFile of dependents) {
      const depNode = index.files[depFile];
      if (!depNode) continue;

      for (const imp of depNode.imports) {
        // Verifier si cet import pointe vers notre fichier
        if (!importPointsTo(imp.source, filePath, depFile)) continue;

        if (removedExports.includes(imp.name)) {
          brokenImports.push({
            importingFile: depFile,
            symbolName: imp.name,
          });

          issues.push({
            severity: 'error',
            message: `Import casse : "${imp.name}" n'est plus exporte par ${filePath}`,
            file: depFile,
          });
        }
      }
    }
  }

  // -- Alertes sur les suppressions meme sans casse immediate --
  if (removedExports.length > 0 && brokenImports.length === 0) {
    issues.push({
      severity: 'warning',
      message: `${removedExports.length} export(s) supprime(s) : ${removedExports.join(', ')}. Aucun import casse detecte dans les fichiers indexes.`,
      file: filePath,
    });
  }

  // -- Comparer les types (changement de shape) --
  if (oldNode) {
    for (const newType of newNode.types) {
      const oldType = oldNode.types.find((t) => t.name === newType.name);
      if (!oldType) continue;

      // Verifier si des proprietes ont ete supprimees
      const oldProps = new Set(oldType.properties.map((p) => p.name));
      const newProps = new Set(newType.properties.map((p) => p.name));

      const removedProps = [...oldProps].filter((p) => !newProps.has(p));
      if (removedProps.length > 0) {
        issues.push({
          severity: 'warning',
          message: `Type "${newType.name}" : propriete(s) supprimee(s) : ${removedProps.join(', ')}. Les fichiers qui utilisent ce type peuvent casser.`,
          file: filePath,
        });
      }

      // Verifier si des proprietes requises ont ete ajoutees
      const addedRequiredProps = newType.properties
        .filter((p) => !oldProps.has(p.name) && !p.isOptional)
        .map((p) => p.name);

      if (addedRequiredProps.length > 0) {
        issues.push({
          severity: 'warning',
          message: `Type "${newType.name}" : nouvelle(s) propriete(s) requise(s) : ${addedRequiredProps.join(', ')}. Les fichiers qui creent ce type devront les fournir.`,
          file: filePath,
        });
      }
    }
  }

  // -- Verifier les imports du fichier modifie --
  for (const imp of newNode.imports) {
    if (imp.source.startsWith('.')) {
      // Import relatif — verifier que le fichier cible existe dans l'index
      const targetExists = Object.keys(index.files).some((f) =>
        importPointsTo(imp.source, f, filePath),
      );

      if (!targetExists) {
        issues.push({
          severity: 'error',
          message: `Import vers "${imp.source}" — fichier cible introuvable dans l'index.`,
          file: filePath,
        });
      }
    }
  }

  // -- Info si des exports ont ete ajoutes --
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
    reindexed,
  };
}

/** Verifie si un import source pointe probablement vers un fichier cible */
function importPointsTo(importSource: string, targetFile: string, fromFile: string): boolean {
  // Simplification : on compare les noms de base des fichiers
  const importBase = importSource
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '') ?? '';

  const targetBase = targetFile
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    ?.replace(/\.(js|jsx|ts|tsx|mjs|cjs)$/, '') ?? '';

  return importBase === targetBase && importBase !== '';
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
