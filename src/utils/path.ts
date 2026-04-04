/**
 * Utilitaires de chemins partages.
 */

/** Extrait un chemin court depuis un chemin absolu (ex: "src/parsers/base-parser") */
export function toShortPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const srcIdx = normalized.lastIndexOf('/src/');
  if (srcIdx !== -1) return normalized.slice(srcIdx + 1);
  return normalized.split('/').slice(-3).join('/');
}
