import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import prettier from 'eslint-config-prettier';

const config = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  importPlugin.flatConfigs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': ['error', { ignoreRestArgs: true }],
      '@typescript-eslint/explicit-function-return-type': 'off',
      'import/order': [
        'error',
        {
          alphabetize: { order: 'asc' },
          'newlines-between': 'always',
        },
      ],
      'import/no-unresolved': 'off',
    },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      // The plugin cannot follow Testing Library's `export *` re-exports.
      'import/named': 'off',
    },
  },
  {
    // Build and tooling configs run in Node, not in the browser bundle. Without
    // this, reading `process.env` in `next.config.mjs` is a `no-undef` error
    // while the identical line in application code is not.
    files: ['**/*.config.mjs', '**/*.config.js'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
  {
    // A service worker runs in its own global scope, where `self` is the
    // worker itself rather than the window. Without this the file reads as a
    // script full of undefined identifiers.
    //
    // It is linted rather than ignored: a service worker that throws is a
    // service worker that never shows a message, and nothing else in the
    // repository would notice.
    files: ['**/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
      },
    },
  },
  prettier,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.next/**',
      '**/.vercel/**',
      '**/.open-next/**',
      '**/.wrangler/**',
      '**/drizzle/**',
      '**/next-env.d.ts',
    ],
  },
);

export default config;
