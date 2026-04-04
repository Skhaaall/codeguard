/**
 * Outil MCP : check
 * Verification post-modification — detecte les casses apres un changement.
 * Re-parse le fichier modifie, compare avec l'ancien index, signale les problemes.
 */

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
  reindexed: boolean;
  /** Index mis a jour (l'appelant doit le sauvegarder) */
  updatedIndex: ProjectIndex;
}

export interface BrokenImport {
  importingFile: string;
  symbolName: string;
}

export async function runCheck(
  index: ProjectIndex,
  filePath: string,
): Promise<CheckResult> {
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
    return { filePath, issueCount: issues.length, issues, removedExports, addedExports, brokenImports, reindexed, updatedIndex };
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
    reindexed,
    updatedIndex,
  };
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
