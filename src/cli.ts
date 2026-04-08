#!/usr/bin/env node

/**
 * CodeGuard CLI — deux modes :
 *
 * Mode hook (guard/check) — appele par les hooks Claude Code :
 *   echo '{"tool_input":{"file_path":"..."}}' | codeguard-cli guard
 *
 * Mode CLI (init/status/impact/health/regression) — appele manuellement :
 *   codeguard-cli init [project-root]
 *   codeguard-cli status [project-root]
 *   codeguard-cli impact <file> [project-root]
 *   codeguard-cli health [project-root]
 *   codeguard-cli regression <file> [project-root]
 */

import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { IndexStore } from './storage/index-store.js';
import { initLogger, logger } from './utils/logger.js';
import { validateHookInput } from './utils/validators.js';
import { indexProject } from './core/indexer.js';
import { runGuard, formatGuardResult } from './tools/guard.js';
import { runCheck, formatCheckResult } from './tools/check.js';
import { runHealth, formatHealthResult } from './tools/health.js';
import { runRegressionMap, formatRegressionResult } from './tools/regression.js';
import { runImpactAnalysis, formatImpactResult } from './tools/impact.js';
import { generateGraph, formatGraphResult } from './tools/graph.js';
import { runSchemaCheck, formatSchemaResult } from './tools/schema.js';
import { runRouteGuard, formatRouteGuardResult } from './tools/routes.js';
import { runChangelog, formatChangelogResult } from './tools/changelog.js';
import { runWhatsnew, formatWhatsnewResult } from './tools/whatsnew.js';
import { runSilentCatch, formatSilentCatchResult } from './tools/silent-catch.js';
import { DependencyGraph } from './graph/dependency-graph.js';
import type { ProjectIndex } from './storage/index-store.js';

const COMMANDS_HOOK = ['guard', 'check'];
const COMMANDS_CLI = ['init', 'status', 'impact', 'health', 'regression', 'graph', 'schema', 'routes', 'changelog', 'whatsnew', 'silent_catch'];
const ALL_COMMANDS = [...COMMANDS_HOOK, ...COMMANDS_CLI];

// --- Lecture stdin ---

const MAX_STDIN_BYTES = 1_048_576; // 1 Mo

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    let truncated = false;
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => {
      if (truncated) return;
      data += chunk;
      if (Buffer.byteLength(data) > MAX_STDIN_BYTES) {
        truncated = true;
        data = '';
      }
    });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 10000);
  });
}

// --- Indexation ---

async function ensureIndex(projectRoot: string): Promise<ProjectIndex> {
  const store = new IndexStore(projectRoot);
  const existing = store.load();
  if (existing) return existing;
  const { index } = await indexProject(projectRoot);
  return index;
}

// --- Mode hook (guard/check) ---

async function hookGuard(projectRoot: string, filePath: string): Promise<void> {
  const index = await ensureIndex(projectRoot);
  const result = runGuard(index, filePath);
  const formatted = formatGuardResult(result);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: result.risk === 'critical' ? 'deny' : 'allow',
      ...(result.risk === 'critical'
        ? { permissionDecisionReason: `CodeGuard: risque CRITIQUE. ${result.warnings.map((w) => w.message).join(' ')}` }
        : {}),
      additionalContext: formatted,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

async function hookCheck(projectRoot: string, filePath: string): Promise<void> {
  const index = await ensureIndex(projectRoot);
  const result = await runCheck(index, filePath);
  const formatted = formatCheckResult(result);

  const store = new IndexStore(projectRoot);
  store.save(index);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: formatted,
    },
  };
  process.stdout.write(JSON.stringify(output));
}

