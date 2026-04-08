# Architecture — CodeGuard

## Vue d'ensemble

CodeGuard est un serveur MCP (Model Context Protocol) qui parse le code source d'un projet TypeScript, construit un graphe de dependances, et expose des outils d'analyse via stdio.

```
Projet cible (.ts/.tsx/.prisma)
        |
   [ Parsers ]  ← ts-morph / regex
        |
   [ Index JSON ]  ← .codeguard/index.json
        |
   [ Graphe ]  ← dependances bidirectionnelles
        |
   [ 15 outils MCP ]  ← guard, check, impact, health, whatsnew, silent_catch...
        |
   Claude Code / CLI
```

## Composants

### Parsers (`src/parsers/`)

- `typescript-parser.ts` — parse TS/TSX/JS/JSX avec ts-morph (imports, exports, fonctions, classes, types, routes)
- `prisma-parser.ts` — parse schema.prisma avec regex (modeles, champs, relations, enums)
- `base-parser.ts` — contrat `FileNode` que tous les parsers produisent
- `detector.ts` — detecte le langage par extension

### Graphe (`src/graph/`)

- `dependency-graph.ts` — graphe bidirectionnel construit depuis l'index
- `impact-resolver.ts` — BFS transitif + scoring de risque

### Outils (`src/tools/`)

15 outils MCP : impact, guard, check, health, search, dependencies, reindex, status, regression_map, graph, schema_check, route_guard, whatsnew, silent_catch, changelog.

### Storage (`src/storage/`)

- `index-store.ts` — lecture/ecriture de l'index JSON + snapshots

### Utils (`src/utils/`)

- `git.ts` — commandes git (log, diff, hotfiles)
- `scanner.ts` — parcours du projet (respecte .gitignore)
- `logger.ts` — log fichier (jamais stderr — protocole MCP)
- `import-resolver.ts` — resolution des imports (path aliases, barrel exports)

### Entry points

- `index.ts` — serveur MCP stdio
- `cli.ts` — CLI one-shot (hooks + commandes manuelles)
- `setup.ts` — installation/desinstallation des hooks Claude Code

## Flux de donnees

1. **Indexation** : Scanner → Parser → FileNode → Index JSON
2. **Guard (pre-modif)** : Index → Graphe → ImpactResolver → Git history → Resultat
3. **Check (post-modif)** : Re-parse fichier → Compare avec ancien index → Detecte les casses
4. **Silent catch** : Scanner → ts-morph direct (pas l'index) → Classification des catches

## Decisions techniques

- **ts-morph** plutot que tree-sitter : parsing TypeScript profond (types resolus, generics) sans config
- **JSON** plutot que base de donnees : zero dependance, portable, rapide pour < 1000 fichiers
- **stdio** plutot que HTTP : protocole MCP standard, pas de port a gerer
- **execSync** pour git : commandes rapides (< 100ms), pas besoin d'async
