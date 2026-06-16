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
      "sdk/**",
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
      // React-Compiler-era hooks checks (react-hooks v6 via
      // eslint-config-next 16) run at their default ERROR severity —
      // the flagged patterns (refs during render, setState in effects,
      // impure render) have all been reworked.
      //
      // `incompatible-library` is informational only: it reports that
      // the React Compiler skips files using @tanstack/react-table.
      // This project does not use the compiler, so the notice is noise.
      "react-hooks/incompatible-library": "off",
    },
  },
);
