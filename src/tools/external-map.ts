/**
 * Outil MCP : external_map
 * Cartographie les connexions externes du projet :
 * - Packages npm (utilises, inutilises, critiques par nombre d'importeurs)
 * - Variables d'environnement (process.env.XXX, risque si absente de .env.example)
 * - Appels API sortants (fetch/axios vers des URLs externes)
 */

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectIndex } from '../storage/index-store.js';

// --- Types ---

export interface ExternalMapResult {
  /** Packages npm utilises dans le code */
  packages: PackageUsage[];
  /** Packages declares dans package.json mais jamais importes */
  unusedPackages: string[];
  /** Variables d'environnement trouvees dans le code */
  envVars: EnvVarUsage[];
  /** Variables d'env manquantes de .env.example */
  missingFromExample: string[];
  /** Appels API sortants agreges */
  apiCalls: ApiCallAggregated[];
  /** Stats globales */
  stats: {
    totalPackages: number;
    usedPackages: number;
    unusedPackages: number;
    totalEnvVars: number;
    totalApiCalls: number;
  };
}

export interface PackageUsage {
  /** Nom du package (ex: "react", "@prisma/client") */
  name: string;
  /** Nombre de fichiers qui l'importent */
  importerCount: number;
  /** Fichiers qui l'importent (max 5 affiches) */
  importers: string[];
  /** dependencies ou devDependencies */
  declaredIn: 'dependencies' | 'devDependencies' | 'undeclared';
  /** Critique = utilise par beaucoup de fichiers */
  isCritical: boolean;
}

export interface EnvVarUsage {
  /** Nom de la variable (ex: DATABASE_URL) */
  name: string;
  /** Fichiers qui l'utilisent */
  files: string[];
  /** Presente dans .env.example ? */
  inExample: boolean;
}

export interface ApiCallAggregated {
  /** Methode HTTP */
  method: string;
  /** URL ou pattern */
  url: string;
  /** Nombre d'appels */
  count: number;
  /** Fichiers qui font cet appel */
  files: string[];
}

// --- Logique ---

const CRITICAL_THRESHOLD = 5; // Un package utilise par 5+ fichiers = critique

/** Detecte si un import source est un package externe (pas un chemin relatif/alias) */
function isExternalImport(source: string): boolean {
  // Chemins relatifs : ./foo, ../bar
  if (source.startsWith('.')) return false;
  // Path aliases TypeScript : @/foo, ~/foo
  if (source.startsWith('@/') || source.startsWith('~/')) return false;
  // Node builtins : node:fs, fs, path, etc.
  if (source.startsWith('node:')) return false;
  const NODE_BUILTINS = new Set([
    'fs',
    'path',
    'os',
    'url',
    'util',
    'crypto',
    'stream',
    'http',
    'https',
    'events',
    'child_process',
    'buffer',
    'assert',
    'querystring',
    'zlib',
    'net',
    'tls',
    'dgram',
    'dns',
    'cluster',
    'worker_threads',
    'perf_hooks',
    'async_hooks',
    'readline',
    'repl',
    'vm',
    'v8',
    'inspector',
    'timers',
    'string_decoder',
    'tty',
    'domain',
    'constants',
    'module',
    'process',
    'console',
  ]);
  const baseName = source.split('/')[0];
  if (NODE_BUILTINS.has(baseName)) return false;
  return true;
}

/** Extrait le nom du package depuis un import source (gere les scoped packages) */
function getPackageName(source: string): string {
  const parts = source.split('/');
  // Scoped package : @scope/package
  if (parts[0].startsWith('@') && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0];
}

/** Scanne l'index pour trouver tous les packages externes utilises */
function scanPackages(index: ProjectIndex): Map<string, Set<string>> {
  const packageImporters = new Map<string, Set<string>>();

  for (const [filePath, node] of Object.entries(index.files)) {
    for (const imp of node.imports) {
      if (!isExternalImport(imp.source)) continue;
      const pkgName = getPackageName(imp.source);
      if (!packageImporters.has(pkgName)) {
        packageImporters.set(pkgName, new Set());
      }
      packageImporters.get(pkgName)!.add(filePath);
    }
  }

  return packageImporters;
}

/** Lit le package.json du projet */
function readPackageJson(
  projectRoot: string,
): { dependencies: Record<string, string>; devDependencies: Record<string, string> } | null {
  const pkgPath = join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const raw = readFileSync(pkgPath, 'utf-8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    return {
      dependencies: (pkg.dependencies ?? {}) as Record<string, string>,
      devDependencies: (pkg.devDependencies ?? {}) as Record<string, string>,
    };
  } catch {
    return null;
  }
}

