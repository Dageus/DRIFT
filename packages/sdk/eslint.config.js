import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// Two tiers, matching the boundary vitest.unit.config.ts already draws: `src/` (shipped) and
// `test/local/**` + `test/merkle-alignment.test.ts` + `test/setup.ts` (hermetic, CI-run) get full
// type-aware linting. `test/e2e/**`, `test/scripts/**`, `test/fixtures/**`, `test/scenarios/**`
// are live-chain-dependent tooling that trades strictness for iteration speed elsewhere in this
// codebase too — same call here, not a new exception.
const strictTier = ['src/**/*.ts', 'test/local/**/*.ts', 'test/merkle-alignment.test.ts', 'test/setup.ts'];
const relaxedTier = [
  'test/e2e/**/*.ts',
  'test/scripts/**/*.ts',
  'test/fixtures/**/*.ts',
  'test/scenarios/**/*.ts',
  // Runnable, live-service-dependent (IPFS/chain), documentation-by-example — same tier as
  // e2e/scripts above, not part of the published package.
  'examples/**/*.ts'
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'docs/**', 'drift-trees/**', 'drift-trust/**'] },
  js.configs.recommended,
  {
    files: strictTier,
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // The two rules this pass exists for: no-explicit-any would have caught the whole `: any`
      // bug class this SDK already went through once; no-floating-promises catches an unhandled
      // rejection at compile time instead of a silent unhandled-rejection at runtime.
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',

      // Several stores/providers are deliberately `Promise`-returning even when today's backend
      // (sync fs/localStorage) resolves immediately — the async signature is the actual interface
      // contract (ITrustStore, IMerkleStore, IAttestationProvider), kept stable so a genuinely
      // async backend (IPFS, S3, a remote API) can implement it without a breaking signature
      // change. Flagging every such method as "no-await" would fight the design, not improve it.
      '@typescript-eslint/require-await': 'off',

      // Deliberately relaxed for a package this size — real issues, not worth blocking on yet.
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off'
    }
  },
  {
    files: relaxedTier,
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }]
    }
  }
);
