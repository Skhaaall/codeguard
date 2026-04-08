# CodeGuard

Serveur MCP qui analyse le code TypeScript/Prisma d'un projet, construit un graphe de dependances, et protege contre les modifications dangereuses et les regressions silencieuses.

**Ecosysteme** : TypeScript, JavaScript, Prisma

## Ce que ca fait

### Protection en temps reel (hooks automatiques)

- **Guard** — avant chaque modification : risques, historique git, fonctions modifiees recemment, couverture tests, hotspot detection
- **Check** — apres chaque modification : imports casses, signatures changees, code mort, incoherence de patterns

### Analyse du projet

- **Impact analysis** — "je modifie ce fichier, qu'est-ce qui casse ?"
- **Health** — score de sante global du projet (A-F, scoring adaptatif)
- **Schema check** — coherence Prisma ↔ DTOs backend ↔ types frontend
- **Route guard** — coherence routes frontend ↔ backend
- **Regression map** — quelles pages/routes retester apres un changement
- **Graph** — diagramme Mermaid du graphe de dependances
- **Search** — "qui utilise cette fonction/type/hook ?"

### Detection de problemes

- **Whatsnew** — resume des changements depuis le dernier reindex (debut de session)
- **Silent catch** — detection des catches silencieux (catch vides, return sans log, setState default)
- **External map** — carte des connexions externes (packages npm, variables d'env, appels API sortants)

## Prerequis

- Node.js >= 20
- Claude Code (pour les hooks MCP)

## Installation

```bash
npm install -g skhaall-codeguard
```

> Les commandes peuvent etre lancees dans un **terminal classique** ou dans **Claude Code** avec le prefixe `!` (ex: `! npm install -g skhaall-codeguard`).

Ou depuis les sources :

```bash
git clone https://github.com/Skhaaall/codeguard.git
cd codeguard && npm install && npm run build
```

## Configuration

### 1. Serveur MCP (connecte CodeGuard a Claude Code)

Ajouter dans le `.mcp.json` a la racine du projet :

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

### 2. Hooks automatiques (guard + check a chaque modification)

```bash
codeguard-setup setup
```

Ca installe deux hooks dans `~/.claude/settings.local.json` :

- **guard** — se lance automatiquement AVANT chaque Edit/Write dans Claude Code
- **check** — se lance automatiquement APRES chaque Edit/Write dans Claude Code

Pour les retirer :

```bash
codeguard-setup unsetup
```

### 3. Indexer le projet

A la racine du projet :

```bash
codeguard-cli init
```

Ca cree un dossier `.codeguard/` avec l'index du projet (ajouter `.codeguard/` au `.gitignore`).

## Utilisation

### CLI

```bash
codeguard-cli init [project-root]              # Indexer le projet
codeguard-cli status [project-root]            # Etat de l'index
codeguard-cli health [project-root]            # Score de sante (A-F)
codeguard-cli impact <fichier> [project-root]  # Analyse d'impact
codeguard-cli regression <fichier> [project-root]  # Pages a retester
codeguard-cli graph [fichier] [project-root]   # Diagramme Mermaid
codeguard-cli schema [project-root]            # Coherence Prisma ↔ TS
codeguard-cli routes [project-root]            # Coherence routes F↔B
codeguard-cli whatsnew [since]                 # Changements recents
codeguard-cli silent_catch [severity]          # Catches silencieux
codeguard-cli changelog [project-root]         # Diff depuis le snapshot
codeguard-cli external_map [project-root]      # Carte des connexions externes
```

## Outils MCP (16)

| Outil            | Description                                                  | Quand              |
| ---------------- | ------------------------------------------------------------ | ------------------ |
| `impact`         | Fichiers impactes si on modifie un fichier                   | Avant modification |
| `guard`          | Risques, historique git, hotspot, couverture tests, go/no-go | Avant modification |
| `check`          | Imports casses, signatures changees, code mort, patterns     | Apres modification |
| `health`         | Score A-F, imports casses, cycles, orphelins                 | A la demande       |
| `schema_check`   | Coherence Prisma ↔ DTOs ↔ types frontend                     | Apres modif schema |
| `route_guard`    | Coherence routes frontend ↔ backend                          | A la demande       |
| `search`         | Recherche fonctions, types, hooks, routes                    | A la demande       |
| `dependencies`   | Graphe d'un fichier (importe / importe par)                  | A la demande       |
| `reindex`        | Re-indexer le projet (complet ou incremental)                | Debut de session   |
| `status`         | Date, nombre de fichiers, fraicheur de l'index               | A la demande       |
| `regression_map` | Pages et routes a retester apres modification                | Avant deploy       |
| `graph`          | Diagramme Mermaid (complet ou focus sur un fichier)          | A la demande       |
| `whatsnew`       | Resume des changements depuis le dernier reindex             | Debut de session   |
| `silent_catch`   | Detection des catches silencieux dans le projet              | Audit / review     |
| `changelog`      | Diff lisible entre ancien et nouvel index                    | A la demande       |
| `external_map`   | Packages npm, variables d'env, appels API sortants           | A la demande       |

## Langages supportes

| Langage        | Parser        | Profondeur                                       |
| -------------- | ------------- | ------------------------------------------------ |
| TypeScript/TSX | ts-morph      | Complet (types, generics, routes Next.js/NestJS) |
| JavaScript/JSX | ts-morph      | Imports, exports, fonctions, classes             |
| Prisma         | Parser custom | Modeles, champs, relations, enums                |

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
