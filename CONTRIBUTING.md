# Contribuer a CodeGuard

## Prerequis

- Node.js >= 20
- Git

## Setup du projet

```bash
git clone https://github.com/Skhaaall/codeguard.git
cd codeguard
npm install
npm run build
```

## Conventions

- **Commits** : Conventional Commits en francais (`feat:`, `fix:`, `docs:`, `chore:`)
- **Branches** : `feature/xxx`, `fix/xxx`, `hotfix/xxx`
- **Code** : TypeScript strict, ESLint + Prettier
- **Tests** : `npm test` doit passer avant chaque commit (husky le verifie)

## Commandes utiles

```bash
npm run build        # Compile TypeScript
npm run lint         # Verifie le code avec ESLint
npm run format       # Formate avec Prettier
npm test             # Lance les 32 tests MCP
npm run typecheck    # Type-check sans build
```

## Process de contribution

1. Creer une branche depuis `main`
2. Coder + tester (`npm run build && npm test`)
3. Ouvrir une PR avec description
4. CI verte (build + lint + typecheck + tests)
5. Merge apres validation
