#!/usr/bin/env node

/**
 * CodeGuard Setup — installe les hooks dans le settings.json global de Claude Code.
 *
 * Usage :
 *   npx @skhaall/codeguard setup     Installer les hooks
 *   npx @skhaall/codeguard unsetup   Retirer les hooks
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Chemin absolu vers le CLI de CodeGuard (dans le meme dossier que ce script)
const CLI_PATH = resolve(__dirname, 'cli.js').replace(/\\/g, '/');

// Chemin du settings.json global de Claude Code
function getSettingsPath(): string {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  return join(home, '.claude', 'settings.json');
}

interface Hook {
  type: string;
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface HookEntry {
  matcher: string;
  hooks: Hook[];
}

interface Settings {
  hooks?: {
    PreToolUse?: HookEntry[];
    PostToolUse?: HookEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const GUARD_HOOK: HookEntry = {
  matcher: 'Edit|Write',
  hooks: [{
    type: 'command',
    command: `node "${CLI_PATH}" guard`,
    timeout: 30,
    statusMessage: 'CodeGuard: analyse pre-modification...',
  }],
};

const CHECK_HOOK: HookEntry = {
  matcher: 'Edit|Write',
  hooks: [{
    type: 'command',
    command: `node "${CLI_PATH}" check`,
    timeout: 30,
    statusMessage: 'CodeGuard: verification post-modification...',
  }],
};

function isCodeGuardHook(entry: HookEntry): boolean {
  return entry.hooks.some((h) => h.command.includes('codeguard') && h.command.includes('cli.js'));
}

function install(): void {
  const settingsPath = getSettingsPath();
  console.log(`Settings : ${settingsPath}`);

  // Lire le settings existant ou creer un nouveau
  let settings: Settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    } catch {
      console.error('Erreur : settings.json invalide. Sauvegardez-le et reessayez.');
      process.exit(1);
    }
  } else {
    // Creer le dossier .claude si necessaire
    const dir = dirname(settingsPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
  if (!settings.hooks.PostToolUse) settings.hooks.PostToolUse = [];

  // Retirer les anciens hooks CodeGuard s'ils existent
  settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((e) => !isCodeGuardHook(e as HookEntry)) as HookEntry[];
  settings.hooks.PostToolUse = settings.hooks.PostToolUse.filter((e) => !isCodeGuardHook(e as HookEntry)) as HookEntry[];

  // Ajouter les nouveaux
  settings.hooks.PreToolUse.push(GUARD_HOOK);
  settings.hooks.PostToolUse.unshift(CHECK_HOOK);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

  console.log('');
  console.log('CodeGuard installe avec succes.');
  console.log('');
  console.log('Hooks ajoutes :');
  console.log('  PreToolUse(Edit|Write)  → guard (analyse pre-modification)');
  console.log('  PostToolUse(Edit|Write) → check (verification post-modification)');
  console.log('');
  console.log('Relance Claude Code pour activer les hooks.');
}

function uninstall(): void {
  const settingsPath = getSettingsPath();

  if (!existsSync(settingsPath)) {
    console.log('Rien a retirer — settings.json introuvable.');
    return;
  }

  let settings: Settings;
  try {
    settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
  } catch {
    console.error('Erreur : settings.json invalide.');
    process.exit(1);
  }

  if (!settings.hooks) {
    console.log('Aucun hook configure.');
    return;
  }

  let removed = 0;

  if (settings.hooks.PreToolUse) {
    const before = (settings.hooks.PreToolUse as HookEntry[]).length;
    settings.hooks.PreToolUse = (settings.hooks.PreToolUse as HookEntry[]).filter((e) => !isCodeGuardHook(e));
    removed += before - (settings.hooks.PreToolUse as HookEntry[]).length;
  }

  if (settings.hooks.PostToolUse) {
    const before = (settings.hooks.PostToolUse as HookEntry[]).length;
    settings.hooks.PostToolUse = (settings.hooks.PostToolUse as HookEntry[]).filter((e) => !isCodeGuardHook(e));
    removed += before - (settings.hooks.PostToolUse as HookEntry[]).length;
  }

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');

  if (removed > 0) {
    console.log(`CodeGuard desinstalle — ${removed} hook(s) retire(s).`);
  } else {
    console.log('Aucun hook CodeGuard trouve.');
  }
}

// --- Main ---
const command = process.argv[2];

if (command === 'setup') {
  install();
} else if (command === 'unsetup') {
  uninstall();
} else {
  console.log('Usage :');
  console.log('  codeguard setup     Installer les hooks Claude Code');
  console.log('  codeguard unsetup   Retirer les hooks Claude Code');
  process.exit(1);
}