/** Lit le .env.example pour lister les variables documentees */
function readEnvExample(projectRoot: string): Set<string> {
  const vars = new Set<string>();
  const candidates = ['.env.example', '.env.sample', '.env.template'];

  for (const name of candidates) {
    const envPath = join(projectRoot, name);
    if (!existsSync(envPath)) continue;
    try {
      const content = readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const match = trimmed.match(/^([A-Z_][A-Z0-9_]*)=/);
        if (match) vars.add(match[1]);
      }
    } catch {
      // Ignorer les erreurs de lecture
    }
  }

  return vars;
}

/** Scanne le code source pour trouver les usages de process.env.XXX */
function scanEnvVars(index: ProjectIndex, projectRoot: string): Map<string, Set<string>> {
  const envVars = new Map<string, Set<string>>();
  const ENV_REGEX = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  // Aussi detecter import.meta.env.XXX (Vite)
  const VITE_ENV_REGEX = /import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;

  for (const filePath of Object.keys(index.files)) {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const regexes = [ENV_REGEX, VITE_ENV_REGEX];

      for (const regex of regexes) {
        regex.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = regex.exec(content)) !== null) {
          const varName = match[1];
          if (!envVars.has(varName)) {
            envVars.set(varName, new Set());
          }
          envVars.get(varName)!.add(shortPath(filePath, projectRoot));
        }
      }
    } catch {
      // Fichier illisible — skip
    }
  }

  return envVars;
}

/** Agrege les appels API de l'index */
function aggregateApiCalls(index: ProjectIndex, projectRoot: string): ApiCallAggregated[] {
  const callMap = new Map<string, { method: string; url: string; files: Set<string> }>();

  for (const [filePath, node] of Object.entries(index.files)) {
    if (!node.apiCalls) continue;
    for (const call of node.apiCalls) {
      const key = `${call.method} ${call.url}`;
      if (!callMap.has(key)) {
        callMap.set(key, { method: call.method, url: call.url, files: new Set() });
      }
      callMap.get(key)!.files.add(shortPath(filePath, projectRoot));
    }
  }

  return Array.from(callMap.values())
    .map((c) => ({
      method: c.method,
      url: c.url,
      count: c.files.size,
      files: Array.from(c.files),
    }))
    .sort((a, b) => b.count - a.count);
}

