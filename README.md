# @skhaall/codeguard

Serveur MCP qui analyse le code TypeScript/Prisma d'un projet, construit un graphe de dependances, et protege contre les modifications dangereuses.

**Ecosysteme** : TypeScript, JavaScript, Prisma (support Python/Go/Rust prevu via tree-sitter en v0.2)

## Ce que ca fait

- **Impact analysis** — "je modifie ce fichier, qu'est-ce qui casse ?"
- **Guard** — "est-ce safe de modifier ce fichier ?" (pre-change, bloque si risque critique)
- **Check** — detecte les imports casses apres modification (post-change)
- **Health** — score de sante global du projet (A-F, scoring adaptatif)
- **Schema check** — coherence Prisma ↔ DTOs backend ↔ types frontend
- **Regression map** — quelles pages/routes retester apres un changement
- **Graph** — diagramme Mermaid du graphe de dependances
- **Search** — "qui utilise cette fonction/type/hook ?"

## Prerequis

- Node.js >= 20
- Claude Code (pour les hooks MCP)

## Installation

```bash
npm install -g @skhaall/codeguard
```

Ou depuis les sources :

```bash
git clone https://github.com/Skhaaall/codeguard.git
cd codeguard
npm install
npm run build
```

## Setup (hooks automatiques)

Installe les hooks guard + check globalement dans Claude Code :

```bash
codeguard-setup setup
```

Pour les retirer :

```bash
codeguard-setup unsetup
```

## Utilisation

### Serveur MCP (pour Claude Code)

Ajouter dans le `.mcp.json` du projet :

```json
{
  "mcpServers": {
    "codeguard": {
      "command": "node",
      "args": ["/chemin/vers/codeguard/dist/index.js"]
    }
  }
}
```

### CLI

```bash
codeguard-cli init [project-root]              # Indexer le projet
codeguard-cli status [project-root]            # Etat de l'index
codeguard-cli health [project-root]            # Score de sante (A-F)
codeguard-cli impact <fichier> [project-root]  # Analyse d'impact
codeguard-cli regression <fichier> [project-root]  # Pages a retester
codeguard-cli graph [fichier] [project-root]   # Diagramme Mermaid
codeguard-cli schema [project-root]            # Coherence Prisma ↔ TS
```

## Outils MCP (11)

| Outil | Description | Quand |
|---|---|---|
| `impact` | Fichiers impactes si on modifie un fichier | Avant modification |
| `guard` | Risques, fichiers a verifier, recommandation go/no-go | Avant modification |
| `check` | Imports casses, exports supprimes, types changes | Apres modification |
| `health` | Score A-F, imports casses, cycles, orphelins | A la demande |
| `schema_check` | Coherence Prisma ↔ DTOs ↔ types frontend | Apres modif schema |
| `search` | Recherche fonctions, types, hooks, routes | A la demande |
| `dependencies` | Graphe d'un fichier (importe / importe par) | A la demande |
| `reindex` | Re-indexer le projet (complet ou incremental) | Debut de session |
| `status` | Date, nombre de fichiers, fraicheur de l'index | A la demande |
| `regression_map` | Pages et routes a retester apres modification | Avant deploy |
| `graph` | Diagramme Mermaid (complet ou focus sur un fichier) | A la demande |

## Langages supportes

| Langage | Parser | Profondeur |
|---|---|---|
| TypeScript/TSX | ts-morph | Complet (types, generics, routes Next.js/NestJS) |
| JavaScript/JSX | ts-morph | Imports, exports, fonctions, classes |
| Prisma | Parser custom | Modeles, champs, relations, enums |

Path aliases TypeScript (`@/` → `src/`) et barrel exports (`from './dir'` → `dir/index.ts`) sont geres automatiquement via la lecture du `tsconfig.json`.

## Stack

- TypeScript strict
- **ts-morph** — parsing profond TypeScript
- **@modelcontextprotocol/sdk** — protocole MCP standard (stdio)
- Index JSON cache dans `.codeguard/`
- Zero dependance lourde (pas de Docker, pas de base de donnees)

## Securite

- Path traversal bloque (les chemins doivent rester dans le projet)
- Validation des inputs MCP a runtime
- Limites DoS (stdin 1 Mo, index 50 Mo)
- Liens symboliques ignores
- CodeGuard lit le code source mais ne le modifie JAMAIS

## Licence

MIT
