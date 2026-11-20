import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import hooks from 'eslint-plugin-react-hooks'
export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'error',
      'react-hooks/incompatible-library': 'off',
    },
  },
  // Control-character rejection is intentional input validation. React Compiler is not enabled.
  {
    files: [
      'src/domain/filesystem/policy.ts',
      'src/shared/schemas/index.ts',
      'src/domain/websites/policy.ts',
      'src/domain/websites/types.ts',
    ],
    rules: { 'no-control-regex': 'off' },
  },
)
