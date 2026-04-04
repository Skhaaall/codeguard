/**
 * Logger structure pour CodeGuard.
 * JAMAIS sur stderr — lecon GitNexus : MCP utilise stderr pour les erreurs de protocole.
 * Les logs vont dans un fichier .codeguard/codeguard.log dans le projet cible.
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let logFilePath: string | null = null;
let minLevel: LogLevel = 'info';

export function initLogger(projectRoot: string, level: LogLevel = 'info'): void {
  const codeguardDir = join(projectRoot, '.codeguard');
  if (!existsSync(codeguardDir)) {
    mkdirSync(codeguardDir, { recursive: true });
  }
  logFilePath = join(codeguardDir, 'codeguard.log');
  minLevel = level;
}

function log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
  if (LOG_LEVELS[level] < LOG_LEVELS[minLevel]) return;

  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...(data ? { data } : {}),
  };

  // Ecriture dans le fichier si initialise, sinon on perd le log (mieux que stderr)
  if (logFilePath) {
    try {
      writeFileSync(logFilePath, JSON.stringify(entry) + '\n', { flag: 'a' });
    } catch {
      // Pas de fallback sur stderr — protocole MCP l'interdit
    }
  }
}

export const logger = {
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', msg, data),
};
