# TODO — CodeGuard MCP Server

> Filet de securite total pour chaque projet. Comme le source map d'Anthropic qui cartographie tout le code — mais en outil actif qui EMPECHE les casses avant qu'elles arrivent.
> Objectif : zero surprise. Si un truc casse, tu le sais AVANT, pas 3 jours apres.

## Le probleme

- A chaque feature, des fichiers cassent en cascade sans qu'on s'en rende compte
- On decouvre les casses longtemps apres, quand un utilisateur ou un test tombe dessus
- GitNexus promettait ca mais plante (bugs MCP, connexion instable)
- Les skills inline sont fragiles et ne persistent pas entre les sessions
- Il manque un truc solide, permanent, qui surveille tout en continu

## La solution : CodeGuard

Un MCP server maison qui genere une **carte complete du projet** (comme un source map) et l'utilise pour :
1. **Bloquer** les modifications dangereuses AVANT qu'elles cassent
2. **Alerter** sur les incoherences (types, schema, routes, imports)
3. **Guider** Claude Code avec le contexte exact du projet

## Stack

- TypeScript strict
- **ts-morph** — parsing profond TypeScript (types resolus, generics, inference)
- **tree-sitter** — parsing universel pour tous les autres langages (Python, Go, Rust, Java...)
- @modelcontextprotocol/sdk (protocole MCP standard)
- Carte du projet stockee en JSON dans `.codeguard/`
- Zero dependance lourde (pas de Neo4j, pas de Docker)

## Langages supportes

| Langage | Parser | Profondeur | Frameworks detectes |
|---------|--------|------------|---------------------|
| **TypeScript/TSX** | ts-morph (deep) | Complet — types, generics, props, inference | Next.js, NestJS, Express |
| **JavaScript/JSX** | ts-morph (compatibilite) | Imports, exports, fonctions, classes | React, Express, Fastify |
| **Python** | tree-sitter-python | Imports, classes, fonctions, decorateurs | FastAPI, Django, Flask |
| **Go** | tree-sitter-go | Imports, structs, interfaces, fonctions | Gin, Echo, Chi |
| **Rust** | tree-sitter-rust | Imports (use), structs, traits, impls | Actix, Axum, Rocket |
| **Java** | tree-sitter-java | Imports, classes, annotations, interfaces | Spring Boot |
| **SQL/Prisma** | Parser custom | Modeles, champs, relations, index | Prisma, SQL brut |

### Architecture multi-langage

```
parsers/
  base-parser.ts           # Interface commune — contrat que chaque parser respecte
  typescript-parser.ts     # ts-morph → analyse profonde TS/TSX
  treesitter-parser.ts     # tree-sitter → wrapper generique
  language-configs/
    python.ts              # Config specifique Python (imports, decorateurs FastAPI)
    go.ts                  # Config specifique Go (packages, structs)
    rust.ts                # Config specifique Rust (use, mod, impl)
    java.ts                # Config specifique Java (annotations Spring)
  prisma-parser.ts         # Parser custom pour schema.prisma
  detector.ts              # Auto-detection du langage (extension + contenu)
```

**Principe** : chaque parser produit le meme format de carte (`FileNode`). Le reste du systeme (impact, guard, check) ne connait pas le langage — il travaille uniquement sur la carte.

**Detection automatique** : CodeGuard detecte le langage par l'extension du fichier. Pas de config manuelle. Si un projet mixe TS + Python (monorepo), les deux parsers tournent ensemble.

---

## Features

### P0 — Carte du projet + Impact analysis (jour 1)

- [x] **Scaffold** — init TypeScript, structure, tsconfig, build ✅ (4 avril 2026)
- [x] **Cartographie TS/JS** — parser ts-morph fonctionnel ✅ (4 avril 2026)
  - Imports / exports par fichier
  - Fonctions, classes, hooks exportes
  - Types et interfaces exportes
  - Routes API (Next.js app router + NestJS controllers)
  - Dependances entre fichiers (graphe oriente)
- [ ] **Cartographie Prisma** — parser custom pour schema.prisma (a faire)
  - Schema Prisma (modeles, champs, relations)
- [x] **Impact analysis** — transitif + score de risque ✅ (4 avril 2026)
  - Fichiers qui importent directement
  - Fichiers impactes en cascade (transitif BFS)
  - Routes API affectees
  - Types qui changent de forme
  - Score de risque (low/medium/high/critical)
- [x] **Serveur MCP** — 7 outils via stdio ✅ (4 avril 2026)
- [x] **Fix resolution imports ESM** — `.js` → `.ts` (convention ESM) ✅ (4 avril 2026)
- [x] **Tests automatises** — 58 tests MCP (test-mcp.mjs) ✅ (4 avril 2026)
- [ ] **Integration Claude Code** — `.mcp.json`, test connexion sur un vrai projet, zero crash

### P1 — Filets de securite (jour 2)

- [x] **Pre-change guard** — AVANT toute modification, Claude interroge CodeGuard ✅ (4 avril 2026)
  - "Est-ce safe de modifier ce fichier ?"
  - → reponse avec la liste des risques et les fichiers a verifier apres
  - → hook PreToolUse sur Edit/Write qui interroge automatiquement
- [x] **Post-change check** — APRES chaque modification ✅ (4 avril 2026)
  - Re-indexe le fichier modifie
  - Compare avec l'index precedent
  - Detecte les imports casses, types manquants, exports supprimes
  - Alerte immediatement si quelque chose est incoherent
  - → hook PostToolUse sur Edit/Write qui verifie automatiquement
