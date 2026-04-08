/**
 * Outil MCP : schema_check
 * Coherence Prisma ↔ DTOs backend ↔ types frontend.
 * Detecte les champs manquants, types incompatibles, enums desynchronises.
 */

import type { ProjectIndex } from '../storage/index-store.js';
import type { TypeInfo } from '../parsers/base-parser.js';
import { toShortPath } from '../utils/path.js';

export interface SchemaIssue {
  severity: 'error' | 'warning' | 'info';
  model: string;
  message: string;
  prismaFile?: string;
  matchFile?: string;
}

export interface SchemaResult {
  /** Nombre de modeles Prisma trouves */
  modelCount: number;
  /** Nombre d'enums Prisma trouves */
  enumCount: number;
  /** Correspondances trouvees (modele Prisma → DTO/type) */
  matches: SchemaMatch[];
  /** Problemes detectes */
  issues: SchemaIssue[];
  issueCount: number;
}

export interface SchemaMatch {
  prismaModel: string;
  matchedType: string;
  matchedFile: string;
  /** Champs Prisma absents du type matche */
  missingFields: string[];
  /** Champs dans le type mais pas dans Prisma */
  extraFields: string[];
}

export function runSchemaCheck(index: ProjectIndex): SchemaResult {
  const issues: SchemaIssue[] = [];
  const matches: SchemaMatch[] = [];

  // 1. Trouver les types Prisma dans l'index (fichiers .prisma)
  const prismaTypes: TypeInfo[] = [];
  let prismaFile = '';
  let enumCount = 0;

  for (const [filePath, node] of Object.entries(index.files)) {
    if (node.language === 'prisma') {
      prismaFile = filePath;
      for (const type of node.types) {
        if (type.kind === 'enum') {
          enumCount++;
        } else {
          prismaTypes.push(type);
        }
      }
    }
  }

  if (prismaTypes.length === 0) {
    return { modelCount: 0, enumCount: 0, matches, issues, issueCount: 0 };
  }

  // 2. Pour chaque modele Prisma, chercher les DTOs/types correspondants
  const nonPrismaTypes = collectNonPrismaTypes(index);

  for (const prismaModel of prismaTypes) {
    const prismaFields = prismaModel.properties.map((p) => p.name);
    const matchCandidates = findMatchingTypes(prismaModel.name, nonPrismaTypes);

    if (matchCandidates.length === 0) {
      issues.push({
        severity: 'info',
        model: prismaModel.name,
        message: `Aucun DTO/type correspondant trouve pour le modele "${prismaModel.name}"`,
        prismaFile,
      });
      continue;
    }

    for (const candidate of matchCandidates) {
      const candidateFields = candidate.type.properties.map((p) => p.name);

      const missingFields = prismaFields.filter((f) => !candidateFields.includes(f));
      const extraFields = candidateFields.filter((f) => !prismaFields.includes(f));

      matches.push({
        prismaModel: prismaModel.name,
        matchedType: candidate.type.name,
        matchedFile: candidate.filePath,
        missingFields,
        extraFields,
      });

      // Signaler les champs manquants importants (pas les relations, pas createdAt/updatedAt)
      const significantMissing = missingFields.filter((f) =>
        !['createdAt', 'updatedAt', 'deletedAt', 'id'].includes(f),
      );

      if (significantMissing.length > 0) {
        issues.push({
          severity: 'warning',
          model: prismaModel.name,
          message: `"${candidate.type.name}" manque ${significantMissing.length} champ(s) Prisma : ${significantMissing.join(', ')}`,
          prismaFile,
          matchFile: candidate.filePath,
        });
      }

      // Signaler les champs extra (potentiellement des champs calcules — juste info)
      if (extraFields.length > 0) {
        issues.push({
          severity: 'info',
          model: prismaModel.name,
          message: `"${candidate.type.name}" a ${extraFields.length} champ(s) supplementaire(s) : ${extraFields.join(', ')}`,
          matchFile: candidate.filePath,
        });
      }
    }
  }

  // 3. Verifier les enums
  const prismaEnums = collectPrismaEnums(index);
  const tsEnums = collectTsEnums(nonPrismaTypes);

  for (const prismaEnum of prismaEnums) {
    const tsMatch = tsEnums.find((e) =>
      e.type.name === prismaEnum.name ||
      e.type.name === prismaEnum.name + 'Type' ||
      e.type.name === prismaEnum.name + 'Enum',
    );

    if (!tsMatch) continue;

    const prismaValues = new Set(prismaEnum.values);
    const tsValues = new Set(tsMatch.type.properties.map((p) => p.name));

    const missingInTs = [...prismaValues].filter((v) => !tsValues.has(v));
    const extraInTs = [...tsValues].filter((v) => !prismaValues.has(v));

    if (missingInTs.length > 0) {
      issues.push({
        severity: 'warning',
        model: prismaEnum.name,
        message: `Enum "${tsMatch.type.name}" manque ${missingInTs.length} valeur(s) Prisma : ${missingInTs.join(', ')}`,
        matchFile: tsMatch.filePath,
      });
    }

    if (extraInTs.length > 0) {
      issues.push({
        severity: 'info',
        model: prismaEnum.name,
        message: `Enum "${tsMatch.type.name}" a ${extraInTs.length} valeur(s) supplementaire(s) : ${extraInTs.join(', ')}`,
        matchFile: tsMatch.filePath,
      });
    }
  }

  return {
    modelCount: prismaTypes.length,
    enumCount,
    matches,
    issues,
    issueCount: issues.filter((i) => i.severity === 'error' || i.severity === 'warning').length,
  };
}

