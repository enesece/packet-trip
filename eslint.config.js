import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'playwright-report/**',
      'test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/__tests__/**'],
    rules: {
      // The engine must stay deterministic and offline.
      'no-restricted-properties': [
        'error',
        { object: 'Date', property: 'now', message: 'Use the virtual clock.' },
        { object: 'Math', property: 'random', message: 'Use the seeded RNG.' },
      ],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: 'The engine never touches the network.' },
        'document',
        'window',
      ],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'jsx-a11y': jsxA11y },
    rules: {
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
    },
  },
);
