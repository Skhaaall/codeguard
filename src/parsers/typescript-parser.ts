/**
 * Parser TypeScript/JavaScript profond via ts-morph.
 * Extrait imports, exports, fonctions, classes, types, routes API.
 * Supporte : .ts, .tsx, .js, .jsx, .mjs, .cjs
 */

import { Project, SourceFile, Node } from 'ts-morph';
import type {
  BaseParser,
  FileNode,
  ImportInfo,
  ExportInfo,
  FunctionInfo,
  ClassInfo,
  TypeInfo,
  RouteInfo,
  ParameterInfo,
  PropertyInfo,
  Language,
} from './base-parser.js';
import { detectLanguage } from './detector.js';
import { logger } from '../utils/logger.js';
import { extractApiCalls } from './extractors/api-calls.js';
import { extractAuthGuards } from './extractors/auth-guards.js';

export class TypeScriptParser implements BaseParser {
  readonly supportedLanguages: Language[] = ['typescript', 'javascript'];
  private project: Project;

  constructor(tsConfigPath?: string) {
    this.project = new Project({
      tsConfigFilePath: tsConfigPath,
      skipAddingFilesFromTsConfig: true,
      compilerOptions: tsConfigPath
        ? undefined
        : {
            allowJs: true,
            jsx: 4, // JsxEmit.ReactJSX
            strict: true,
            esModuleInterop: true,
          },
    });
  }

  canParse(filePath: string): boolean {
    const lang = detectLanguage(filePath);
    return lang === 'typescript' || lang === 'javascript';
  }

  async parseFile(filePath: string): Promise<FileNode> {
    const sourceFile = this.project.addSourceFileAtPath(filePath);

    try {
      const apiCalls = extractApiCalls(sourceFile);
      const node: FileNode = {
        filePath,
        language: detectLanguage(filePath),
        imports: this.extractImports(sourceFile),
        exports: this.extractExports(sourceFile),
        functions: this.extractFunctions(sourceFile),
        classes: this.extractClasses(sourceFile),
        types: this.extractTypes(sourceFile),
        routes: this.extractRoutes(sourceFile, filePath),
        ...(apiCalls.length > 0 ? { apiCalls } : {}),
        parsedAt: Date.now(),
      };

      return node;
    } catch (error) {
      logger.error('Echec parsing fichier', {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.project.removeSourceFile(sourceFile);
    }
  }

  async parseFiles(filePaths: string[]): Promise<FileNode[]> {
    const results: FileNode[] = [];
    // Parsing sequentiel pour eviter les problemes de memoire sur gros projets
    for (const filePath of filePaths) {
      if (this.canParse(filePath)) {
        try {
          const node = await this.parseFile(filePath);
          results.push(node);
        } catch {
          logger.warn('Fichier ignore (parsing echoue)', { filePath });
        }
      }
    }
    return results;
  }

  // --- Extraction des imports ---

  private extractImports(sourceFile: SourceFile): ImportInfo[] {
    const imports: ImportInfo[] = [];

    for (const decl of sourceFile.getImportDeclarations()) {
      const source = decl.getModuleSpecifierValue();
      const isTypeOnly = decl.isTypeOnly();

      // Default import
      const defaultImport = decl.getDefaultImport();
      if (defaultImport) {
        imports.push({ name: defaultImport.getText(), source, isTypeOnly });
      }

      // Named imports
      for (const named of decl.getNamedImports()) {
        imports.push({
          name: named.getName(),
          source,
          isTypeOnly: isTypeOnly || named.isTypeOnly(),
        });
      }

      // Namespace import (import * as X)
      const namespaceImport = decl.getNamespaceImport();
      if (namespaceImport) {
        imports.push({ name: `* as ${namespaceImport.getText()}`, source, isTypeOnly });
      }
    }

    return imports;
  }

  // --- Extraction des exports ---

  private extractExports(sourceFile: SourceFile): ExportInfo[] {
    const exports: ExportInfo[] = [];

    // Fonctions exportees
    for (const fn of sourceFile.getFunctions()) {
      if (fn.isExported()) {
        exports.push({
          name: fn.getName() ?? 'default',
          kind: fn.isDefaultExport() ? 'default' : 'function',
          isTypeOnly: false,
        });
      }
    }

    // Classes exportees
    for (const cls of sourceFile.getClasses()) {
      if (cls.isExported()) {
        exports.push({
          name: cls.getName() ?? 'default',
          kind: cls.isDefaultExport() ? 'default' : 'class',
          isTypeOnly: false,
        });
      }
    }

    // Interfaces exportees
    for (const iface of sourceFile.getInterfaces()) {
      if (iface.isExported()) {
        exports.push({ name: iface.getName(), kind: 'interface', isTypeOnly: true });
      }
    }

    // Type aliases exportes
    for (const typeAlias of sourceFile.getTypeAliases()) {
      if (typeAlias.isExported()) {
        exports.push({ name: typeAlias.getName(), kind: 'type', isTypeOnly: true });
      }
    }

    // Enums exportes
    for (const enumDecl of sourceFile.getEnums()) {
      if (enumDecl.isExported()) {
        exports.push({ name: enumDecl.getName(), kind: 'enum', isTypeOnly: false });
      }
    }

    // Variables exportees (export const X = ...)
    for (const varStatement of sourceFile.getVariableStatements()) {
      if (varStatement.isExported()) {
        for (const decl of varStatement.getDeclarations()) {
          exports.push({ name: decl.getName(), kind: 'variable', isTypeOnly: false });
        }
      }
    }

    // Re-exports (export { X } from './module')
    for (const exportDecl of sourceFile.getExportDeclarations()) {
      for (const named of exportDecl.getNamedExports()) {
        exports.push({
          name: named.getName(),
          kind: 're-export',
          isTypeOnly: exportDecl.isTypeOnly(),
        });
      }
    }

    return exports;
  }

  // --- Extraction des fonctions ---

  private extractFunctions(sourceFile: SourceFile): FunctionInfo[] {
    const functions: FunctionInfo[] = [];

    for (const fn of sourceFile.getFunctions()) {
      functions.push({
        name: fn.getName() ?? '(anonymous)',
        isExported: fn.isExported(),
        isAsync: fn.isAsync(),
        parameters: this.extractParameters(fn.getParameters()),
        returnType: fn.getReturnTypeNode()?.getText() ?? null,
        line: fn.getStartLineNumber(),
      });
    }

    // Arrow functions exportees (export const handler = async (req) => { ... })
    for (const varStatement of sourceFile.getVariableStatements()) {
      for (const decl of varStatement.getDeclarations()) {
        const initializer = decl.getInitializer();
        if (initializer && Node.isArrowFunction(initializer)) {
          functions.push({
            name: decl.getName(),
            isExported: varStatement.isExported(),
            isAsync: initializer.isAsync(),
            parameters: this.extractParameters(initializer.getParameters()),
            returnType: initializer.getReturnTypeNode()?.getText() ?? null,
            line: decl.getStartLineNumber(),
          });
        }
      }
    }

    return functions;
  }

  private extractParameters(params: import('ts-morph').ParameterDeclaration[]): ParameterInfo[] {
    return params.map((p) => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? null,
      isOptional: p.isOptional(),
    }));
  }