async function runHookMode(command: string): Promise<void> {
  const argProjectRoot = process.argv[3];

  const stdinData = await readStdin();
  let filePath = '';
  let hookCwd = '';

  if (stdinData.trim()) {
    try {
      const parsed: unknown = JSON.parse(stdinData);
      const hookInput = validateHookInput(parsed);
      if (hookInput) {
        filePath = hookInput.filePath;
        hookCwd = hookInput.cwd;
        if (filePath) filePath = resolve(filePath);
      }
    } catch {
      if (stdinData.trim().length > 0) {
        logger.warn('Stdin non-JSON recu par le hook', { preview: stdinData.slice(0, 200) });
      }
    }
  }

  const candidateRoot = resolve(argProjectRoot ?? (hookCwd || process.cwd()));
  const projectRoot = findProjectRoot(candidateRoot);
  initLogger(projectRoot, 'warn');

  // Valider que le filePath du hook reste dans le projet
  if (filePath) {
    const normalizedFile = filePath.replace(/\\/g, '/').toLowerCase();
    const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();
    if (!normalizedFile.startsWith(normalizedRoot)) {
      filePath = ''; // Ignorer les chemins hors projet
      logger.warn('Chemin hors du projet ignore par le hook', { filePath });
    }
  }

  if (!filePath) {
    const eventName = command === 'guard' ? 'PreToolUse' : 'PostToolUse';
    const output = {
      hookSpecificOutput: {
        hookEventName: eventName,
        ...(command === 'guard' ? { permissionDecision: 'allow' as const } : {}),
        additionalContext: 'CodeGuard: pas de fichier a verifier.',
      },
    };
    process.stdout.write(JSON.stringify(output));
    return;
  }

  try {
    if (command === 'guard') {
      await hookGuard(projectRoot, filePath);
    } else {
      await hookCheck(projectRoot, filePath);
    }
  } catch (error) {
    logger.error('Erreur hook', { command, error: String(error) });
    const eventName = command === 'guard' ? 'PreToolUse' : 'PostToolUse';
    const output = {
      hookSpecificOutput: {
        hookEventName: eventName,
        ...(command === 'guard' ? { permissionDecision: 'allow' as const } : {}),
        additionalContext: `CodeGuard: erreur interne (${error instanceof Error ? error.message : String(error)}).`,
      },
    };
    process.stdout.write(JSON.stringify(output));
  }
}

/**
 * Remonte depuis un repertoire candidat jusqu'a la vraie racine du projet.
 * Strategie : racine git d'abord (fiable pour les monorepos),
 * puis fallback sur .codeguard/index.json en remontant.
 */
function findProjectRoot(candidate: string): string {
  // 1. Racine git — la source de verite pour les monorepos
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      cwd: candidate,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (gitRoot) return resolve(gitRoot);
  } catch {
    // Pas un repo git — continuer
  }

  // 2. Fallback : remonter pour trouver un .codeguard/index.json
  let search = candidate;
  const root = resolve('/');
  while (search !== root) {
    if (existsSync(join(search, '.codeguard', 'index.json'))) {
      return search;
    }
    const parent = resolve(search, '..');
    if (parent === search) break;
    search = parent;
  }

  return candidate;
}

/** Resout un chemin et verifie qu'il reste dans le projet */
function safeResolvePath(input: string, projectRoot: string): string {
  const resolved = resolve(input);
  const normalizedResolved = resolved.replace(/\\/g, '/').toLowerCase();
  const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();
  if (!normalizedResolved.startsWith(normalizedRoot)) {
    throw new Error(`Chemin hors du projet interdit : ${input}`);
  }
  return resolved;
}

// --- Mode CLI (init/status/impact/health/regression) ---

