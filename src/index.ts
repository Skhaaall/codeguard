#!/usr/bin/env node

/**
 * CodeGuard — MCP Server
 * Carte du projet + impact analysis pour Claude Code.
 * Communication via stdio (protocole MCP standard).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

import { TypeScriptParser } from './parsers/typescript-parser.js';
import { IndexStore } from './storage/index-store.js';
import type { ProjectIndex } from './storage/index-store.js';
import { scanProject } from './utils/scanner.js';
import { initLogger, logger } from './utils/logger.js';
import { parsePrismaSchema, prismaSchemaToFileNode } from './parsers/prisma-parser.js';
import { runImpactAnalysis, formatImpactResult } from './tools/impact.js';
import { searchIndex, formatSearchResult } from './tools/search.js';
import { runGuard, formatGuardResult } from './tools/guard.js';
import { runCheck, formatCheckResult } from './tools/check.js';
import { runHealth, formatHealthResult } from './tools/health.js';
import { runRegressionMap, formatRegressionResult } from './tools/regression.js';
import { generateGraph, formatGraphResult } from './tools/graph.js';
import { runSchemaCheck, formatSchemaResult } from './tools/schema.js';
import { DependencyGraph } from './graph/dependency-graph.js';

// --- Configuration ---

const PROJECT_ROOT = process.argv[2] ?? process.cwd();
const resolvedRoot = resolve(PROJECT_ROOT);

// Valider que le dossier existe
try {
  const rootStat = statSync(resolvedRoot);
  if (!rootStat.isDirectory()) {
    process.exit(1);
  }
} catch {
  process.exit(1);
}

initLogger(resolvedRoot, 'info');
logger.info('CodeGuard demarre', { projectRoot: resolvedRoot });

// --- State ---

let currentIndex: ProjectIndex | null = null;
let currentGraph: DependencyGraph | null = null;
const store = new IndexStore(resolvedRoot);
const tsParser = new TypeScriptParser();

/** Reconstruit le graphe a partir de l'index courant */
function rebuildGraph(index: ProjectIndex): DependencyGraph {
  currentGraph = DependencyGraph.fromIndex(index);
  return currentGraph;
}

/** Retourne le graphe cache ou le reconstruit */
function getGraph(): DependencyGraph {
  if (currentGraph) return currentGraph;
  return rebuildGraph(getIndex());
}

// --- Indexation ---

