import js from "@eslint/js";
import pluginImport from "eslint-plugin-import";
import pluginN from "eslint-plugin-n";
import pluginTypeScript from "@typescript-eslint/eslint-plugin";
import parserTypeScript from "@typescript-eslint/parser";
import globals from "globals";
import configPrettier from "eslint-config-prettier";
// import importResolver from "eslint-import-resolver-typescript";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },

  js.configs.recommended,

  {
    files: ["src/**/*.{js,ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module", // 👈 Use module for Bun/Next/ESM
      parser: parserTypeScript,
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: pluginImport,
      n: pluginN,
      "@typescript-eslint": pluginTypeScript,
    },
    settings: {
      // --- 👇 Add proper resolver for TS + Bun ---
      "import/resolver": {
        typescript: {}, // resolves .ts/.tsx paths
        node: {
          extensions: [".js", ".jsx", ".ts", ".tsx"],
        },
      },
      node: {
        version: "20.19.5",
      },
    },
    rules: {
      ...pluginImport.configs.recommended.rules,
      ...pluginN.configs.recommended.rules,
      ...pluginTypeScript.configs.recommended.rules,

      // --- Disable problematic Node rules ---
      "n/no-missing-import": "off", // 👈 This was causing your error
      "n/no-missing-require": "off",
      "n/no-unpublished-import": "off",
      "n/no-unpublished-require": "off",
      "n/no-process-exit": "off",
      "n/no-unsupported-features/node-builtins": "off",

      // --- General style and safety ---
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": ["warn"],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-var-requires": "off",
    },
  },

  // --- Frontend config remains same ---
  {
    files: ["frontend/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      import: pluginImport,
    },
    rules: {
      ...pluginImport.configs.recommended.rules,
      "import/no-unresolved": "off",
    },
  },

  configPrettier,
];
