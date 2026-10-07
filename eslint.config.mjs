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
      "services/*/src/**/*.ts",
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
    // These files are explicit compatibility boundaries. They mirror dynamic
    // React Native and Expo APIs, including intentional no-op methods, so the
    // application-facing surface can remain source-compatible while native
    // implementations are added behind it. Keep the exemption narrowly scoped.
    files: [
      "frameworks/react-native/src/animated.ts",
      "frameworks/react-native/src/community-compat.ts",
      "frameworks/react-native/src/expo-modules-core.ts",
      "frameworks/react-native/src/fabric.ts",
      "frameworks/react-native/src/native-modules.ts",
      "frameworks/react-native/src/react-jsx-shim.ts",
      "frameworks/react-native/src/react-native-app-compat.test.ts",
      "frameworks/react-native/src/react-shim.ts",
      "frameworks/react-native/src/utilities.ts",
    ],
    rules: {
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-empty-function": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
      "@typescript-eslint/no-unnecessary-type-parameters": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      "@typescript-eslint/unbound-method": "off",
    },
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
