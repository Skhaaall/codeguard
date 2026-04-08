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
    description: "Etat de l'index : date, nombre de fichiers, fraicheur.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dependencies',
    description: "Graphe de dependances d'un fichier — qui il importe et qui l'importe.",
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
      "Post-change coherence check — re-indexe le fichier modifie, compare avec l'ancien etat, detecte les exports supprimes, imports casses et types incoherents. A appeler APRES chaque modification.",
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: "Chemin du fichier qui vient d'etre modifie (absolu ou relatif)",
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
    name: 'whatsnew',
    description:
      'Resume des changements dans le projet depuis le dernier reindex. A lancer en debut de session pour comprendre le contexte. Montre les fichiers modifies, les signatures changees, les nouvelles routes et les fichiers les plus actifs.',
    inputSchema: {
      type: 'object',
      properties: {
        since: {
          type: 'string',
          description: 'Date ou duree (ex: "3 days ago", "2026-04-05"). Defaut: date du dernier reindex.',
        },
      },
    },
  },
  {
    name: 'silent_catch',
    description:
      "Detecte les blocs catch qui avalent les erreurs silencieusement — catch vides, return sans log, .catch(() => default). A lancer lors d'un audit ou apres /review.",
    inputSchema: {
      type: 'object',
      properties: {
        severity: {
          type: 'string',
          enum: ['all', 'critical', 'high'],
          description:
            'Filtre par severite minimum. "critical" = catch vides uniquement. "high" = catch + return sans log. "all" = tout (defaut).',
        },
      },
    },
  },
  {
    name: 'changelog',
    description:
      "Diff lisible entre l'ancien et le nouvel index. Montre les fichiers, exports, routes et types ajoutes/supprimes/modifies depuis le dernier reindex.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'external_map',
    description:
      "Cartographie les connexions externes du projet : packages npm (utilises, inutilises, critiques), variables d'environnement (process.env), appels API sortants (fetch/axios). A lancer pour comprendre les dependances externes et detecter les risques.",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];
