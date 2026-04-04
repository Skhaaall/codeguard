# @skhaall/codeguard

Serveur MCP qui analyse le code TypeScript d'un projet, construit un graphe de dependances, et expose des outils d'analyse pour Claude Code.

## Ce que ca fait

- **Impact analysis** — "je modifie ce fichier, qu'est-ce qui casse ?"
- **Guard** — "est-ce safe de modifier ce fichier ?" (pre-change)
- **Check** — detecte les imports casses apres modification (post-change)
- **Health** — score de sante global du projet (A-F)
- **Regression map** — quelles pages/routes retester apres un changement
- **Graph** — diagramme Mermaid du graphe de dependances
- **Search** — "qui utilise cette fonction/type/hook ?"

## Prerequis

- Node.js >= 20

## Installation

```bash
git clone https://github.com/Skhaaall/codeguard.git
cd codeguard
npm install
npm run build
```

## Utilisation

### Serveur MCP (pour Claude Code)

```bash
node dist/index.js /chemin/vers/le/projet
```

### CLI (ligne de commande)

```bash
node dist/cli.js init /chemin/vers/le/projet    # Indexer le projet
node dist/cli.js status                          # Etat de l'index
node dist/cli.js health                          # Score de sante
node dist/cli.js impact src/fichier.ts           # Analyse d'impact
node dist/cli.js regression src/fichier.ts       # Pages a retester
node dist/cli.js graph                           # Graphe Mermaid complet
node dist/cli.js graph src/fichier.ts            # Graphe centre sur un fichier
```

### Hooks Claude Code

Ajouter dans `.claude/settings.local.json` du projet cible :

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "node /chemin/vers/codeguard/dist/cli.js guard" }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "node /chemin/vers/codeguard/dist/cli.js check" }]
      }
    ]
  }
}
```

## Outils MCP

| Outil | Description |
|---|---|
| `impact` | Fichiers impactes si on modifie un fichier |
| `guard` | Verification pre-modification (risques, fichiers a verifier) |
| `check` | Verification post-modification (imports casses, types changes) |
| `health` | Score de sante global (imports, cycles, orphelins) |
| `search` | Recherche de fonctions, types, hooks dans la carte |
| `dependencies` | Graphe d'un fichier (qui il importe, qui l'importe) |
| `reindex` | Re-indexer le projet (complet ou incremental) |
| `status` | Etat de l'index (date, nombre de fichiers) |
| `regression_map` | Pages et routes a retester apres un changement |
| `graph` | Diagramme Mermaid du graphe de dependances |

## Stack

- TypeScript strict
- **ts-morph** — parsing profond TypeScript
- **@modelcontextprotocol/sdk** — protocole MCP standard (stdio)
- Index JSON cache dans `.codeguard/`

## Licence

MIT