async function indexProject(incremental = false): Promise<{ index: ProjectIndex; stats: { total: number; parsed: number; skipped: number; removed: number } }> {
  const scan = scanProject(resolvedRoot);
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

  // Base : index existant ou vide
  const index: ProjectIndex = {
    projectRoot: resolvedRoot,
    indexedAt: Date.now(),
    fileCount: 0,
    files: existing?.files ?? {},
  };

  // Determiner les fichiers a re-parser
  const filesToParse: string[] = [];
  for (const filePath of tsFiles) {
    if (incremental && existing?.files[filePath]) {
      // Verifier si le fichier a ete modifie depuis le dernier parsing
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

  // Parser les fichiers TS modifies
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
      } catch { /* re-parser */ }
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
  currentIndex = index;
  rebuildGraph(index);
  logger.info('Indexation complete', { fileCount: index.fileCount, parsed, skipped, removed });

  return { index, stats: { total: tsFiles.length, parsed, skipped, removed } };
}

function getIndex(): ProjectIndex {
  if (currentIndex) return currentIndex;

  const loaded = store.load();
  if (loaded) {
    currentIndex = loaded;
    rebuildGraph(loaded);
    return loaded;
  }

  throw new Error('Aucun index disponible. Lancez "reindex" d\'abord.');
}

// --- Serveur MCP ---

const server = new Server(
  {
    name: '@skhaall/codeguard',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Liste des outils disponibles
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'impact',
      description:
        'Analyse d\'impact — "je modifie ce fichier, qu\'est-ce qui casse ?" Retourne les fichiers impactes, les routes API affectees, et un score de risque.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Chemin du fichier a analyser (absolu ou relatif au projet)',
          },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'search',
      description:
        'Recherche dans la carte — "qui utilise cette fonction/type/hook ?" Cherche dans les imports, exports, fonctions, classes, types et routes.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Nom de la fonction, du type, du hook ou de la route a chercher',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'reindex',
      description:
        'Re-indexe le projet. Par defaut complet, avec incremental=true ne re-parse que les fichiers modifies.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          incremental: {
            type: 'boolean',
            description: 'Si true, ne re-parse que les fichiers modifies depuis le dernier indexage (plus rapide)',
          },
        },
      },
    },
    {
      name: 'status',
      description:
        'Etat de l\'index : date, nombre de fichiers, fraicheur.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'dependencies',
      description:
        'Graphe de dependances d\'un fichier — qui il importe et qui l\'importe.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Chemin du fichier',
          },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'guard',
      description:
        'Pre-change safety check — "est-ce safe de modifier ce fichier ?" Retourne les risques, les fichiers a verifier apres, et une recommandation go/no-go. A appeler AVANT toute modification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Chemin du fichier qui va etre modifie (absolu ou relatif)',
          },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'check',
      description:
        'Post-change coherence check — re-indexe le fichier modifie, compare avec l\'ancien etat, detecte les exports supprimes, imports casses et types incoherents. A appeler APRES chaque modification.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Chemin du fichier qui vient d\'etre modifie (absolu ou relatif)',
          },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'health',
      description:
        'Score de sante global du projet — imports casses, fichiers orphelins, dependances circulaires, fichiers a haut risque. Note de A (excellent) a F (critique).',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'regression_map',
      description:
        'Regression map — "je modifie ce fichier, quelles pages/routes retester ?" Liste les pages, routes API et entry points impactes en cascade.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Chemin du fichier modifie (absolu ou relatif)',
          },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'graph',
      description:
        'Genere un diagramme Mermaid du graphe de dependances. Sans filePath = graphe complet, avec filePath = graphe centre sur ce fichier (2 niveaux).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          filePath: {
            type: 'string',
            description: 'Fichier sur lequel centrer le graphe (optionnel — sans = graphe complet)',
          },
        },
      },
    },
    {
      name: 'schema_check',
      description:
        'Coherence Prisma ↔ DTOs backend ↔ types frontend. Detecte les champs manquants et les enums desynchronises. A lancer apres modification du schema Prisma ou des DTOs.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
  ],
}));

