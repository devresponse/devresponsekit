// ESLint flat config for Next.js 16 App Router.
//
// We avoid `FlatCompat` + `eslint-config-next` chaining because that
// combination triggers a circular-JSON serialization error in
// @eslint/eslintrc 3.3 with the current shareable config snapshot. We
// instead apply a focused subset of TypeScript/React lint rules that
// match the project conventions; deeper Next-specific rules can be
// re-added once the upstream incompatibility is resolved.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "dist/**",
      "src/db/schema/generated.ts",
      "coverage/**",
      "playwright-report/**",
      "test-results/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": ["warn", { prefer: "type-imports" }],
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
