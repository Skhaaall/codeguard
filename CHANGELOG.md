# Changelog

Toutes les modifications notables de ce projet sont documentees ici.
Format : [Keep a Changelog](https://keepachangelog.com/fr/1.1.0/)
Versioning : [Semantic Versioning](https://semver.org/lang/fr/)

## [Unreleased]

### Added
- Outil `route_guard` — coherence routes frontend ↔ backend
- Outil `changelog` — diff lisible entre ancien et nouvel index
- Extraction des appels API frontend (fetch, axios, custom clients)
- Detection des decorateurs d'auth NestJS (@UseGuards, @Roles...)
- Validation zod des entrees stdin et index JSON
- Module partage `core/indexer.ts` (suppression duplication cli/serveur)
- Catalogue d'outils dans `tools/tool-definitions.ts`

### Changed
- Refactoring : extracteurs API/auth dans `parsers/extractors/`
- Route matching : support des prefixes `/api`, `/api/v1`, `/api/v2`
- Distinction frontend/backend dans la collecte des appels API

### Fixed
- Non-null assertion remplacee par guard clause dans changelog.ts

## [0.1.0] - 2026-04-04

### Added
- Serveur MCP stdio avec 11 outils (impact, guard, check, health, search, dependencies, reindex, status, regression_map, graph, schema_check)
- Parser TypeScript/JavaScript profond via ts-morph (imports, exports, fonctions, classes, types, routes)
- Parser Prisma custom (modeles, champs, relations, enums)
- Graphe de dependances bidirectionnel avec cache
- Impact analysis transitif (BFS) + score de risque
- Pre-change guard (analyse de risque avant modification)
- Post-change check (detection imports casses, exports supprimes)
- Score de sante A-F (scoring adaptatif)
- Regression map (pages/routes a retester)
- Schema check (coherence Prisma ↔ DTOs ↔ types frontend)
- Diagramme Mermaid (graphe complet ou focus)
- Reindex incremental (0ms si rien n'a change)
- CLI complet (init, status, impact, health, regression, graph, schema, guard, check)
- Hooks Claude Code (PreToolUse/PostToolUse sur Edit/Write)
- Commande setup/unsetup pour installer les hooks automatiquement
- Path aliases TypeScript et barrel exports
- Protection path traversal, validation inputs, limites DoS, symlinks ignores
- 58+ assertions dans test-mcp.mjs

### Security
- Path traversal bloque (chemins doivent rester dans le projet)
- Stdin limite a 1 Mo, index limite a 50 Mo
- Liens symboliques ignores
- Zero ecriture sur stderr (protocole MCP)