  // --- Extraction des classes ---

  private extractClasses(sourceFile: SourceFile): ClassInfo[] {
    return sourceFile.getClasses().map((cls) => ({
      name: cls.getName() ?? '(anonymous)',
      isExported: cls.isExported(),
      decorators: cls.getDecorators().map((d) => d.getName()),
      methods: cls.getMethods().map((m) => ({
        name: m.getName(),
        isExported: true,
        isAsync: m.isAsync(),
        parameters: this.extractParameters(m.getParameters()),
        returnType: m.getReturnTypeNode()?.getText() ?? null,
        line: m.getStartLineNumber(),
      })),
      line: cls.getStartLineNumber(),
    }));
  }

  // --- Extraction des types et interfaces ---

  private extractTypes(sourceFile: SourceFile): TypeInfo[] {
    const types: TypeInfo[] = [];

    for (const iface of sourceFile.getInterfaces()) {
      types.push({
        name: iface.getName(),
        kind: 'interface',
        isExported: iface.isExported(),
        properties: iface.getProperties().map((p) => ({
          name: p.getName(),
          type: p.getTypeNode()?.getText() ?? 'unknown',
          isOptional: p.hasQuestionToken(),
        })),
        line: iface.getStartLineNumber(),
      });
    }

    for (const typeAlias of sourceFile.getTypeAliases()) {
      types.push({
        name: typeAlias.getName(),
        kind: 'type',
        isExported: typeAlias.isExported(),
        properties: this.extractTypeProperties(typeAlias),
        line: typeAlias.getStartLineNumber(),
      });
    }

    for (const enumDecl of sourceFile.getEnums()) {
      types.push({
        name: enumDecl.getName(),
        kind: 'enum',
        isExported: enumDecl.isExported(),
        properties: enumDecl.getMembers().map((m) => ({
          name: m.getName(),
          type: m.getValue()?.toString() ?? 'auto',
          isOptional: false,
        })),
        line: enumDecl.getStartLineNumber(),
      });
    }

    return types;
  }

