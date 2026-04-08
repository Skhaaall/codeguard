import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    rules: {
      // Catches silencieux interdits
      'no-empty': ['error', { allowEmptyCatch: false }],
      'no-useless-catch': 'error',

      // TypeScript strict
      '@typescript-eslint/no-unused-vars': ['error', {
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        argsIgnorePattern: '^_',
      }],
      '@typescript-eslint/no-explicit-any': 'error',

      // Initialisation let x = 0 puis reassignation plus tard = pattern valide
      'no-useless-assignment': 'off',

      // Qualite
      'no-console': 'error',
      'prefer-const': 'error',
    },
  },
  {
    // CLI et setup utilisent console.log legitimement (sortie utilisateur)
    files: ['src/cli.ts', 'src/setup.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'test-mcp.mjs', '*.js'],
  },
);
