import js from "@eslint/js";
import pluginImport from "eslint-plugin-import";
import pluginN from "eslint-plugin-n";
import globals from "globals";
import configPrettier from "eslint-config-prettier";

export default [
  {
    ignores: ["node_modules/**", "dist/**", "coverage/**"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      import: pluginImport,
      n: pluginN,
    },
    settings: {
      node: {
        version: "18.17.0",
      },
    },
    rules: {
      ...pluginImport.configs.recommended.rules,
      ...pluginN.configs.recommended.rules,
      "import/no-unresolved": "off",
      "n/no-missing-require": "off",
      "n/no-unpublished-import": "off",
      "n/no-unpublished-require": "off",
      "n/no-process-exit": "off",
      "n/no-unsupported-features/node-builtins": "off",
      "no-console": "off",
    },
  },
  {
    files: ["frontend/**/*.js"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "script",
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
