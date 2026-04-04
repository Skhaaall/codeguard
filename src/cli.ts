#!/usr/bin/env node

/**
 * CodeGuard CLI — point d'entree pour les hooks Claude Code.
 * Lit le JSON du hook sur stdin, execute guard ou check, retourne le resultat au format hook.
 *
 * Usage (appele par les hooks, pas manuellement) :
 *   echo '{"tool_input":{"file_path":"/path/to/file.ts"}}' | node dist/cli.js guard /project/root
 *   echo '{"tool_input":{"file_path":"/path/to/file.ts"}}' | node dist/cli.js check /project/root
 */

import { resolve } from 'node:path';
import { IndexStore } from './storage/index-store.js';
import { TypeScriptParser } from './parsers/typescript-parser.js';
import { scanProject } from './utils/scanner.js';
import { initLogger, logger } from './utils/logger.js';
import { runGuard, formatGuardResult } from './tools/guard.js';
import { runCheck, formatCheckResult } from './tools/check.js';
import type { ProjectIndex } from './storage/index-store.js';

// --- Lecture stdin ---

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => resolve(data));
    // Timeout : si pas de stdin apres 2s, continuer avec du vide
    setTimeout(() => resolve(data), 2000);
  });
}

// --- Indexation rapide si pas d'index ---

async function ensureIndex(projectRoot: string): Promise<ProjectIndex> {
  const store = new IndexStore(projectRoot);
  const existing = store.load();
  if (existing) return existing;

  // Pas d'index — en creer un rapidement
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

  store.save(index);
  return index;
}

// --- Commandes ---

async function handleGuard(projectRoot: string, filePath: string): Promise<void> {
  const index = await ensureIndex(projectRoot);
  const result = runGuard(index, filePath);
  const formatted = formatGuardResult(result);

  if (result.risk === 'critical') {
    // Risque critique : bloquer la modification
    const output = {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `CodeGuard: risque CRITIQUE sur ${filePath}. ${result.warnings.map((w) => w.message).join(' ')}`,
        additionalContext: formatted,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  // Risque non critique : laisser passer avec contexte
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      additionalContext: formatted,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

async function handleCheck(projectRoot: string, filePath: string): Promise<void> {
  const index = await ensureIndex(projectRoot);
  const result = await runCheck(index, filePath);
  const formatted = formatCheckResult(result);

  // Sauvegarder l'index mis a jour
  const store = new IndexStore(projectRoot);
  store.save(index);

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: formatted,
    },
  };
  process.stdout.write(JSON.stringify(output));
  process.exit(0);
}

// --- Main ---

async function main(): Promise<void> {
  const command = process.argv[2]; // 'guard' ou 'check'
  const argProjectRoot = process.argv[3];

  if (!command || !['guard', 'check'].includes(command)) {
    process.stderr.write('Usage: codeguard-cli <guard|check> [project-root]\n');
    process.exit(1);
  }

  // Lire le JSON du hook sur stdin
  const stdinData = await readStdin();
  let filePath = '';
  let hookCwd = '';

  if (stdinData.trim()) {
    try {
      const hookInput = JSON.parse(stdinData);
      filePath = hookInput?.tool_input?.file_path ?? '';
      hookCwd = hookInput?.cwd ?? '';
      // Normaliser le chemin (Windows : resolve convertit les / en \)
      if (filePath) {
        filePath = resolve(filePath);
      }
    } catch {
      // stdin non-JSON — pas grave
    }
  }

  // Project root : argument > cwd du hook > process.cwd()
  const projectRoot = resolve(argProjectRoot ?? (hookCwd || process.cwd()));
  initLogger(projectRoot, 'warn');

  if (!filePath) {
    // Pas de fichier — rien a verifier
    const output = {
      hookSpecificOutput: {
        hookEventName: command === 'guard' ? 'PreToolUse' : 'PostToolUse',
        ...(command === 'guard'
          ? { permissionDecision: 'allow' as const }
          : {}),
        additionalContext: 'CodeGuard: pas de fichier a verifier.',
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }

  try {
    if (command === 'guard') {
      await handleGuard(projectRoot, filePath);
    } else {
      await handleCheck(projectRoot, filePath);
    }
  } catch (error) {
    logger.error('Erreur CLI', { command, error: String(error) });
    // Ne pas bloquer Claude Code en cas d'erreur interne
    const output = {
      hookSpecificOutput: {
        hookEventName: command === 'guard' ? 'PreToolUse' : 'PostToolUse',
        ...(command === 'guard'
          ? { permissionDecision: 'allow' as const }
          : {}),
        additionalContext: `CodeGuard: erreur interne (${error instanceof Error ? error.message : String(error)}). Modification autorisee par defaut.`,
      },
    };
    process.stdout.write(JSON.stringify(output));
    process.exit(0);
  }
}

main();
