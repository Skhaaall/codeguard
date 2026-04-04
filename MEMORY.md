# MEMORY — CodeGuard

## Contexte
- Projet cree le 4 avril 2026 par Skhaall, accompagne par Claude Code
- Remplace GitNexus (instable, bugs MCP, risque prompt injection)
- Objectif : filet de securite pour les projets TS — zero surprise quand on modifie du code

## Session 1 — 4 avril 2026

### Ce qui a ete fait
- Scaffold complet du projet (15 fichiers, 2952 lignes)
- Parser TypeScript profond (ts-morph) : imports, exports, fonctions, classes, types, routes (Next.js + NestJS)
- Graphe de dependances bidirectionnel avec resolution transitive (BFS)
- Impact analysis avec score de risque (low/medium/high/critical)
- Serveur MCP fonctionnel avec 5 outils : `impact`, `search`, `reindex`, `status`, `dependencies`
- Build OK, zero erreur TypeScript
- Commit initial : `20246f0`

### Decisions prises
- **ts-morph d'abord** — tree-sitter (Python, Go, Rust, Java) viendra apres que le coeur TS fonctionne
- **Prisma parser** reporte aussi — TS d'abord
- **Logger dans fichier** (jamais stderr) — lecon de GitNexus
- **Projet separe** dans `~/Desktop/dev/codeguard/` (pas dans ~/.claude/)

### Decisions architecturales
- **CodeGuard = analyse de code UNIQUEMENT** — la memoire centralisee est un outil separe (MCP Memory Server officiel Anthropic, configure dans `~/.claude/.mcp.json`)
- Ne jamais ajouter de features de memoire/cerveau dans CodeGuard — un projet = une responsabilite

## Session 2 — 4 avril 2026

### Ce qui a ete fait
- **Bug fix critique** : le resolver d'imports ne gerait pas la convention ESM (`.js` → `.ts`). Graphe passé de 0 arêtes à 31
- **Test complet P0** : 58 tests MCP automatises (test-mcp.mjs), tous verts
- **P1 — Guard** (`src/tools/guard.ts`) : analyse pre-modification, risques, fichiers à vérifier, exports exposés
- **P1 — Check** (`src/tools/check.ts`) : vérification post-modification, détecte exports supprimés, imports cassés, types changés
- **CLI hooks** (`src/cli.ts`) : point d'entrée one-shot pour les hooks Claude Code (lit stdin JSON, retourne JSON hook)
- **Hooks Claude Code** (`.claude/settings.json`) : PreToolUse(Edit|Write) → guard, PostToolUse(Edit|Write) → check
- Serveur MCP : **7 outils** (impact, search, reindex, status, dependencies, guard, check)

### Transport MCP
- Le SDK `@modelcontextprotocol/sdk` v1.29 utilise **NDJSON** (pas Content-Length). Chaque message = JSON + `\n`

### Prochaines etapes
1. Tester sur un vrai projet (Cathodix ou Kairox) avec les hooks actifs
2. Ajouter le Prisma parser (P1 — schema sync)
3. P2 : score de sante, regression map, auto-reindex

## Projets cibles pour les tests
- **Cathodix** — NestJS + Next.js, le projet principal de Skhaall
- **Kairox** — autre projet (score securite D, a ameliorer)

## Bugs connus de l'ecosysteme MCP (a eviter)
- `cmd /c` sur Windows intercepte le JSON stdin → toujours `node` directement
- stderr = canal de protocole MCP → jamais de logs dessus
