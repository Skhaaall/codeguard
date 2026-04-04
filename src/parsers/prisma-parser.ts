/**
 * Parser custom pour schema.prisma.
 * Extrait les modeles, champs, relations et enums.
 * Produit un FileNode compatible avec le reste du systeme.
 */

import { readFileSync } from 'node:fs';
import type { FileNode, TypeInfo, PropertyInfo } from './base-parser.js';
import { logger } from '../utils/logger.js';

export interface PrismaModel {
  name: string;
  fields: PrismaField[];
  /** Attributs de modele (@@map, @@index, etc.) */
  attributes: string[];
  line: number;
}

export interface PrismaField {
  name: string;
  type: string;
  /** Type Prisma brut (ex: "String", "Int", "User", "Role") */
  prismaType: string;
  isOptional: boolean;
  isList: boolean;
  isRelation: boolean;
  /** Modele cible si c'est une relation */
  relationTarget?: string;
  /** Attributs du champ (@id, @unique, @default, etc.) */
  attributes: string[];
  line: number;
}

export interface PrismaEnum {
  name: string;
  values: string[];
  line: number;
}

export interface PrismaSchema {
  models: PrismaModel[];
  enums: PrismaEnum[];
  filePath: string;
}

/** Parse un fichier schema.prisma */
export function parsePrismaSchema(filePath: string): PrismaSchema {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const models: PrismaModel[] = [];
  const enums: PrismaEnum[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    // Model
    const modelMatch = line.match(/^model\s+(\w+)\s*\{/);
    if (modelMatch) {
      const { model, endLine } = parseModel(modelMatch[1], lines, i);
      models.push(model);
      i = endLine + 1;
      continue;
    }

    // Enum
    const enumMatch = line.match(/^enum\s+(\w+)\s*\{/);
    if (enumMatch) {
      const { prismaEnum, endLine } = parseEnum(enumMatch[1], lines, i);
      enums.push(prismaEnum);
      i = endLine + 1;
      continue;
    }

    i++;
  }

  return { models, enums, filePath };
}

function parseModel(name: string, lines: string[], startLine: number): { model: PrismaModel; endLine: number } {
  const fields: PrismaField[] = [];
  const attributes: string[] = [];
  let i = startLine + 1;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === '}') break;

    // Attribut de modele (@@map, @@index, etc.)
    if (line.startsWith('@@')) {
      attributes.push(line);
      i++;
      continue;
    }

    // Ligne vide ou commentaire
    if (!line || line.startsWith('//')) {
      i++;
      continue;
    }

    // Champ
    const field = parseField(line, i + 1);
    if (field) fields.push(field);

    i++;
  }

  return {
    model: { name, fields, attributes, line: startLine + 1 },
    endLine: i,
  };
}

function parseField(line: string, lineNumber: number): PrismaField | null {
  // Format : nomChamp Type? @attributs...
  // Exemples :
  //   id        String   @id @default(cuid())
  //   email     String   @unique
  //   role      Role     @default(TECHNICIEN)
  //   deletedAt DateTime?
  //   tournees  Tournee[]
  //   user      User     @relation(fields: [userId], references: [id])

  const match = line.match(/^(\w+)\s+(\w+)(\[\])?\s*(\?)?\s*(.*)?$/);
  if (!match) return null;

  const [, name, rawType, listMarker, optionalMarker, rest] = match;

  const isList = listMarker === '[]';
  const isOptional = optionalMarker === '?' || (rest ?? '').includes('?');
  const attributes = extractAttributes(rest ?? '');

  // Detecter si c'est une relation (type commence par une majuscule et n'est pas un type Prisma primitif)
  const primitiveTypes = new Set([
    'String', 'Int', 'Float', 'Boolean', 'DateTime', 'Json', 'Bytes', 'BigInt', 'Decimal',
  ]);
  const isRelation = !primitiveTypes.has(rawType) && /^[A-Z]/.test(rawType);

  return {
    name,
    type: mapPrismaType(rawType, isList, isOptional),
    prismaType: rawType,
    isOptional,
    isList,
    isRelation,
    relationTarget: isRelation ? rawType : undefined,
    attributes,
    line: lineNumber,
  };
}

function parseEnum(name: string, lines: string[], startLine: number): { prismaEnum: PrismaEnum; endLine: number } {
  const values: string[] = [];
  let i = startLine + 1;

  while (i < lines.length) {
    const line = lines[i].trim();

    if (line === '}') break;
    if (line && !line.startsWith('//')) {
      values.push(line);
    }

    i++;
  }

  return {
    prismaEnum: { name, values, line: startLine + 1 },
    endLine: i,
  };
}

function extractAttributes(rest: string): string[] {
  const attrs: string[] = [];
  const regex = /@\w+(\([^)]*\))?/g;
  let match;
  while ((match = regex.exec(rest)) !== null) {
    attrs.push(match[0]);
  }
  return attrs;
}

/** Convertit un type Prisma en type TypeScript equivalent */
function mapPrismaType(prismaType: string, isList: boolean, isOptional: boolean): string {
  const typeMap: Record<string, string> = {
    String: 'string',
    Int: 'number',
    Float: 'number',
    Boolean: 'boolean',
    DateTime: 'Date',
    Json: 'unknown',
    Bytes: 'Buffer',
    BigInt: 'bigint',
    Decimal: 'number',
  };

  let tsType = typeMap[prismaType] ?? prismaType;
  if (isList) tsType += '[]';
  if (isOptional) tsType += ' | null';

  return tsType;
}

/**
 * Convertit un schema Prisma en FileNode pour l'intégrer dans l'index CodeGuard.
 * Chaque modele devient un TypeInfo, chaque enum aussi.
 */
export function prismaSchemaToFileNode(schema: PrismaSchema): FileNode {
  const types: TypeInfo[] = [];

  // Modeles → TypeInfo avec proprietes
  for (const model of schema.models) {
    types.push({
      name: model.name,
      kind: 'interface',
      isExported: true,
      properties: model.fields
        .filter((f) => !f.isRelation) // Exclure les relations (pas dans les DTOs)
        .map((f) => ({
          name: f.name,
          type: f.type,
          isOptional: f.isOptional,
        })),
      line: model.line,
    });
  }

  // Enums → TypeInfo
  for (const prismaEnum of schema.enums) {
    types.push({
      name: prismaEnum.name,
      kind: 'enum',
      isExported: true,
      properties: prismaEnum.values.map((v) => ({
        name: v,
        type: 'string',
        isOptional: false,
      })),
      line: prismaEnum.line,
    });
  }

  return {
    filePath: schema.filePath,
    language: 'prisma',
    imports: [],
    exports: types.map((t) => ({
      name: t.name,
      kind: t.kind === 'enum' ? 'enum' as const : 'type' as const,
      isTypeOnly: true,
    })),
    functions: [],
    classes: [],
    types,
    routes: [],
    parsedAt: Date.now(),
  };
}
