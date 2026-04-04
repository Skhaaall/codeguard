/**
 * Stockage de la carte du projet en JSON.
 * La carte est sauvegardee dans .codeguard/index.json a la racine du projet cible.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FileNode } from '../parsers/base-parser.js';
import { logger } from '../utils/logger.js';

const MAX_INDEX_BYTES = 52_428_800; // 50 Mo

export interface ProjectIndex {
  /** Racine du projet indexe */
  projectRoot: string;
  /** Date de derniere indexation complete */
  indexedAt: number;
  /** Nombre de fichiers indexes */
  fileCount: number;
  /** Carte : chemin du fichier → FileNode */
  files: Record<string, FileNode>;
}

export class IndexStore {
  private indexPath: string;
  private codeguardDir: string;

  constructor(projectRoot: string) {
    this.codeguardDir = join(projectRoot, '.codeguard');
    this.indexPath = join(this.codeguardDir, 'index.json');
  }

  /** Charge l'index existant ou retourne null */
  load(): ProjectIndex | null {
    if (!existsSync(this.indexPath)) return null;

    try {
      const size = statSync(this.indexPath).size;
      if (size > MAX_INDEX_BYTES) {
        logger.warn('Index trop volumineux, ignore', { size, maxBytes: MAX_INDEX_BYTES });
        return null;
      }
      const raw = readFileSync(this.indexPath, 'utf-8');
      return JSON.parse(raw) as ProjectIndex;
    } catch (error) {
      logger.warn('Index corrompu, sera re-genere', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** Sauvegarde l'index complet */
  save(index: ProjectIndex): void {
    if (!existsSync(this.codeguardDir)) {
      mkdirSync(this.codeguardDir, { recursive: true });
    }

    writeFileSync(this.indexPath, JSON.stringify(index, null, 2), 'utf-8');
    logger.info('Index sauvegarde', { fileCount: index.fileCount });
  }

  /** Met a jour un seul fichier dans l'index (re-indexation incrementale) */
  updateFile(index: ProjectIndex, node: FileNode): ProjectIndex {
    index.files[node.filePath] = node;
    index.fileCount = Object.keys(index.files).length;
    index.indexedAt = Date.now();
    return index;
  }

  /** Supprime un fichier de l'index */
  removeFile(index: ProjectIndex, filePath: string): ProjectIndex {
    delete index.files[filePath];
    index.fileCount = Object.keys(index.files).length;
    index.indexedAt = Date.now();
    return index;
  }

  /** Verifie si l'index existe */
  exists(): boolean {
    return existsSync(this.indexPath);
  }
}
