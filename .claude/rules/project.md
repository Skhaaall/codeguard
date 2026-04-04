# Regles specifiques CodeGuard

## C'est quoi CodeGuard
Un serveur MCP qui parse le code source d'un projet, construit un graphe de dependances, et expose des outils d'analyse (impact, search, guard, check) via le protocole MCP standard.

## Contraintes techniques

### MCP
- Communication via stdio uniquement
- JAMAIS ecrire sur stderr (casse le protocole)
- JAMAIS utiliser `cmd /c` sur Windows (intercepte le JSON)
- Les outils retournent du texte markdown (lisible par Claude Code)

### Parsers
- Tous les parsers produisent le meme format `FileNode` (defini dans `base-parser.ts`)
- Le reste du systeme (graph, tools) ne connait pas le langage — il travaille sur la carte
- Un parser qui crash sur un fichier ne doit pas planter le serveur — catch + skip

### Performance
- Le parsing doit rester sous 30s pour un projet de 500 fichiers
- L'index est cache en JSON (`.codeguard/index.json`) — pas de re-parse a chaque demarrage
- Les requetes (impact, search) doivent repondre en < 100ms sur l'index en memoire

### Securite
- CodeGuard lit le code source mais ne le modifie JAMAIS
- Le dossier `.codeguard/` doit etre dans le `.gitignore` du projet cible
- Ne jamais indexer le contenu des fichiers `.env` ou des secrets
