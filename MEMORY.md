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

### Prochaines etapes
1. Tester le serveur MCP sur un vrai projet (Cathodix ou Kairox)
2. Valider que l'impact analysis retourne les bons fichiers
3. Ajouter le Prisma parser
4. P1 : guard (pre-change) + check (post-change) + hooks Claude Code

## Projets cibles pour les tests
- **Cathodix** — NestJS + Next.js, le projet principal de Skhaall
- **Kairox** — autre projet (score securite D, a ameliorer)

## Bugs connus de l'ecosysteme MCP (a eviter)
- `cmd /c` sur Windows intercepte le JSON stdin → toujours `node` directement
- stderr = canal de protocole MCP → jamais de logs dessus