/** Raccourcit un chemin pour l'affichage */
function shortPath(filePath: string, projectRoot: string): string {
  return filePath.replace(projectRoot, '').replace(/\\/g, '/').replace(/^\//, '');
}

// --- Point d'entree ---

export function runExternalMap(index: ProjectIndex): ExternalMapResult {
  const projectRoot = index.projectRoot;

  // 1. Packages npm
  const packageImporters = scanPackages(index);
  const pkgJson = readPackageJson(projectRoot);
  const allDeclared = new Set<string>();
  if (pkgJson) {
    for (const name of Object.keys(pkgJson.dependencies)) allDeclared.add(name);
    for (const name of Object.keys(pkgJson.devDependencies)) allDeclared.add(name);
  }

  const packages: PackageUsage[] = [];
  for (const [name, importers] of packageImporters) {
    const importerPaths = Array.from(importers).map((f) => shortPath(f, projectRoot));
    let declaredIn: PackageUsage['declaredIn'] = 'undeclared';
    if (pkgJson?.dependencies[name]) declaredIn = 'dependencies';
    else if (pkgJson?.devDependencies[name]) declaredIn = 'devDependencies';

    packages.push({
      name,
      importerCount: importers.size,
      importers: importerPaths.slice(0, 5),
      declaredIn,
      isCritical: importers.size >= CRITICAL_THRESHOLD,
    });
  }
  packages.sort((a, b) => b.importerCount - a.importerCount);

  // Packages declares mais jamais importes
  const usedPackageNames = new Set(packageImporters.keys());
  const unusedPackages: string[] = [];
  if (pkgJson) {
    for (const name of Object.keys(pkgJson.dependencies)) {
      if (!usedPackageNames.has(name)) unusedPackages.push(name);
    }
    // Les devDependencies sont souvent des outils (eslint, prettier...) — on ne les signale pas
  }

  // 2. Variables d'environnement
  const envVarMap = scanEnvVars(index, projectRoot);
  const exampleVars = readEnvExample(projectRoot);

  const envVars: EnvVarUsage[] = [];
  const missingFromExample: string[] = [];
  for (const [name, files] of envVarMap) {
    const inExample = exampleVars.has(name);
    envVars.push({ name, files: Array.from(files), inExample });
    if (!inExample) missingFromExample.push(name);
  }
  envVars.sort((a, b) => b.files.length - a.files.length);

  // 3. Appels API sortants
  const apiCalls = aggregateApiCalls(index, projectRoot);

  return {
    packages,
    unusedPackages,
    envVars,
    missingFromExample,
    apiCalls,
    stats: {
      totalPackages: allDeclared.size,
      usedPackages: packages.length,
      unusedPackages: unusedPackages.length,
      totalEnvVars: envVars.length,
      totalApiCalls: apiCalls.length,
    },
  };
}

// --- Formatage ---

export function formatExternalMapResult(result: ExternalMapResult): string {
  const lines: string[] = [];

  lines.push('## Carte des connexions externes');
  lines.push('');

  // Stats
  lines.push(
    `**${result.stats.usedPackages} packages** utilises | ${result.stats.unusedPackages} inutilise(s) | ${result.stats.totalEnvVars} var(s) d'env | ${result.stats.totalApiCalls} endpoint(s) API`,
  );
  lines.push('');

  // Packages critiques
  const critical = result.packages.filter((p) => p.isCritical);
  if (critical.length > 0) {
    lines.push('### Packages critiques (5+ importeurs)');
    lines.push('');
    lines.push('| Package | Importeurs | Declare dans |');
    lines.push('|---|---|---|');
    for (const p of critical) {
      lines.push(`| \`${p.name}\` | ${p.importerCount} fichier(s) | ${p.declaredIn} |`);
    }
    lines.push('');
    lines.push('> Si un de ces packages introduit un breaking change, beaucoup de fichiers sont impactes.');
    lines.push('');
  }

  // Tous les packages
  if (result.packages.length > 0) {
    lines.push('### Tous les packages externes');
    lines.push('');
    for (const p of result.packages) {
      const tag = p.declaredIn === 'undeclared' ? ' **(non declare dans package.json)**' : '';
      const criticalTag = p.isCritical ? ' **CRITIQUE**' : '';
      lines.push(`- \`${p.name}\` — ${p.importerCount} importeur(s)${criticalTag}${tag}`);
      if (p.importers.length > 0) {
        const shown = p.importers.slice(0, 3).join(', ');
        const more = p.importerCount > 3 ? ` (+${p.importerCount - 3} autres)` : '';
        lines.push(`  ↳ ${shown}${more}`);
      }
    }
    lines.push('');
  }

  // Packages inutilises
  if (result.unusedPackages.length > 0) {
    lines.push('### Packages inutilises (dans dependencies mais jamais importes)');
    lines.push('');
    for (const name of result.unusedPackages) {
      lines.push(`- \`${name}\``);
    }
    lines.push('');
    lines.push('> Ces packages peuvent etre des faux positifs si utilises via CLI, scripts ou config.');
    lines.push('');
  }

  // Variables d'environnement
  if (result.envVars.length > 0) {
    lines.push("### Variables d'environnement");
    lines.push('');
    lines.push('| Variable | Fichiers | Dans .env.example |');
    lines.push('|---|---|---|');
    for (const v of result.envVars) {
      const status = v.inExample ? 'oui' : '**NON**';
      const fileList = v.files.slice(0, 3).join(', ');
      const more = v.files.length > 3 ? ` (+${v.files.length - 3})` : '';
      lines.push(`| \`${v.name}\` | ${fileList}${more} | ${status} |`);
    }
    lines.push('');

    if (result.missingFromExample.length > 0) {
      lines.push(
        `> **${result.missingFromExample.length} variable(s)** non documentee(s) dans .env.example : ${result.missingFromExample.map((v) => `\`${v}\``).join(', ')}`,
      );
      lines.push('');
    }
  }

  // Appels API sortants
  if (result.apiCalls.length > 0) {
    lines.push('### Appels API sortants');
    lines.push('');
    lines.push('| Methode | URL | Appels | Fichiers |');
    lines.push('|---|---|---|---|');
    for (const c of result.apiCalls) {
      const fileList = c.files.slice(0, 3).join(', ');
      const more = c.files.length > 3 ? ` (+${c.files.length - 3})` : '';
      lines.push(`| ${c.method} | \`${c.url}\` | ${c.count} | ${fileList}${more} |`);
    }
    lines.push('');
  }

  if (result.packages.length === 0 && result.envVars.length === 0 && result.apiCalls.length === 0) {
    lines.push('Aucune connexion externe detectee.');
  }

  return lines.join('\n');
}
