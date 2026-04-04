/**
 * Catalogue des outils MCP exposes par CodeGuard.
 * Separe de index.ts pour garder le serveur lisible.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'impact',
    description:
      'Analyse d\'impact — "je modifie ce fichier, qu\'est-ce qui casse ?" Retourne les fichiers impactes, les routes API affectees, et un score de risque.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Chemin du fichier a analyser (absolu ou relatif au projet)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'search',
    description:
      'Recherche dans la carte — "qui utilise cette fonction/type/hook ?" Cherche dans les imports, exports, fonctions, classes, types et routes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Nom de la fonction, du type, du hook ou de la route a chercher',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'reindex',
    description:
      'Re-indexe le projet. Par defaut complet, avec incremental=true ne re-parse que les fichiers modifies.',
    inputSchema: {
      type: 'object',
      properties: {
        incremental: {
          type: 'boolean',
          description: 'Si true, ne re-parse que les fichiers modifies depuis le dernier indexage (plus rapide)',
        },
      },
    },
  },
  {
    name: 'status',
    description: 'Etat de l\'index : date, nombre de fichiers, fraicheur.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dependencies',
    description: 'Graphe de dependances d\'un fichier — qui il importe et qui l\'importe.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Chemin du fichier',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'guard',
    description:
      'Pre-change safety check — "est-ce safe de modifier ce fichier ?" Retourne les risques, les fichiers a verifier apres, et une recommandation go/no-go. A appeler AVANT toute modification.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Chemin du fichier qui va etre modifie (absolu ou relatif)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'check',
    description:
      'Post-change coherence check — re-indexe le fichier modifie, compare avec l\'ancien etat, detecte les exports supprimes, imports casses et types incoherents. A appeler APRES chaque modification.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Chemin du fichier qui vient d\'etre modifie (absolu ou relatif)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'health',
    description:
      'Score de sante global du projet — imports casses, fichiers orphelins, dependances circulaires, fichiers a haut risque. Note de A (excellent) a F (critique).',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'regression_map',
    description:
      'Regression map — "je modifie ce fichier, quelles pages/routes retester ?" Liste les pages, routes API et entry points impactes en cascade.',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Chemin du fichier modifie (absolu ou relatif)',
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'graph',
    description:
      'Genere un diagramme Mermaid du graphe de dependances. Sans filePath = graphe complet, avec filePath = graphe centre sur ce fichier (2 niveaux).',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Fichier sur lequel centrer le graphe (optionnel — sans = graphe complet)',
        },
      },
    },
  },
  {
    name: 'schema_check',
    description:
      'Coherence Prisma ↔ DTOs backend ↔ types frontend. Detecte les champs manquants et les enums desynchronises. A lancer apres modification du schema Prisma ou des DTOs.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'route_guard',
    description:
      'Coherence routes frontend ↔ backend. Detecte les routes backend non appelees, les appels frontend vers des routes inexistantes, et les routes sensibles sans auth.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'changelog',
    description:
      'Diff lisible entre l\'ancien et le nouvel index. Montre les fichiers, exports, routes et types ajoutes/supprimes/modifies depuis le dernier reindex.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
