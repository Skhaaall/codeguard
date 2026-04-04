# CodeGuard — Instructions projet

## Vision

Filet de securite total pour chaque projet. Comme un source map qui cartographie tout le code — mais en outil actif qui EMPECHE les casses avant qu'elles arrivent.

**Probleme resolu** : a chaque feature, des fichiers cassent en cascade sans qu'on s'en rende compte. On decouvre les casses longtemps apres. CodeGuard detecte ca AVANT.

**3 fonctions cles** :
1. **Bloquer** les modifications dangereuses AVANT qu'elles cassent
2. **Alerter** sur les incoherences (types, schema, routes, imports)
3. **Guider** Claude Code avec le contexte exact du projet

## Stack

- TypeScript strict (ES2022, Node16)
- **ts-morph** — parsing profond TypeScript (types resolus, generics, inference)
- **@modelcontextprotocol/sdk** — protocole MCP standard (stdio)
- Carte stockee en JSON dans `.codeguard/`
- Zero dependance lourde (pas de Neo4j, pas de Docker)

## Architecture

```
src/
  index.ts                     # Entry point MCP server (stdio) — 11 outils
  cli.ts                       # CLI one-shot (hooks + commandes manuelles)
  setup.ts                     # Commande setup/unsetup hooks Claude Code
  parsers/
    base-parser.ts             # Types de la carte (FileNode, RouteInfo...) + interface BaseParser
    detector.ts                # Auto-detection du langage par extension
    typescript-parser.ts       # ts-morph — analyse profonde TS/TSX/JS/JSX
    prisma-parser.ts           # Parser custom schema.prisma (modeles, champs, relations, enums)
  graph/
    dependency-graph.ts        # Graphe de dependances bidirectionnel (cache)
    impact-resolver.ts         # Impact analysis transitif (BFS) + score de risque
  tools/
    impact.ts                  # Analyse d'impact (fichier → tout ce qui casse)
    guard.ts                   # Pre-change safety check (risques avant modif)
    check.ts                   # Post-change coherence (imports casses, exports supprimes)
    health.ts                  # Score de sante A-F (scoring adaptatif)
    search.ts                  # Recherche dans la carte (fonctions, types, hooks)
    schema.ts                  # Coherence Prisma ↔ DTOs ↔ types frontend
    regression.ts              # Pages/routes a retester apres modification
    graph.ts                   # Diagramme Mermaid (complet ou focus)
  storage/
    index-store.ts             # Lecture/ecriture de la carte JSON (.codeguard/index.json)
  utils/
    scanner.ts                 # Scanner de fichiers (respecte .gitignore)
    logger.ts                  # Logger fichier (JAMAIS stderr)
    import-resolver.ts         # Resolution d'imports (path aliases, barrel exports, ESM)
    path.ts                    # Utilitaires chemins (normalisation, securite)
```

## Outils MCP exposes (11)

| Outil | Description | Quand l'utiliser |
|-------|-------------|------------------|
| `impact` | Fichier → liste de tout ce qui est touche en cascade | AVANT de modifier |
| `guard` | Risques, fichiers a verifier, recommandation go/no-go | AVANT de modifier |
| `check` | Re-indexe, compare avec l'ancien etat, detecte les casses | APRES modification |
| `health` | Score A-F, imports casses, cycles, orphelins, haut risque | A la demande |
| `schema_check` | Coherence Prisma ↔ DTOs backend ↔ types frontend | Apres modif schema |
| `search` | Qui utilise cette fonction/type/hook/composant ? | A la demande |
| `dependencies` | Graphe d'un fichier (importe / importe par) | A la demande |
| `reindex` | Re-indexer le projet (complet ou incremental) | Debut de session |
| `status` | Date, nombre de fichiers, fraicheur de l'index | A la demande |
| `regression_map` | Pages et routes a retester apres modification | Avant deploy |
| `graph` | Diagramme Mermaid (complet ou focus sur un fichier) | A la demande |

