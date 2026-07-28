import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/generated/**",
      "**/coverage/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/.expo/**",
      "third_party/**",
    ],
  },

  eslint.configs.recommended,

  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: ["runtime/**/*.ts", "runtime/**/*.tsx"],

    languageOptions: {
      parserOptions: {
        project: ["./runtime/tsconfig.json", "./runtime/tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },

      globals: {
        ...globals.node,
      },
    },

    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],

      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },

  {
    files: ["shell/**/*.ts", "shell/**/*.tsx"],

    languageOptions: {
      parserOptions: {
        project: ["./shell/tsconfig.json"],
        tsconfigRootDir: import.meta.dirname,
      },

      globals: {
        ...globals.browser,
        ...globals.es2021,
      },
    },

    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          prefer: "type-imports",
          fixStyle: "inline-type-imports",
        },
      ],

      "@typescript-eslint/no-import-type-side-effects": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/no-confusing-void-expression": "off",
    },
  },

  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    extends: [tseslint.configs.disableTypeChecked],

    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
);
