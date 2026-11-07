// @ts-check
import eslint from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * A deliberately small ruleset (warnings, so `npm run lint` never blocks on style), plus two hard
 * rules that protect the architecture: the strategy module is used only through its public API,
 * and randomness for secrets never comes from Math.random.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'var/**', 'public/**', 'graphify-out/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-empty': 'warn',
      'no-restricted-properties': [
        'error',
        { object: 'Math', property: 'random', message: 'Use node:crypto (randomInt / randomUUID / randomBytes).' },
      ],
    },
  },
  {
    // Core business boundary: other modules import the strategy only from modules/strategy/index.ts.
    files: ['src/**/*.ts', 'test/**/*.ts'],
    ignores: ['src/modules/strategy/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/strategy/tier1/*', '**/strategy/tier2/*', '**/strategy/overrides/*', '**/strategy/strategy.*'],
              message: 'Use the strategy module through its public API: modules/strategy/index.js',
            },
          ],
        },
      ],
    },
  },
);
