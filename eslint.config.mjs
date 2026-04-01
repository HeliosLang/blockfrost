// @ts-check

import eslint from "@eslint/js"
import { defineConfig, globalIgnores } from "eslint/config"
import stylistic from "@stylistic/eslint-plugin"
import tseslint from "typescript-eslint"

export default defineConfig(
  globalIgnores(["node_modules/*", "dist/*", "types/*", "*.mjs"]),
  eslint.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  stylistic.configs["disable-legacy"],
  stylistic.configs.customize({
    jsx: false,
    indent: 2,
    quotes: "double",
    semi: false,
    commaDangle: "never",
    arrowParens: false,
    braceStyle: "1tbs",
    blockSpacing: true,
    quoteProps: "as-needed"
  }),
  {
    languageOptions: {
      globals: {
        TextDecoder: "readonly",
        TextEncoder: "readonly"
      },
      parserOptions: {
        projectService: true
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { caughtErrors: "none", argsIgnorePattern: "^_" }
      ],
      "@typescript-eslint/strict-boolean-expressions": "error"
    }
  }
)
