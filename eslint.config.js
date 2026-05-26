// ESLint flat config. Keeps the rule surface tight on purpose:
// typescript-eslint's `recommended` set, plus a permissive
// no-unused-vars that allows underscore-prefixed args (hook handlers
// often ignore ctx).
//
// Why not strict-type-checked: we cast `unknown` at SDK boundaries
// deliberately (see index.ts hook payload handling) and strict-type-
// checked floods on those. The recommended set catches the bugs we
// actually want to catch.

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        NodeJS: "readonly",
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Empty catch is an intentional best-effort cleanup pattern in
      // service.ts shutdown paths.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
);