  private extractTypeProperties(typeAlias: import('ts-morph').TypeAliasDeclaration): PropertyInfo[] {
    // Extraire les proprietes si c'est un type objet (type X = { a: string; b: number })
    const typeNode = typeAlias.getTypeNode();
    if (!typeNode || !Node.isTypeLiteral(typeNode)) return [];

    return typeNode.getProperties().map((p) => ({
      name: p.getName(),
      type: p.getTypeNode()?.getText() ?? 'unknown',
      isOptional: p.hasQuestionToken(),
    }));
  }

  // --- Detection des routes API ---

  private extractRoutes(sourceFile: SourceFile, filePath: string): RouteInfo[] {
    const routes: RouteInfo[] = [];

    // Next.js App Router (app/**/route.ts)
    if (this.isNextApiRoute(filePath)) {
      routes.push(...this.extractNextRoutes(sourceFile, filePath));
    }

    // NestJS Controllers (@Controller + @Get/@Post/...)
    routes.push(...this.extractNestRoutes(sourceFile, filePath));

    return routes;
  }

  private isNextApiRoute(filePath: string): boolean {
    const normalized = filePath.replace(/\\/g, '/');
    return /\/app\/.*\/route\.(ts|js)$/.test(normalized);
  }

  private extractNextRoutes(sourceFile: SourceFile, filePath: string): RouteInfo[] {
    const routes: RouteInfo[] = [];
    const httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

    // Next.js exporte des fonctions nommees GET, POST, PUT, PATCH, DELETE
    for (const fn of sourceFile.getFunctions()) {
      const name = fn.getName();
      if (name && httpMethods.includes(name as (typeof httpMethods)[number]) && fn.isExported()) {
        routes.push({
          method: name as RouteInfo['method'],
          path: this.nextPathFromFile(filePath),
          handler: name,
          filePath,
          line: fn.getStartLineNumber(),
        });
      }
    }

    // Aussi les arrow functions exportees (export const GET = ...)
    for (const varStatement of sourceFile.getVariableStatements()) {
      if (varStatement.isExported()) {
        for (const decl of varStatement.getDeclarations()) {
          const name = decl.getName();
          if (httpMethods.includes(name as (typeof httpMethods)[number])) {
            routes.push({
              method: name as RouteInfo['method'],
              path: this.nextPathFromFile(filePath),
              handler: name,
              filePath,
              line: decl.getStartLineNumber(),
            });
          }
        }
      }
    }

    return routes;
  }

  private nextPathFromFile(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const match = normalized.match(/\/app(\/.*?)\/route\.(ts|js)$/);
    if (!match) return '/unknown';
    // Convertir les [param] en :param
    return match[1].replace(/\[([^\]]+)\]/g, ':$1');
  }

  private extractNestRoutes(sourceFile: SourceFile, filePath: string): RouteInfo[] {
    const routes: RouteInfo[] = [];
    const methodDecorators = new Map<string, RouteInfo['method']>([
      ['Get', 'GET'],
      ['Post', 'POST'],
      ['Put', 'PUT'],
      ['Patch', 'PATCH'],
      ['Delete', 'DELETE'],
    ]);

    for (const cls of sourceFile.getClasses()) {
      // Trouver @Controller('path')
      const controllerDeco = cls.getDecorators().find((d) => d.getName() === 'Controller');
      if (!controllerDeco) continue;

      const basePath = this.getDecoratorStringArg(controllerDeco) ?? '';

      for (const method of cls.getMethods()) {
        for (const deco of method.getDecorators()) {
          const httpMethod = methodDecorators.get(deco.getName());
          if (!httpMethod) continue;

          const subPath = this.getDecoratorStringArg(deco) ?? '';
          const fullPath = `/${basePath}/${subPath}`.replace(/\/+/g, '/').replace(/\/$/, '') || '/';

          const authGuards = extractAuthGuards(method, cls);
          routes.push({
            method: httpMethod,
            path: fullPath,
            handler: `${cls.getName()}.${method.getName()}`,
            filePath,
            line: method.getStartLineNumber(),
            ...(authGuards.length > 0 ? { authGuards } : {}),
          });
        }
      }
    }

    return routes;
  }

  private getDecoratorStringArg(decorator: import('ts-morph').Decorator): string | null {
    const args = decorator.getArguments();
    if (args.length === 0) return null;
    const firstArg = args[0];
    if (Node.isStringLiteral(firstArg)) {
      return firstArg.getLiteralValue();
    }
    return null;
  }
}
