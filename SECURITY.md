# Politique de securite — CodeGuard

## Signaler une vulnerabilite

Si vous trouvez une faille de securite dans CodeGuard, merci de la signaler de maniere responsable :

- **Email** : ouvrir une issue privee sur GitHub (Security > Report a vulnerability)
- **Ne pas** publier la faille en issue publique avant qu'elle soit corrigee

## Perimetre

CodeGuard est un outil d'analyse de code en lecture seule. Il ne modifie jamais les fichiers source.

### Ce qui est dans le perimetre

- Path traversal (acces a des fichiers hors du projet)
- Injection de commandes via les inputs MCP
- Fuite de secrets (fichiers .env indexes par erreur)
- Denial of service (index ou stdin trop volumineux)

### Ce qui n'est pas dans le perimetre

- Vulnerabilites dans les dependances transitives (utiliser `npm audit`)
- Bugs fonctionnels (utiliser les issues GitHub)

## Mesures en place

- Path traversal bloque (les chemins doivent rester dans le projet)
- Validation des inputs MCP a runtime (zod)
- Stdin limite a 1 Mo, index limite a 50 Mo
- Liens symboliques ignores
- Zero ecriture sur stderr (protocole MCP)
- Fichiers .env et secrets jamais indexes
