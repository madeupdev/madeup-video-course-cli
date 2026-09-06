import { defineConfig, globalIgnores } from "eslint/config";
import nx from "@nx/eslint-plugin";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

const boundaryOptions = {
  enforceBuildableLibDependency: false,
  allow: [],
  depConstraints: [
    {
      sourceTag: "type:app",
      onlyDependOnLibsWithTags: [
        "type:contract",
        "type:domain",
        "type:data-access",
        "type:ui",
      ],
    },
    {
      sourceTag: "type:contract",
      onlyDependOnLibsWithTags: ["type:contract"],
    },
    {
      sourceTag: "type:domain",
      onlyDependOnLibsWithTags: ["type:contract", "type:domain"],
    },
    {
      sourceTag: "type:data-access",
      onlyDependOnLibsWithTags: [
        "type:contract",
        "type:domain",
        "type:data-access",
      ],
    },
    {
      sourceTag: "type:ui",
      onlyDependOnLibsWithTags: ["type:contract", "type:ui"],
    },
    {
      sourceTag: "type:test",
      onlyDependOnLibsWithTags: [
        "type:app",
        "type:contract",
        "type:domain",
        "type:data-access",
        "type:ui",
        "type:test",
      ],
    },
    {
      sourceTag: "runtime:browser",
      onlyDependOnLibsWithTags: ["runtime:browser", "runtime:universal"],
    },
    {
      sourceTag: "runtime:server",
      onlyDependOnLibsWithTags: ["runtime:server", "runtime:universal"],
    },
    {
      sourceTag: "runtime:universal",
      onlyDependOnLibsWithTags: [
        "runtime:browser",
        "runtime:server",
        "runtime:universal",
      ],
    },
    {
      sourceTag: "scope:storefront",
      onlyDependOnLibsWithTags: [
        "scope:storefront",
        "scope:rental",
        "scope:shared",
      ],
    },
    {
      sourceTag: "scope:rental",
      onlyDependOnLibsWithTags: ["scope:rental", "scope:shared"],
    },
    {
      sourceTag: "scope:shared",
      onlyDependOnLibsWithTags: ["scope:shared"],
    },
  ],
};

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  ...nx.configs["flat/base"],
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    settings: {
      next: {
        rootDir: "apps/storefront",
      },
    },
    rules: {
      "@nx/enforce-module-boundaries": ["error", boundaryOptions],
    },
  },
  {
    files: [
      "tests/**/*.{ts,tsx}",
      "apps/storefront/tests/**/*.{ts,tsx}",
      "apps/api-e2e/src/**/*.{ts,tsx}",
    ],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          ...boundaryOptions,
          allow: [
            "@madeup-video/testing",
            "../../../../tests/helpers/*",
            "../../../tests/helpers/*",
            "../../api/src/app/*",
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/storefront/playwright.config.ts",
      "apps/admin-e2e/playwright.config.ts",
    ],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        { ...boundaryOptions, allow: ["../../tests/helpers/*"] },
      ],
    },
  },
  {
    files: ["libs/database/src/lib/database.ts"],
    rules: {
      "@nx/enforce-module-boundaries": [
        "error",
        {
          ...boundaryOptions,
          allow: ["../../../../generated/prisma/client"],
        },
      ],
    },
  },
  globalIgnores([
    "apps/storefront/.next/**",
    "dist/**",
    ".nx/**",
    "coverage/**",
    "generated/prisma/**",
    "next-env.d.ts",
  ]),
]);
