/**
 * Contrat commun pour tous les parsers.
 * Chaque parser (TypeScript, Python, Go...) produit le meme format de carte.
 * Le reste du systeme travaille uniquement sur FileNode — il ne connait pas le langage.
 */

// --- Types de la carte ---

export interface FileNode {
  /** Chemin absolu du fichier */
  filePath: string;
  /** Langage detecte */
  language: Language;
  /** Imports de ce fichier */
  imports: ImportInfo[];
  /** Exports de ce fichier */
  exports: ExportInfo[];
  /** Fonctions declarees */
  functions: FunctionInfo[];
  /** Classes declarees */
  classes: ClassInfo[];
  /** Types et interfaces declares */
  types: TypeInfo[];
  /** Routes API detectees (Next.js, NestJS, FastAPI...) */
  routes: RouteInfo[];
  /** Appels API detectes dans le code (fetch, axios, etc.) */
  apiCalls?: ApiCallInfo[];
  /** Timestamp du dernier parsing */
  parsedAt: number;
}

export interface ImportInfo {
  /** Ce qui est importe (nom ou default) */
  name: string;
  /** Chemin source (ex: './utils/auth' ou 'react') */
  source: string;
  /** Import de type uniquement (import type { X }) */
  isTypeOnly: boolean;
}

export interface ExportInfo {
  /** Nom de l'export */
  name: string;
  /** Type d'export */
  kind: 'function' | 'class' | 'type' | 'interface' | 'variable' | 'enum' | 'default' | 're-export';
  /** Export de type uniquement */
  isTypeOnly: boolean;
}

export interface FunctionInfo {
  name: string;
  isExported: boolean;
  isAsync: boolean;
  parameters: ParameterInfo[];
  returnType: string | null;
  /** Ligne de debut dans le fichier */
  line: number;
}

export interface ParameterInfo {
  name: string;
  type: string | null;
  isOptional: boolean;
}

export interface ClassInfo {
  name: string;
  isExported: boolean;
  /** Decorateurs (ex: @Controller, @Injectable) */
  decorators: string[];
  methods: FunctionInfo[];
  line: number;
}

export interface TypeInfo {
  name: string;
  kind: 'type' | 'interface' | 'enum';
  isExported: boolean;
  /** Proprietes (pour interfaces et types objets) */
  properties: PropertyInfo[];
  line: number;
}

export interface PropertyInfo {
  name: string;
  type: string;
  isOptional: boolean;
}

export interface RouteInfo {
  /** Methode HTTP */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'ALL';
  /** Chemin de la route (ex: /api/users/:id) */
  path: string;
  /** Nom du handler */
  handler: string;
  /** Fichier ou la route est definie */
  filePath: string;
  line: number;
  /** Decorateurs d'auth detectes (ex: @UseGuards, middleware auth) */
  authGuards?: string[];
}

export interface ApiCallInfo {
  /** Methode HTTP (GET, POST, etc.) */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'UNKNOWN';
  /** URL ou pattern d'URL appelee (ex: /api/users, /api/orders/:id) */
  url: string;
  /** Ligne dans le fichier source */
  line: number;
}

export type Language =
  | 'typescript'
  | 'javascript'
  | 'python'
  | 'go'
  | 'rust'
  | 'java'
  | 'prisma'
  | 'sql'
  | 'unknown';

// --- Interface du parser ---

export interface BaseParser {
  /** Langages supportes par ce parser */
  readonly supportedLanguages: Language[];

  /** Parse un fichier et retourne son FileNode */
  parseFile(filePath: string): Promise<FileNode>;

  /** Parse plusieurs fichiers en parallele */
  parseFiles(filePaths: string[]): Promise<FileNode[]>;

  /** Verifie si ce parser peut traiter un fichier donne */
  canParse(filePath: string): boolean;
}