## Hooks automatiques (integration Claude Code)

```
PreToolUse(Edit|Write) → codeguard guard {fichier}
  → Si risque critique : afficher l'alerte AVANT de modifier

PostToolUse(Edit|Write) → codeguard check {fichier}
  → Si incoherence detectee : alerter immediatement
```

Installes via `codeguard-setup setup`. Config dans `.claude/settings.local.json`.

## CLI

```bash
codeguard-cli init [project-root]              # Indexer le projet
codeguard-cli status [project-root]            # Etat de l'index
codeguard-cli health [project-root]            # Score de sante (A-F)
codeguard-cli impact <fichier> [project-root]  # Analyse d'impact
codeguard-cli regression <fichier> [project-root]  # Pages a retester
codeguard-cli graph [fichier] [project-root]   # Diagramme Mermaid
codeguard-cli schema [project-root]            # Coherence Prisma ↔ TS
codeguard-cli guard <fichier>                  # Pre-change check (mode hook)
codeguard-cli check <fichier>                  # Post-change check (mode hook)
```

## Langages supportes

| Langage | Parser | Profondeur | Frameworks detectes |
|---------|--------|------------|---------------------|
| **TypeScript/TSX** | ts-morph (deep) | Complet — types, generics, props, inference | Next.js, NestJS, Express |
| **JavaScript/JSX** | ts-morph (compatibilite) | Imports, exports, fonctions, classes | React, Express, Fastify |
| **Prisma** | Parser custom | Modeles, champs, relations, enums | Prisma |

Path aliases TypeScript (`@/` → `src/`) et barrel exports (`from './dir'` → `dir/index.ts`) geres automatiquement via `tsconfig.json`.

### Multi-langage (prevu v0.2 — tree-sitter)

| Langage | Parser prevu | Profondeur |
|---------|-------------|------------|
| Python | tree-sitter-python | Imports, classes, fonctions, decorateurs (FastAPI, Django) |
| Go | tree-sitter-go | Imports, structs, interfaces, fonctions (Gin, Echo) |
| Rust | tree-sitter-rust | Imports (use), structs, traits, impls (Actix, Axum) |
| Java | tree-sitter-java | Imports, classes, annotations (Spring Boot) |

**Principe** : chaque parser produit le meme format `FileNode`. Le reste du systeme (graph, tools) ne connait pas le langage.

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
- Un parser qui crash sur un fichier ne doit pas planter le serveur — catch + skip

### Performance
- Parsing < 30s pour un projet de 500 fichiers
- Index cache en JSON — pas de re-parse a chaque demarrage
- Requetes (impact, search) < 100ms sur l'index en memoire
- Reindex incremental : 0ms si rien n'a change

### Securite
- CodeGuard lit le code source mais ne le modifie JAMAIS
- `.codeguard/` doit etre dans le `.gitignore` du projet cible
- Ne jamais indexer le contenu des fichiers `.env` ou des secrets
- Path traversal bloque (chemins doivent rester dans le projet)
- Validation des inputs MCP a runtime
- Limites DoS (stdin 1 Mo, index 50 Mo)
- Liens symboliques ignores

## Commandes build

```bash
npm run build        # Compile TypeScript
npm run typecheck    # Type-check sans build
npm run dev          # Watch mode
npm start            # Lance le serveur MCP
```

## Criteres de succes

- `claude mcp list` affiche codeguard avec tous les outils
- Impact analysis retourne les bons fichiers (verification manuelle)
- Guard empeche une modification dangereuse sans faux positifs excessifs
- Check detecte un import casse apres suppression d'un export
- Schema check detecte une incoherence Prisma ↔ frontend
- Pas de crash, pas de timeout, pas de "failed" — JAMAIS
- Zero ecriture sur stderr (lecon GitNexus)
- Utilisable sur n'importe quel projet TS sans config speciale
- Hooks PreToolUse/PostToolUse fonctionnent sans ralentir Claude Code