- [x] **CLI hooks** — point d'entree one-shot (`src/cli.ts`) + config `.claude/settings.json` ✅ (4 avril 2026)
- [ ] **Schema sync** — coherence Prisma ↔ DTOs backend ↔ types frontend ↔ appels API :
  - Un champ ajoute dans Prisma mais absent du DTO ? → alerte
  - Un type frontend qui ne matche plus le backend ? → alerte
  - Un endpoint qui retourne un shape different du type declare ? → alerte
- [ ] **Route guard** — coherence des routes :
  - Route backend qui existe mais pas appelee par le frontend ? → signal
  - Appel frontend vers une route qui n'existe plus ? → alerte
  - Middleware d'auth manquant sur une route sensible ? → alerte critique

### P2 — Intelligence (jour 3)

- [x] **Requetes libres** — deja couvert par l'outil `search` (P0) ✅
- [ ] **Changelog auto** — a chaque session, generer un diff lisible de ce qui a change dans la carte
- [x] **Score de sante** — note A-F, imports casses, orphelins, circulaires, haut risque ✅ (4 avril 2026)
- [x] **Regression map** — pages/routes a retester apres modification ✅ (4 avril 2026)
- [x] **Auto-reindex** — partiel : le hook `check` re-indexe fichier par fichier ✅
- [x] **CLI** — 7 commandes : init, status, impact, health, regression, guard, check ✅ (4 avril 2026)

### P3 — Polish

- [ ] **Visualisation** — graphe de dependances en mermaid (affichable dans une issue GitHub)
- [ ] **Incremental** — ne re-parser que les fichiers modifies (perf sur gros projets)
- [ ] **npm package** — publier pour l'utiliser sur n'importe quel projet via `npx @skhaall/codeguard`

---

## Outils MCP exposes

| Outil | Description | Quand |
|-------|-------------|-------|
| `impact` | Fichier → liste complete de tout ce qui est touche | AVANT de modifier |
| `guard` | Verifie si une modification est safe, retourne les risques | AVANT de modifier |
| `check` | Re-indexe et detecte les incoherences apres modification | APRES modification |
| `route_map` | Toutes les routes API avec handler, middleware, auth | A la demande |
| `dependencies` | Graphe de dependances d'un fichier | A la demande |
| `search` | Qui utilise cette fonction/type/hook/composant ? | A la demande |
| `schema_check` | Coherence Prisma ↔ backend ↔ frontend | AVANT chaque deploy |
| `health` | Score de sante global du projet | A la demande |
| `status` | Etat de l'index (date, nb fichiers, fraicheur) | A la demande |

## Hooks automatiques (integration Claude Code)

```
PreToolUse(Edit|Write) → codeguard guard {fichier}
  → Si risque critique : afficher l'alerte AVANT de modifier

PostToolUse(Edit|Write) → codeguard check {fichier}
  → Si incoherence detectee : alerter immediatement

PreToolUse(git commit) → codeguard health
  → Si score < seuil : bloquer le commit avec explication
```

## Structure du projet

```
codeguard/
  src/
    index.ts              # Entry point MCP server (stdio)
    parsers/
      base-parser.ts      # Interface commune (contrat)
      typescript-parser.ts # ts-morph → analyse profonde TS/TSX/JS/JSX
      treesitter-parser.ts # tree-sitter → wrapper generique multi-langage
      language-configs/
        python.ts          # Regles Python (imports, decorateurs FastAPI/Django)
        go.ts              # Regles Go (packages, structs, interfaces)
        rust.ts            # Regles Rust (use, mod, impl, traits)
        java.ts            # Regles Java (annotations Spring, imports)
      prisma-parser.ts     # Parser custom pour schema.prisma
      detector.ts          # Auto-detection du langage par extension + contenu
    graph/
      dependency-graph.ts  # Graphe de dependances oriente
      impact-resolver.ts   # Calcul d'impact transitif (BFS/DFS)
    tools/
      impact.ts            # Outil impact analysis
      guard.ts             # Pre-change safety check
      check.ts             # Post-change coherence check
      routes.ts            # Route map (multi-framework)
      search.ts            # Recherche libre
      schema.ts            # Schema sync check
      health.ts            # Score de sante
    storage/
      index-store.ts       # Lecture/ecriture de la carte JSON
      snapshot.ts          # Snapshots pour comparaison avant/apres
    utils/
      risk-scorer.ts       # Calcul du score de risque
      logger.ts            # Logging structure (JAMAIS stderr)
  package.json
  tsconfig.json
  README.md
```

## Criteres de succes

- [ ] `claude mcp list` affiche codeguard avec tous les outils
- [ ] Impact analysis retourne les bons fichiers sur Cathodix (verification manuelle)
- [ ] Guard empeche une modification dangereuse sans faux positifs excessifs
- [ ] Check detecte un import casse apres suppression d'un export
- [ ] Schema check detecte une incoherence Prisma ↔ frontend
- [ ] Route map liste toutes les routes API sans en oublier
- [ ] Pas de crash, pas de timeout, pas de "failed" — JAMAIS
- [ ] Zero ecriture sur stderr (lecon GitNexus)
- [ ] Utilisable sur Cathodix ET Kairox sans config speciale
- [ ] Hooks PreToolUse/PostToolUse fonctionnent sans ralentir Claude Code
