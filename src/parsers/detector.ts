/**
 * Detection automatique du langage par extension de fichier.
 * Pas de config manuelle — CodeGuard detecte tout seul.
 */

import type { Language } from './base-parser.js';

const EXTENSION_MAP: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.prisma': 'prisma',
  '.sql': 'sql',
};

/** Fichiers a ignorer lors du scan */
const IGNORED_DIRS = new Set([
  'node_modules',
  '.next',
  '.nuxt',
  'dist',
  'build',
  '.git',
  '.codeguard',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
  'target',
  'vendor',
]);

const IGNORED_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock']);

export function detectLanguage(filePath: string): Language {
  const ext = getExtension(filePath);
  return EXTENSION_MAP[ext] ?? 'unknown';
}

export function shouldIgnorePath(pathSegment: string): boolean {
  return IGNORED_DIRS.has(pathSegment);
}

export function shouldIgnoreFile(fileName: string): boolean {
  return IGNORED_FILES.has(fileName);
}

export function isSupportedFile(filePath: string): boolean {
  const lang = detectLanguage(filePath);
  return lang !== 'unknown';
}

function getExtension(filePath: string): string {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1) return '';
  return filePath.slice(lastDot).toLowerCase();
}
