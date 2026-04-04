# CodeGuard — Instructions projet

## Description
Serveur MCP maison qui genere une carte complete du projet (comme un source map) et l'utilise pour bloquer les modifications dangereuses, alerter sur les incoherences, et guider Claude Code.

## Stack
- TypeScript strict (ES2022, Node16)
- **ts-morph** — parsing profond TypeScript (types resolus, generics, inference)
- **@modelcontextprotocol/sdk** — protocole MCP standard (stdio)
- Carte stockee en JSON dans `.codeguard/`
- Zero dependance lourde (pas de Neo4j, pas de Docker)

## Architecture

```
src/
  index.ts                    # Entry point MCP server (stdio)
  parsers/
    base-parser.ts            # Types de la carte (FileNode) + interface BaseParser
    detector.ts               # Auto-detection du langage par extension
    typescript-parser.ts      # ts-morph — analyse profonde TS/TSX/JS/JSX
    language-configs/          # (futur) configs tree-sitter par langage
    prisma-parser.ts           # (futur) parser custom schema.prisma
  graph/
    dependency-graph.ts       # Graphe de dependances bidirectionnel
    impact-resolver.ts        # Impact analysis transitif (BFS) + score de risque
  tools/
    impact.ts                 # Outil MCP : impact analysis
    search.ts                 # Outil MCP : recherche dans la carte
  storage/
    index-store.ts            # Lecture/ecriture de la carte JSON
  utils/
    scanner.ts                # Scanner de fichiers du projet
    logger.ts                 # Logger fichier (JAMAIS stderr)
```

## Regles critiques

### MCP — JAMAIS stderr
- Le protocole MCP utilise stderr pour les erreurs de protocole
- Si CodeGuard ecrit sur stderr, ca casse la connexion MCP
- Toujours logger dans un fichier (`.codeguard/codeguard.log`)

### MCP Windows — JAMAIS cmd /c
- Sur Windows, `cmd /c` intercepte le JSON stdin → crash MCP
- Toujours lancer avec `node dist/index.js` directement

### Qualite
- TypeScript `strict: true` — non negociable
- Pas de `any` — utiliser `unknown` + type guard
- Chaque parser produit le meme format `FileNode` — le reste du systeme ne connait pas le langage

## Commandes
```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type-check sans build
npm run dev          # Watch mode
npm start            # Lance le serveur MCP
```

## Roadmap
Voir `todo.md` pour le plan complet (P0 → P3).

**Etat actuel** : P0 en cours — scaffold + parser TS + impact analysis + serveur MCP fonctionnels. A tester sur un vrai projet.
