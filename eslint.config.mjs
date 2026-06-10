// ESLint flat config for Next.js 16 App Router.
//
// eslint-config-next 16 is flat-config native, so we compose it
// directly with the typescript-eslint recommended set and the project's
// own rule tweaks. No FlatCompat needed.
import nextConfig from "eslint-config-next";
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
  ...nextConfig,
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
      // React-Compiler-era hooks checks (new in react-hooks v6 via
      // eslint-config-next 16). Several pre-existing patterns — mostly
      // in vendored shadcn/ui primitives — trip them. Keep the findings
      // visible as warnings rather than blocking the lint gate; tighten
      // back to errors as the flagged components get reworked.
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
);