async function runCliMode(command: string): Promise<void> {
  // Pour impact/regression, le fichier est argv[3] et project root argv[4]
  // Pour init/status/health, project root est argv[3]
  const needsFile = command === 'impact' || command === 'regression';
  const optionalFile = command === 'graph';
  const fileArg = (needsFile || optionalFile) ? process.argv[3] : undefined;
  const rootArg = (needsFile || optionalFile) ? process.argv[4] : process.argv[3];

  if (needsFile && !fileArg) {
    console.error(`Usage: codeguard-cli ${command} <fichier> [project-root]`);
    process.exit(1);
  }

  const projectRoot = findProjectRoot(resolve(rootArg ?? process.cwd()));
  initLogger(projectRoot, 'warn');

  switch (command) {
    case 'init': {
      console.log(`Indexation de ${projectRoot}...`);
      const { index } = await indexProject(projectRoot);
      const graph = DependencyGraph.fromIndex(index);
      console.log(`Indexation terminee.`);
      console.log(`  Fichiers : ${index.fileCount}`);
      console.log(`  Noeuds   : ${graph.getNodeCount()}`);
      console.log(`  Aretes   : ${graph.getEdgeCount()}`);
      console.log(`  Index    : ${resolve(projectRoot, '.codeguard/index.json')}`);
      break;
    }

    case 'status': {
      const store = new IndexStore(projectRoot);
      const index = store.load();
      if (!index) {
        console.log('Aucun index. Lancez "codeguard-cli init" pour indexer le projet.');
        process.exit(1);
      }
      const age = Date.now() - index.indexedAt;
      const ageMin = Math.round(age / 60000);
      console.log(`CodeGuard — Status`);
      console.log(`  Projet  : ${index.projectRoot}`);
      console.log(`  Fichiers: ${index.fileCount}`);
      console.log(`  Index   : ${new Date(index.indexedAt).toLocaleString('fr-FR')}`);
      console.log(`  Age     : ${ageMin < 60 ? `${ageMin} min` : `${Math.round(ageMin / 60)}h`}`);
      break;
    }

    case 'impact': {
      const index = await ensureIndex(projectRoot);
      const filePath = safeResolvePath(fileArg!, projectRoot);
      const result = runImpactAnalysis(index, filePath);
      console.log(formatImpactResult(result));
      break;
    }

    case 'health': {
      const index = await ensureIndex(projectRoot);
      const result = runHealth(index);
      console.log(formatHealthResult(result));
      break;
    }

    case 'regression': {
      const index = await ensureIndex(projectRoot);
      const filePath = safeResolvePath(fileArg!, projectRoot);
      const result = runRegressionMap(index, filePath);
      console.log(formatRegressionResult(result));
      break;
    }

    case 'graph': {
      const index = await ensureIndex(projectRoot);
      const focusFile = fileArg ? safeResolvePath(fileArg, projectRoot) : undefined;
      const result = generateGraph(index, focusFile);
      console.log(formatGraphResult(result));
      break;
    }

    case 'schema': {
      const index = await ensureIndex(projectRoot);
      const result = runSchemaCheck(index);
      console.log(formatSchemaResult(result));
      break;
    }

    case 'routes': {
      const index = await ensureIndex(projectRoot);
      const result = runRouteGuard(index);
      console.log(formatRouteGuardResult(result));
      break;
    }

    case 'changelog': {
      const store = new IndexStore(projectRoot);
      const index = store.load();
      if (!index) {
        console.log('Aucun index. Lancez "codeguard-cli init" d\'abord.');
        process.exit(1);
      }
      const snapshot = store.loadSnapshot();
      const result = runChangelog(index, snapshot);
      console.log(formatChangelogResult(result));
      break;
    }

    case 'whatsnew': {
      const store = new IndexStore(projectRoot);
      const index = store.load();
      if (!index) {
        console.log('Aucun index. Lancez "codeguard-cli init" d\'abord.');
        process.exit(1);
      }
      const snapshot = store.loadSnapshot();
      const since = process.argv[3];
      const result = runWhatsnew(index, snapshot, since);
      console.log(formatWhatsnewResult(result));
      break;
    }

    case 'silent_catch': {
      const severity = process.argv[3] ?? 'all';
      const result = await runSilentCatch(projectRoot, severity);
      console.log(formatSilentCatchResult(result));
      break;
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || !ALL_COMMANDS.includes(command)) {
    console.log(`CodeGuard CLI v0.1.0\n`);
    console.log(`Usage: codeguard-cli <commande> [options]\n`);
    console.log(`Commandes :`);
    console.log(`  init    [project-root]          Indexer le projet`);
    console.log(`  status  [project-root]          Etat de l'index`);
    console.log(`  impact  <fichier> [project-root] Analyse d'impact`);
    console.log(`  health  [project-root]          Score de sante`);
    console.log(`  regression <fichier> [project-root] Pages a retester`);
    console.log(`  graph   [fichier] [project-root]  Diagramme Mermaid (complet ou focus)`);
    console.log(`  schema  [project-root]          Coherence Prisma ↔ DTOs ↔ types`);
    console.log(`  routes  [project-root]          Coherence routes frontend ↔ backend`);
    console.log(`  changelog [project-root]        Diff depuis le dernier reindex`);
    console.log(`  guard   [project-root]          Hook pre-modification (stdin JSON)`);
    console.log(`  check   [project-root]          Hook post-modification (stdin JSON)`);
    process.exit(command ? 1 : 0);
  }

  if (COMMANDS_HOOK.includes(command)) {
    await runHookMode(command);
  } else {
    await runCliMode(command);
  }
}

main().catch((error) => {
  console.error(`Erreur fatale: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
