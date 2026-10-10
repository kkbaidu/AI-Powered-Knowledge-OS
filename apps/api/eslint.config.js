// @ts-check
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Import `config` from './config.js' instead of reading process.env directly.",
        },
      ],
    },
  },
  {
    files: ["src/config.ts"],
    rules: {
      "no-restricted-properties": "off",
    },
  },
  {
    ignores: ["dist/**"],
  }
);