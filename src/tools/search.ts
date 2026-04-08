/**
 * Outil MCP : search
 * "Qui utilise cette fonction / ce type / ce hook ?"
 */

import type { ProjectIndex } from '../storage/index-store.js';

export interface SearchResult {
  query: string;
  matches: SearchMatch[];
  totalMatches: number;
}

export interface SearchMatch {
  filePath: string;
  context: string; // "imports X", "exports X", "function X", "class X", "type X"
  line: number | null;
}

export function searchIndex(index: ProjectIndex, query: string): SearchResult {
  const matches: SearchMatch[] = [];
  const queryLower = query.toLowerCase();

  for (const [filePath, node] of Object.entries(index.files)) {
    // Chercher dans les imports
    for (const imp of node.imports) {
      if (imp.name.toLowerCase().includes(queryLower)) {
        matches.push({
          filePath,
          context: `imports "${imp.name}" from "${imp.source}"`,
          line: null,
        });
      }
    }

    // Chercher dans les exports
    for (const exp of node.exports) {
      if (exp.name.toLowerCase().includes(queryLower)) {
        matches.push({
          filePath,
          context: `exports ${exp.kind} "${exp.name}"`,
          line: null,
        });
      }
    }

    // Chercher dans les fonctions
    for (const fn of node.functions) {
      if (fn.name.toLowerCase().includes(queryLower)) {
        matches.push({
          filePath,
          context: `function ${fn.name}(${fn.parameters.map((p) => p.name).join(', ')})`,
          line: fn.line,
        });
      }
    }

    // Chercher dans les classes
    for (const cls of node.classes) {
      if (cls.name.toLowerCase().includes(queryLower)) {
        matches.push({
          filePath,
          context: `class ${cls.name}${cls.decorators.length ? ` @${cls.decorators.join(', @')}` : ''}`,
          line: cls.line,
        });
      }
      // Aussi dans les methodes
      for (const method of cls.methods) {
        if (method.name.toLowerCase().includes(queryLower)) {
          matches.push({
            filePath,
            context: `${cls.name}.${method.name}()`,
            line: method.line,
          });
        }
      }
    }

    // Chercher dans les types/interfaces
    for (const type of node.types) {
      if (type.name.toLowerCase().includes(queryLower)) {
        matches.push({
          filePath,
          context: `${type.kind} ${type.name}`,
          line: type.line,
        });
      }
    }

    // Chercher dans les routes
    for (const route of node.routes) {
      if (route.path.toLowerCase().includes(queryLower) || route.handler.toLowerCase().includes(queryLower)) {
        matches.push({
          filePath,
          context: `${route.method} ${route.path} → ${route.handler}`,
          line: route.line,
        });
      }
    }
  }

  return {
    query,
    matches,
    totalMatches: matches.length,
  };
}

export function formatSearchResult(result: SearchResult): string {
  if (result.totalMatches === 0) {
    return `Aucun resultat pour "${result.query}"`;
  }

  const lines: string[] = [];
  lines.push(`## Recherche : "${result.query}" — ${result.totalMatches} resultats`);

  for (const match of result.matches) {
    const lineRef = match.line ? `:${match.line}` : '';
    lines.push(`- **${match.filePath}${lineRef}** — ${match.context}`);
  }

  return lines.join('\n');
}