// Execution des outils
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'impact': {
        const index = getIndex();
        const filePath = resolveFilePath(requireString(args?.filePath, 'filePath'));
        const result = runImpactAnalysis(index, filePath);
        return {
          content: [{ type: 'text' as const, text: formatImpactResult(result) }],
        };
      }

      case 'search': {
        const index = getIndex();
        const result = searchIndex(index, requireString(args?.query, 'query'));
        return {
          content: [{ type: 'text' as const, text: formatSearchResult(result) }],
        };
      }

      case 'reindex': {
        const incremental = args?.incremental === true;
        const { index, stats } = await indexProject(incremental);
        const graph = getGraph();
        const mode = incremental ? 'incremental' : 'complet';
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Indexation terminee (${mode}).`,
                `- Fichiers indexes : ${index.fileCount}`,
                `- Noeuds dans le graphe : ${graph.getNodeCount()}`,
                `- Aretes (dependances) : ${graph.getEdgeCount()}`,
                ...(incremental ? [
                  `- Re-parses : ${stats.parsed} | Inchanges : ${stats.skipped} | Supprimes : ${stats.removed}`,
                ] : []),
                `- Date : ${new Date(index.indexedAt).toLocaleString('fr-FR')}`,
              ].join('\n'),
            },
          ],
        };
      }

      case 'status': {
        const index = store.load();
        if (!index) {
          return {
            content: [
              { type: 'text' as const, text: 'Aucun index. Lancez "reindex" pour indexer le projet.' },
            ],
          };
        }
        const age = Date.now() - index.indexedAt;
        const ageMin = Math.round(age / 60000);
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `## CodeGuard — Status`,
                `- Projet : ${index.projectRoot}`,
                `- Fichiers indexes : ${index.fileCount}`,
                `- Derniere indexation : ${new Date(index.indexedAt).toLocaleString('fr-FR')}`,
                `- Age : ${ageMin < 60 ? `${ageMin} min` : `${Math.round(ageMin / 60)}h`}`,
              ].join('\n'),
            },
          ],
        };
      }

      case 'dependencies': {
        getIndex();
        const filePath = resolveFilePath(requireString(args?.filePath, 'filePath'));
        const graph = getGraph();
        const deps = graph.getDependencies(filePath);
        const dependents = graph.getDependents(filePath);

        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `## Dependances : ${filePath}`,
                '',
                `### Ce fichier depend de (${deps.length})`,
                ...deps.map((d) => `- ${d}`),
                '',
                `### Utilise par (${dependents.length})`,
                ...dependents.map((d) => `- ${d}`),
              ].join('\n'),
            },
          ],
        };
      }

      case 'guard': {
        const index = getIndex();
        const filePath = resolveFilePath(requireString(args?.filePath, 'filePath'));
        const result = runGuard(index, filePath);
        return {
          content: [{ type: 'text' as const, text: formatGuardResult(result) }],
        };
      }

      case 'check': {
        const index = getIndex();
        const filePath = resolveFilePath(requireString(args?.filePath, 'filePath'));
        const result = await runCheck(index, filePath);
        // Appliquer l'index mis a jour et reconstruire le graphe
        currentIndex = result.updatedIndex;
        store.save(result.updatedIndex);
        rebuildGraph(result.updatedIndex);
        return {
          content: [{ type: 'text' as const, text: formatCheckResult(result) }],
        };
      }

      case 'health': {
        const index = getIndex();
        const result = runHealth(index);
        return {
          content: [{ type: 'text' as const, text: formatHealthResult(result) }],
        };
      }

      case 'regression_map': {
        const index = getIndex();
        const filePath = resolveFilePath(requireString(args?.filePath, 'filePath'));
        const result = runRegressionMap(index, filePath);
        return {
          content: [{ type: 'text' as const, text: formatRegressionResult(result) }],
        };
      }

      case 'graph': {
        const index = getIndex();
        const focusFile = args?.filePath ? resolveFilePath(requireString(args.filePath, 'filePath')) : undefined;
        const result = generateGraph(index, focusFile);
        return {
          content: [{ type: 'text' as const, text: formatGraphResult(result) }],
        };
      }

      case 'schema_check': {
        const index = getIndex();
        const result = runSchemaCheck(index);
        return {
          content: [{ type: 'text' as const, text: formatSchemaResult(result) }],
        };
      }

      default:
        return {
          content: [{ type: 'text' as const, text: `Outil inconnu : ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Erreur outil', { tool: name, error: message });
    return {
      content: [{ type: 'text' as const, text: `Erreur : ${message}` }],
      isError: true,
    };
  }
});

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Parametre "${name}" requis (string non vide)`);
  }
  return value;
}

function resolveFilePath(input: string): string {
  if (!input) throw new Error('Chemin de fichier requis');
  // Resoudre par rapport a la racine du projet
  const resolved = input.startsWith('/') || input.match(/^[A-Z]:\\/i)
    ? resolve(input)
    : resolve(resolvedRoot, input);
  // Bloquer le path traversal — le chemin doit rester dans le projet
  const normalizedResolved = resolved.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = resolvedRoot.replace(/\\/g, '/').toLowerCase();
  if (!normalizedResolved.startsWith(normalizedRoot)) {
    throw new Error(`Chemin hors du projet interdit : ${input}`);
  }
  return resolved;
}

// --- Demarrage ---

async function main(): Promise<void> {
  // Charger l'index existant s'il y en a un
  const existing = store.load();
  if (existing) {
    currentIndex = existing;
    rebuildGraph(existing);
    logger.info('Index charge depuis le cache', { fileCount: existing.fileCount });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('Serveur MCP connecte (stdio)');
}

main().catch((error) => {
  logger.error('Crash serveur', { error: String(error) });
  process.exit(1);
});
