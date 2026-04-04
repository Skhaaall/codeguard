# Historique des corrections et ajouts — CodeGuard

> Detail granulaire de chaque modification. MEMORY.md = resume haut niveau, ici = filet de securite.

---

## Session 1 — 4 avril 2026 (commit `20246f0`)

### Scaffold initial
- `src/index.ts` — serveur MCP stdio, 5 outils (impact, search, reindex, status, dependencies)
- `src/parsers/base-parser.ts` — types de la carte (FileNode, ImportInfo, ExportInfo, etc.)
- `src/parsers/typescript-parser.ts` — parser ts-morph profond (imports, exports, fonctions, classes, types, routes Next.js + NestJS)
- `src/parsers/detector.ts` — auto-detection du langage par extension
- `src/graph/dependency-graph.ts` — graphe bidirectionnel (dependsOn / dependedBy)
- `src/graph/impact-resolver.ts` — BFS transitif + score de risque
- `src/storage/index-store.ts` — lecture/ecriture JSON de la carte
- `src/utils/scanner.ts` — scanner de fichiers (respecte .gitignore)
- `src/utils/logger.ts` — logger fichier (jamais stderr)
- `src/tools/impact.ts` — outil MCP impact analysis
- `src/tools/search.ts` — outil MCP recherche dans la carte
- Config : `tsconfig.json`, `package.json`, `.gitignore`, `CLAUDE.md`, `.claude/rules/project.md`
- Docs : `README.md`, `MEMORY.md`, `todo.md`

---

## Session 2 — 4 avril 2026 (commit `dd4633b`)

### Docs et contexte
- `CLAUDE.md` — instructions projet (stack, architecture, regles MCP)
- `MEMORY.md` — etat initial du projet
- `todo.md` — plan complet P0-P3
- `.claude/rules/project.md` — regles specifiques CodeGuard

---

## Session 3 — 4 avril 2026 (commit `4e7052c`)

### Bug fix critique : resolution imports ESM
- **Fichier** : `src/graph/dependency-graph.ts` (fonction `resolveImportPath`)
- **Probleme** : les imports TypeScript utilisent `.js` (convention ESM : `from './base-parser.js'`), mais le resolver cherchait `base-parser.js.ts` au lieu de retirer le `.js` d'abord
- **Impact** : graphe de dependances vide (0 aretes), impact analysis inutile
- **Fix** : strip les extensions JS (`.js`, `.jsx`, `.mjs`, `.cjs`) avant de chercher le fichier `.ts` correspondant
- **Resultat** : graphe passe de 0 a 31 aretes, impact analysis fonctionnelle

### Tests automatises
- **Fichier** : `test-mcp.mjs` (nouveau)
- Script Node.js qui lance le serveur MCP, envoie 19 requetes JSON-RPC (NDJSON), verifie les reponses
- 58 assertions couvrant : initialize, list tools, reindex, status, impact (2 cas), search (3 cas), dependencies (2 cas), guard (2 cas), check (2 cas), robustesse (fichier inexistant, recherche vide, outil inconnu), zero stderr
- **Decouverte** : le SDK MCP v1.29 utilise NDJSON (pas Content-Length comme LSP)

### P1 — Guard (pre-change safety check)
- **Fichier** : `src/tools/guard.ts` (nouveau)
- Analyse un fichier AVANT modification
- Detecte : fichier tres partage, trop d'exports, domaine sensible (auth/middleware/schema/config), routes API affectees, cascade transitive
- Retourne : risque (low/medium/high/critical), avertissements, fichiers a verifier, liste des exports
- Recommandation go/no-go (safe = true/false)

### P1 — Check (post-change coherence)
- **Fichier** : `src/tools/check.ts` (nouveau)
- Verifie un fichier APRES modification
- Re-parse le fichier avec ts-morph, compare avec l'ancien index
- Detecte : exports supprimes → imports casses, proprietes supprimees dans les types, proprietes requises ajoutees, imports vers fichiers inexistants
- Met a jour l'index automatiquement

### CLI pour hooks Claude Code
- **Fichier** : `src/cli.ts` (nouveau)
- Point d'entree one-shot : lit stdin JSON (format hook Claude Code), execute guard ou check, retourne JSON hook
- Guard : `permissionDecision: "deny"` si risque critique, `"allow"` sinon avec contexte
- Check : toujours `"allow"`, ajoute `additionalContext` avec les problemes detectes
- Gestion d'erreur : en cas d'erreur interne, laisse passer (ne bloque jamais Claude Code par erreur)
- Normalisation des chemins Windows (forward slash → backslash via `resolve()`)

### Hooks Claude Code
- **Fichier** : `.claude/settings.json` (nouveau)
- `PreToolUse(Edit|Write)` → `node dist/cli.js guard`
- `PostToolUse(Edit|Write)` → `node dist/cli.js check`
- Timeout : 30s

### Serveur MCP mis a jour
- **Fichier** : `src/index.ts` (modifie)
- 7 outils exposes : impact, search, reindex, status, dependencies, **guard**, **check**
- Imports ajoutes : `runGuard`, `formatGuardResult`, `runCheck`, `formatCheckResult`

### Package.json
- Ajout bin `codeguard-cli` → `dist/cli.js`
- Ajout scripts `guard` et `check`

---

## Session 4 — 4 avril 2026 (commit `8bd5637`)

### P2 — Health (score de sante global)
- **Fichier** : `src/tools/health.ts` (nouveau)
- Score de A (excellent) a F (critique), note sur 100
- Detecte : imports casses (-5pts chacun), fichiers orphelins (-2pts), fichiers haut risque (-3pts), dependances circulaires (-8pts), fichiers volumineux (-1pt)
- Premier scan de CodeGuard : **A (95/100)** — 1 orphelin (test-mcp.mjs), 1 haut risque (index-store.ts)

### P2 — Regression Map
- **Fichier** : `src/tools/regression.ts` (nouveau)
- BFS depuis le fichier modifie pour trouver les cibles terminales (pages, routes API, entry points, composants)
- Classifie les fichiers : Next.js pages/routes, NestJS controllers, entry points, composants React
- Extrait les URLs des pages Next.js (`/app/.../page.tsx` → `/route`)
- Tri par priorite : pages > routes API > entry points > composants

### P2 — CLI etendu
- **Fichier** : `src/cli.ts` (reecrit)
- 2 modes : hook (guard/check, stdin JSON) et CLI (init/status/impact/health/regression, arguments)
- 7 commandes au total : init, status, impact, health, regression, guard, check
- Detection automatique du mode selon la commande
- Help integre (`codeguard-cli` sans argument)

### Serveur MCP mis a jour
- **Fichier** : `src/index.ts` (modifie)
- 9 outils exposes : impact, search, reindex, status, dependencies, guard, check, **health**, **regression_map**

### Tests
- **Fichier** : `test-mcp.mjs` (modifie)
- 69 assertions, 22 tests, tous verts
- Nouveaux tests : health (7 assertions), regression_map (3 assertions), list tools (9 outils)
