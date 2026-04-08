/**
 * Logique d'indexation partagee entre le serveur MCP et le CLI.
 * Un seul endroit pour ajouter un nouveau parser.
 */

import { statSync } from 'node:fs';
import { TypeScriptParser } from '../parsers/typescript-parser.js';
import { parsePrismaSchema, prismaSchemaToFileNode } from '../parsers/prisma-parser.js';
import { scanProject } from '../utils/scanner.js';
import { IndexStore } from '../storage/index-store.js';
import type { ProjectIndex } from '../storage/index-store.js';
import { logger } from '../utils/logger.js';

const tsParser = new TypeScriptParser();

export interface IndexStats {
  total: number;
  parsed: number;
  skipped: number;
  removed: number;
}

/** Indexe un projet (complet ou incremental) */
export async function indexProject(
  projectRoot: string,
  options: { incremental?: boolean; store?: IndexStore } = {},
): Promise<{ index: ProjectIndex; stats: IndexStats }> {
  const store = options.store ?? new IndexStore(projectRoot);
  const incremental = options.incremental ?? false;

  // Sauvegarder le snapshot avant de re-indexer
  if (store.exists()) store.saveSnapshot();

  const scan = scanProject(projectRoot);
  logger.info('Scan termine', {
    files: scan.files.length,
    dirs: scan.scannedDirs,
    ignored: scan.ignoredDirs,
    duration: scan.duration,
  });

  const tsFiles = scan.files.filter((f) => tsParser.canParse(f));
  const existing = incremental ? store.load() : null;
  let parsed = 0;
  let skipped = 0;
  let removed = 0;

  const index: ProjectIndex = {
    projectRoot,
    indexedAt: Date.now(),
    fileCount: 0,
    files: existing?.files ?? {},
  };

  // Determiner les fichiers a re-parser
  const filesToParse: string[] = [];
  for (const filePath of tsFiles) {
    if (incremental && existing?.files[filePath]) {
      try {
        const mtime = statSync(filePath).mtimeMs;
        if (mtime <= existing.files[filePath].parsedAt) {
          skipped++;
          continue;
        }
      } catch {
        // Fichier inaccessible — le re-parser
      }
    }
    filesToParse.push(filePath);
  }

  // Parser les fichiers TS
  const nodes = await tsParser.parseFiles(filesToParse);
  parsed = nodes.length;

  for (const node of nodes) {
    index.files[node.filePath] = node;
  }

  // Parser les fichiers Prisma
  const prismaFiles = scan.files.filter((f) => f.endsWith('.prisma'));
  for (const prismaFile of prismaFiles) {
    if (incremental && existing?.files[prismaFile]) {
      try {
        const mtime = statSync(prismaFile).mtimeMs;
        if (mtime <= existing.files[prismaFile].parsedAt) continue;
      } catch {
        /* re-parser */
      }
    }
    try {
      const schema = parsePrismaSchema(prismaFile);
      const node = prismaSchemaToFileNode(schema);
      index.files[node.filePath] = node;
      parsed++;
    } catch (error) {
      logger.warn('Prisma parsing echoue', { file: prismaFile, error: String(error) });
    }
  }

  // Supprimer les fichiers qui n'existent plus
  if (incremental && existing) {
    const currentFiles = new Set([...tsFiles, ...prismaFiles]);
    for (const filePath of Object.keys(index.files)) {
      if (!currentFiles.has(filePath)) {
        delete index.files[filePath];
        removed++;
      }
    }
  }

  index.fileCount = Object.keys(index.files).length;
  store.save(index);
  logger.info('Indexation complete', { fileCount: index.fileCount, parsed, skipped, removed });

  return { index, stats: { total: tsFiles.length, parsed, skipped, removed } };
}
