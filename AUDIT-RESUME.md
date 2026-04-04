# Audit Resume — @skhaall/codeguard

> Genere le 4 avril 2026. Combine les resultats du reviewer et du security-scanner.

## Etat du projet

| Metrique | Valeur |
|---|---|
| Version | 0.1.0 |
| Fichiers source | 19 (.ts) |
| Outils MCP | 10 |
| Tests automatises | 79 (tous verts) |
| Build | OK (zero erreur TypeScript) |
| Health score | A (95/100) |
| Note review code | B |
| Note securite | B |

## Outils MCP exposes

| Outil | Role |
|---|---|
| `impact` | Fichiers impactes si je modifie X |
| `guard` | Est-ce safe de modifier X ? (pre-change) |
| `check` | Detecter les casses apres modification (post-change) |
| `health` | Score de sante global (A-F) |
| `search` | Qui utilise cette fonction/type/hook ? |
| `dependencies` | Graphe d'un fichier (importe/importe par) |
| `reindex` | Re-indexer le projet (complet ou incremental) |
| `status` | Etat de l'index (date, nb fichiers) |
| `regression_map` | Pages/routes a retester apres modification |
| `graph` | Diagramme Mermaid du graphe de dependances |

## Review code — corrections effectuees

| Priorite | Probleme | Statut |
|---|---|---|
| P1 | Graphe reconstruit a chaque appel d'outil | CORRIGE — graphe cache en memoire |
| P1 | `importPointsTo` faux positifs (comparaison nom de base) | CORRIGE — resolution complete via `import-resolver.ts` |
| P1 | Resolution d'imports dupliquee 3 fois | CORRIGE — source unique `utils/import-resolver.ts` |
| P2 | `readStdin` timeout 2s trop court | CORRIGE — 10s + log warning |
| P2 | `detectCircularDeps` cycles directs seulement | CORRIGE — Tarjan (SCC, cycles transitifs) |
| P2 | `addEdge` O(n²) avec find() lineaire | CORRIGE — Map O(1) |
| P2 | `runCheck` mute l'index (effet de bord) | CORRIGE — retourne `updatedIndex` |
| P3 | `shortPath` duplique 3 fois | CORRIGE — `utils/path.ts` |
| P3 | Pas de validation PROJECT_ROOT | CORRIGE — `statSync` au demarrage |
| P2 | `index.ts` 473 lignes (trop de responsabilites) | NON CORRIGE — refactoring reporte |
| P4 | Logger synchrone (`writeFileSync`) | NON CORRIGE — acceptable pour v0.1.0 |
| P4 | `TypeScriptParser` instancie en double | NON CORRIGE — mineur |

## Securite — failles detectees

### P2 (a corriger)

| # | Faille | Fichier | Detail |
|---|---|---|---|
| 1 | **Path traversal** | `index.ts` (`resolveFilePath`) | Chemins absolus ou `../../` acceptes sans verifier qu'ils restent dans le projet. Lecture de fichiers arbitraires possible via les outils MCP. |
| 2 | **Path traversal CLI** | `cli.ts` | Meme probleme pour les chemins venant de stdin JSON ou argv. |
| 3 | **Inputs MCP non valides** | `index.ts` | `args?.filePath as string` sans validation runtime. undefined/null/number passent silencieusement. |

### P3 (a planifier)

| # | Faille | Fichier | Detail |
|---|---|---|---|
| 4 | DoS stdin sans limite | `cli.ts` | `readStdin()` accumule sans limite de taille. |
| 5 | DoS index JSON sans limite | `index-store.ts` | `readFileSync` + `JSON.parse` sur fichier potentiellement enorme. |
| 6 | Ecriture hors perimetre | `logger.ts`, `index-store.ts` | `projectRoot` non valide → creation de dossiers/fichiers arbitraires. |
| 7 | Liens symboliques suivis | `scanner.ts` | Le scanner suit les symlinks hors du projet. |
| 8 | Prototype pollution theorique | `index-store.ts`, `cli.ts` | `JSON.parse` sans filtrage des cles `__proto__`. Impact limite. |

### Points positifs

- Zero secret en dur
- Zero injection de commande (pas de exec/eval/spawn)
- Zero dependance vulnerable (`npm audit` propre)
- Pas de serveur HTTP = pas de surface reseau
- TypeScript strict active
- `.gitignore` correct (`.env`, `.mcp.json`, `.codeguard/`)

## Architecture

```
src/
  index.ts                    # Serveur MCP (stdio) — 10 outils
  cli.ts                      # CLI (hooks + commandes directes)
  parsers/
    base-parser.ts            # Types de la carte (FileNode)
    typescript-parser.ts      # ts-morph — analyse profonde TS/TSX/JS/JSX
    detector.ts               # Auto-detection du langage
  graph/
    dependency-graph.ts       # Graphe bidirectionnel (Map O(1))
    impact-resolver.ts        # BFS transitif + score de risque
  tools/
    impact.ts                 # Analyse d'impact
    guard.ts                  # Pre-change safety check
    check.ts                  # Post-change coherence
    health.ts                 # Score de sante (Tarjan SCC)
    search.ts                 # Recherche dans la carte
    regression.ts             # Pages/routes a retester
    graph.ts                  # Diagramme Mermaid
  storage/
    index-store.ts            # Lecture/ecriture JSON
  utils/
    scanner.ts                # Scanner de fichiers
    logger.ts                 # Logger fichier (jamais stderr)
    path.ts                   # Utilitaire chemins courts
    import-resolver.ts        # Resolution d'imports (source unique)
```

## Prochaines actions

1. **Corriger les P2 securite** — path traversal + validation inputs MCP
2. **Corriger les P3 securite** — limites stdin/JSON, symlinks, projectRoot
3. **Tester sur un vrai projet** — Cathodix ou Kairox avec les hooks actifs
4. **Publier sur npm** — `npx @skhaall/codeguard`