/** Collecte tous les types/interfaces non-Prisma du projet */
function collectNonPrismaTypes(index: ProjectIndex): Array<{ type: TypeInfo; filePath: string }> {
  const result: Array<{ type: TypeInfo; filePath: string }> = [];
  for (const [filePath, node] of Object.entries(index.files)) {
    if (node.language === 'prisma') continue;
    for (const type of node.types) {
      if (type.properties.length > 0) {
        result.push({ type, filePath });
      }
    }
  }
  return result;
}

/** Trouve les types qui correspondent a un modele Prisma (par nom) */
function findMatchingTypes(
  modelName: string,
  allTypes: Array<{ type: TypeInfo; filePath: string }>,
): Array<{ type: TypeInfo; filePath: string }> {
  const nameLower = modelName.toLowerCase();

  return allTypes.filter(({ type }) => {
    const typeLower = type.name.toLowerCase();
    // Correspondances : User → UserDto, CreateUserDto, UserResponse, UserEntity, etc.
    return typeLower === nameLower ||
      typeLower === `${nameLower}dto` ||
      typeLower === `create${nameLower}dto` ||
      typeLower === `update${nameLower}dto` ||
      typeLower === `${nameLower}response` ||
      typeLower === `${nameLower}entity` ||
      typeLower === `${nameLower}type` ||
      typeLower === `${nameLower}props` ||
      typeLower === `${nameLower}data`;
  });
}

/** Collecte les enums du schema Prisma */
function collectPrismaEnums(index: ProjectIndex): Array<{ name: string; values: string[] }> {
  const result: Array<{ name: string; values: string[] }> = [];
  for (const [, node] of Object.entries(index.files)) {
    if (node.language !== 'prisma') continue;
    for (const type of node.types) {
      if (type.kind === 'enum') {
        result.push({ name: type.name, values: type.properties.map((p) => p.name) });
      }
    }
  }
  return result;
}

/** Collecte les enums TypeScript */
function collectTsEnums(
  allTypes: Array<{ type: TypeInfo; filePath: string }>,
): Array<{ type: TypeInfo; filePath: string }> {
  return allTypes.filter(({ type }) => type.kind === 'enum');
}

/** Formate le resultat pour affichage MCP */
export function formatSchemaResult(result: SchemaResult): string {
  const lines: string[] = [];

  if (result.modelCount === 0) {
    lines.push('## Schema Check : N/A');
    lines.push('Aucun fichier Prisma trouve dans l\'index. Lancez "reindex" si le projet utilise Prisma.');
    return lines.join('\n');
  }

  const icon = result.issueCount === 0 ? 'OK' : 'PROBLEMES';
  lines.push(`## Schema Check : ${icon}`);
  lines.push(`**Modeles Prisma** : ${result.modelCount} | **Enums** : ${result.enumCount}`);
  lines.push(`**Correspondances trouvees** : ${result.matches.length}`);

  if (result.matches.length > 0) {
    lines.push('');
    lines.push('### Correspondances Prisma ↔ TS');
    for (const match of result.matches) {
      const status = match.missingFields.length === 0 ? 'OK' : `${match.missingFields.length} champ(s) manquant(s)`;
      lines.push(`- **${match.prismaModel}** ↔ ${match.matchedType} (${toShortPath(match.matchedFile)}) — ${status}`);
    }
  }

  const errors = result.issues.filter((i) => i.severity === 'error');
  const warnings = result.issues.filter((i) => i.severity === 'warning');
  const infos = result.issues.filter((i) => i.severity === 'info');

  if (errors.length > 0) {
    lines.push('');
    lines.push('### Erreurs');
    for (const issue of errors) {
      lines.push(`- [${issue.model}] ${issue.message}`);
    }
  }

  if (warnings.length > 0) {
    lines.push('');
    lines.push('### Avertissements');
    for (const issue of warnings) {
      lines.push(`- [${issue.model}] ${issue.message}`);
    }
  }

  if (infos.length > 0) {
    lines.push('');
    lines.push('### Info');
    for (const issue of infos) {
      lines.push(`- [${issue.model}] ${issue.message}`);
    }
  }

  if (result.issueCount === 0) {
    lines.push('');
    lines.push('> Schema coherent — les types correspondent aux modeles Prisma.');
  }

  return lines.join('\n');
}
