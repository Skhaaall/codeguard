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

import { resolve } from 'node:path';
import { IndexStore } from './storage/index-store.js';
import { TypeScriptParser } from './parsers/typescript-parser.js';
import { scanProject } from './utils/scanner.js';
import { initLogger, logger } from './utils/logger.js';
import { runGuard, formatGuardResult } from './tools/guard.js';
import { runCheck, formatCheckResult } from './tools/check.js';
import { runHealth, formatHealthResult } from './tools/health.js';
import { runRegressionMap, formatRegressionResult } from './tools/regression.js';
import { runImpactAnalysis, formatImpactResult } from './tools/impact.js';
import { DependencyGraph } from './graph/dependency-graph.js';
import type { ProjectIndex } from './storage/index-store.js';

const COMMANDS_HOOK = ['guard', 'check'];
const COMMANDS_CLI = ['init', 'status', 'impact', 'health', 'regression'];
const ALL_COMMANDS = [...COMMANDS_HOOK, ...COMMANDS_CLI];

// --- Lecture stdin ---

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    setTimeout(() => resolve(data), 2000);
  });
}

// --- Indexation ---

async function ensureIndex(projectRoot: string): Promise<ProjectIndex> {
  const store = new IndexStore(projectRoot);
  const existing = store.load();
  if (existing) return existing;
  return indexProject(projectRoot);
}

async function indexProject(projectRoot: string): Promise<ProjectIndex> {
  const scan = scanProject(projectRoot);
  const parser = new TypeScriptParser();
  const tsFiles = scan.files.filter((f) => parser.canParse(f));
  const nodes = await parser.parseFiles(tsFiles);

  const index: ProjectIndex = {
    projectRoot,
    indexedAt: Date.now(),
    fileCount: nodes.length,
    files: {},
  };

  for (const node of nodes) {
    index.files[node.filePath] = node;
  }

  const store = new IndexStore(projectRoot);
  store.save(index);
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
      const hookInput = JSON.parse(stdinData);
      filePath = hookInput?.tool_input?.file_path ?? '';
      hookCwd = hookInput?.cwd ?? '';
      if (filePath) filePath = resolve(filePath);
    } catch {
      // stdin non-JSON
    }
  }

  const projectRoot = resolve(argProjectRoot ?? (hookCwd || process.cwd()));
  initLogger(projectRoot, 'warn');

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

// --- Mode CLI (init/status/impact/health/regression) ---

async function runCliMode(command: string): Promise<void> {
  // Pour impact/regression, le fichier est argv[3] et project root argv[4]
  // Pour init/status/health, project root est argv[3]
  const needsFile = command === 'impact' || command === 'regression';
  const fileArg = needsFile ? process.argv[3] : undefined;
  const rootArg = needsFile ? process.argv[4] : process.argv[3];

  if (needsFile && !fileArg) {
    console.error(`Usage: codeguard-cli ${command} <fichier> [project-root]`);
    process.exit(1);
  }

  const projectRoot = resolve(rootArg ?? process.cwd());
  initLogger(projectRoot, 'warn');

  switch (command) {
    case 'init': {
      console.log(`Indexation de ${projectRoot}...`);
      const index = await indexProject(projectRoot);
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
      const filePath = resolve(fileArg!);
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
      const filePath = resolve(fileArg!);
      const result = runRegressionMap(index, filePath);
      console.log(formatRegressionResult(result));
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
