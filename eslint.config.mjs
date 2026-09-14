import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/.cache/**",
      "**/.expo/**",
      "**/.next/**",
      "**/.parcel-cache/**",
      "**/.pnpm-store/**",
      "**/.pytest_cache/**",
      "**/.ruff_cache/**",
      "**/.turbo/**",
      "**/__pycache__/**",
      "**/build/**",
      "**/coverage/**",
      "**/DerivedData/**",
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
      "**/out/**",
      "**/Pods/**",
      "**/release/**",
      "**/target/**",
    ],
  },

  eslint.configs.recommended,

  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    files: [
      "runtime/src/**/*.ts",
      "graphics/*/src/**/*.ts",
      "input/src/**/*.ts",
      "hosts/*/src/**/*.ts",
      "frameworks/*/src/**/*.ts",
      "shell/core/src/**/*.ts",
      "shell/desktop/src/**/*.ts",
      "applications/shell/**/*.ts",
      "applications/shell/**/*.tsx",
      "applications/*/src/**/*.ts",
      "applications/*/src/**/*.tsx",
      "sdk/*/src/**/*.ts",
      "sdk/*/src/**/*.tsx",
      "tools/*/src/**/*.ts",
    ],

    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ["shell/mobile/src/**/*.ts", "shell/mobile/src/**/*.tsx"],

    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  {
    files: ["**/*.js", "**/*.mjs"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["applications/**/*.{ts,tsx}", "examples/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@sevynos/react-native/internal",
                "@sevynos/react-native/internal/*",
              ],
              message: "Applications may use only the public @sevynos/react-native API.",
            },
            {
              group: [
                "@sevynos/runtime",
                "@sevynos/runtime/*",
                "@sevynos/desktop-host",
                "@sevynos/desktop-host/*",
                "electron",
                "node:*",
              ],
              message:
                "Sevyn applications cannot import host or unrestricted runtime APIs.",
            },
          ],
        },
      ],
    },
  },
);
