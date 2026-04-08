#!/usr/bin/env node

/**
 * CodeGuard — MCP Server
 * Carte du projet + impact analysis pour Claude Code.
 * Communication via stdio (protocole MCP standard).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

import { IndexStore } from './storage/index-store.js';
import type { ProjectIndex } from './storage/index-store.js';
import { initLogger, logger } from './utils/logger.js';
import { indexProject as runIndexProject } from './core/indexer.js';
import { runImpactAnalysis, formatImpactResult } from './tools/impact.js';
import { searchIndex, formatSearchResult } from './tools/search.js';
import { runGuard, formatGuardResult } from './tools/guard.js';
import { runCheck, formatCheckResult } from './tools/check.js';
import { runHealth, formatHealthResult } from './tools/health.js';
import { runRegressionMap, formatRegressionResult } from './tools/regression.js';
import { generateGraph, formatGraphResult } from './tools/graph.js';
import { runSchemaCheck, formatSchemaResult } from './tools/schema.js';
import { runRouteGuard, formatRouteGuardResult } from './tools/routes.js';
import { runChangelog, formatChangelogResult } from './tools/changelog.js';
import { runWhatsnew, formatWhatsnewResult } from './tools/whatsnew.js';
import { runSilentCatch, formatSilentCatchResult } from './tools/silent-catch.js';
import { TOOL_DEFINITIONS } from './tools/tool-definitions.js';
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

async function indexProject(incremental = false) {
  const result = await runIndexProject(resolvedRoot, { incremental, store });
  currentIndex = result.index;
  rebuildGraph(result.index);
  return result;
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
    name: 'skhaall-codeguard',
    version: '0.2.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Liste des outils disponibles
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DEFINITIONS,
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
                ...(incremental
                  ? [`- Re-parses : ${stats.parsed} | Inchanges : ${stats.skipped} | Supprimes : ${stats.removed}`]
                  : []),
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
            content: [{ type: 'text' as const, text: 'Aucun index. Lancez "reindex" pour indexer le projet.' }],
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

      case 'route_guard': {
        const index = getIndex();
        const result = runRouteGuard(index);
        return {
          content: [{ type: 'text' as const, text: formatRouteGuardResult(result) }],
        };
      }

      case 'silent_catch': {
        const severity = (args?.severity as string) ?? 'all';
        const result = await runSilentCatch(resolvedRoot, severity);
        return {
          content: [{ type: 'text' as const, text: formatSilentCatchResult(result) }],
        };
      }

      case 'whatsnew': {
        const index = getIndex();
        const snapshot = store.loadSnapshot();
        const since = args?.since as string | undefined;
        const result = runWhatsnew(index, snapshot, since);
        return {
          content: [{ type: 'text' as const, text: formatWhatsnewResult(result) }],
        };
      }

      case 'changelog': {
        const index = getIndex();
        const snapshot = store.loadSnapshot();
        const result = runChangelog(index, snapshot);
        return {
          content: [{ type: 'text' as const, text: formatChangelogResult(result) }],
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
  const resolved = input.startsWith('/') || input.match(/^[A-Z]:\\/i) ? resolve(input) : resolve(resolvedRoot, input);
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
