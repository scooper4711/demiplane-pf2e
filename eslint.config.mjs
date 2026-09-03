import eslint from '@eslint/js';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'foundry-playwright/**'],
  },

  // Production TypeScript files
  {
    files: ['src/**/*.ts'],
    ignores: ['**/*.test.ts', '**/*.spec.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.json',
      },
    },
    rules: {
      // MUST rules (error) — hard limits
      'complexity': ['error', { max: 15 }],
      'max-lines': ['error', { max: 500, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // SHOULD rules (warn) — soft limits
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],

      // Unsafe casts must go through a documented seam (see DESIGN.md §23).
      // Any genuinely-isolated exception needs an explicit eslint-disable with a reason.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression > TSNeverKeyword',
          message:
            'Avoid `as never`: route document operations through a seam (foundry-doc-ops / pf2e-types). If genuinely unavoidable, add an eslint-disable with justification.',
        },
        {
          selector: 'TSAsExpression > TSAsExpression > TSUnknownKeyword',
          message:
            'Avoid `as unknown as`: route through a typed seam (pf2e-types / pack-index). If genuinely unavoidable (e.g. an untyped global), add an eslint-disable with justification.',
        },
      ],
    },
  },

  // Test files — exempt from file size and function length limits
  {
    files: ['tests/**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.recommended,
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
      }],
    },
  },
);
