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

import { TypeScriptParser } from './parsers/typescript-parser.js';
import { IndexStore } from './storage/index-store.js';
import type { ProjectIndex } from './storage/index-store.js';
import { scanProject } from './utils/scanner.js';
import { initLogger, logger } from './utils/logger.js';
import { runImpactAnalysis, formatImpactResult } from './tools/impact.js';
import { searchIndex, formatSearchResult } from './tools/search.js';
import { runGuard, formatGuardResult } from './tools/guard.js';
import { runCheck, formatCheckResult } from './tools/check.js';
import { runHealth, formatHealthResult } from './tools/health.js';
import { runRegressionMap, formatRegressionResult } from './tools/regression.js';
import { DependencyGraph } from './graph/dependency-graph.js';

// --- Configuration ---

const PROJECT_ROOT = process.argv[2] ?? process.cwd();
const resolvedRoot = resolve(PROJECT_ROOT);

initLogger(resolvedRoot, 'info');
logger.info('CodeGuard demarre', { projectRoot: resolvedRoot });

// --- State ---

let currentIndex: ProjectIndex | null = null;
const store = new IndexStore(resolvedRoot);
const tsParser = new TypeScriptParser();

// --- Indexation ---

async function indexProject(): Promise<ProjectIndex> {
  const scan = scanProject(resolvedRoot);
  logger.info('Scan termine', {
    files: scan.files.length,
    dirs: scan.scannedDirs,
    ignored: scan.ignoredDirs,
    duration: scan.duration,
  });

  const tsFiles = scan.files.filter((f) => tsParser.canParse(f));
  const nodes = await tsParser.parseFiles(tsFiles);

  const index: ProjectIndex = {
    projectRoot: resolvedRoot,
    indexedAt: Date.now(),
    fileCount: nodes.length,
    files: {},
  };

  for (const node of nodes) {
    index.files[node.filePath] = node;
  }

  store.save(index);
  currentIndex = index;
  logger.info('Indexation complete', { fileCount: index.fileCount });

  return index;
}

function getIndex(): ProjectIndex {
  if (currentIndex) return currentIndex;

  const loaded = store.load();
  if (loaded) {
    currentIndex = loaded;
    return loaded;
  }

  throw new Error('Aucun index disponible. Lancez "reindex" d\'abord.');
}

// --- Serveur MCP ---

const server = new Server(
  {
    name: 'codeguard',
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
        'Re-indexe le projet complet. A lancer au debut de la session ou apres des changements importants.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
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
  ],
}));

// Execution des outils
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'impact': {
        const index = getIndex();
        const filePath = resolveFilePath(args?.filePath as string);
        const result = runImpactAnalysis(index, filePath);
        return {
          content: [{ type: 'text' as const, text: formatImpactResult(result) }],
        };
      }

      case 'search': {
        const index = getIndex();
        const result = searchIndex(index, args?.query as string);
        return {
          content: [{ type: 'text' as const, text: formatSearchResult(result) }],
        };
      }

      case 'reindex': {
        const index = await indexProject();
        const graph = DependencyGraph.fromIndex(index);
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                `Indexation terminee.`,
                `- Fichiers indexes : ${index.fileCount}`,
                `- Noeuds dans le graphe : ${graph.getNodeCount()}`,
                `- Aretes (dependances) : ${graph.getEdgeCount()}`,
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
        const index = getIndex();
        const filePath = resolveFilePath(args?.filePath as string);
        const graph = DependencyGraph.fromIndex(index);
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
        const filePath = resolveFilePath(args?.filePath as string);
        const result = runGuard(index, filePath);
        return {
          content: [{ type: 'text' as const, text: formatGuardResult(result) }],
        };
      }

      case 'check': {
        const index = getIndex();
        const filePath = resolveFilePath(args?.filePath as string);
        const result = await runCheck(index, filePath);
        // Sauvegarder l'index mis a jour
        store.save(index);
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
        const filePath = resolveFilePath(args?.filePath as string);
        const result = runRegressionMap(index, filePath);
        return {
          content: [{ type: 'text' as const, text: formatRegressionResult(result) }],
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

function resolveFilePath(input: string): string {
  if (!input) throw new Error('Chemin de fichier requis');
  // Si chemin relatif, resoudre par rapport a la racine du projet
  if (!input.startsWith('/') && !input.match(/^[A-Z]:\\/i)) {
    return resolve(resolvedRoot, input);
  }
  return resolve(input);
}

// --- Demarrage ---

async function main(): Promise<void> {
  // Charger l'index existant s'il y en a un
  const existing = store.load();
  if (existing) {
    currentIndex = existing;
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
