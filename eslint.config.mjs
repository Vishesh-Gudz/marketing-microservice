import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

const CREDENTIALS_LITERAL = {
  selector: "Literal[value='credentials']",
  message: "Only convex/connections/credentialStore.ts may access the credentials table.",
};

const CANONICAL_TABLES =
  "adAccounts|campaigns|adGroups|ads|creatives|metricsDaily|actionMetricsDaily";
const CANONICAL_INSERT = {
  selector: `CallExpression[callee.property.name='insert'][arguments.0.value=/^(${CANONICAL_TABLES})$/]`,
  message:
    "Canonical ad/metric rows are written only by convex/sync/upsert.ts (natural-key upserts).",
};

const DECRYPT_IMPORT = {
  group: ["**/lib/crypto"],
  importNames: ["decryptJson"],
  message: "Decryption is only allowed in convex/connections/credentialStore.ts.",
};

/** May reference the credentials table / decrypt (still may not insert canonical rows). */
const CREDENTIAL_EXEMPT = [
  "convex/connections/credentialStore.ts",
  "convex/lib/crypto.ts",
  "convex/tables/**",
  "convex/schema.ts",
];

/** May insert canonical rows: the write path itself and test seeds (never deployed). */
const CANONICAL_WRITE_EXEMPT = ["convex/sync/upsert.ts", "convex/test.helpers.ts"];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
    },
  },
  // convex/v1 is the public contract: only tenancy wrappers from convex/lib/tenancy
  // may define functions here. Raw builders would bypass JWT/tenant resolution.
  {
    files: ["convex/v1/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/_generated/server"],
              importNames: [
                "query",
                "mutation",
                "action",
                "internalQuery",
                "internalMutation",
                "internalAction",
                "httpAction",
              ],
              message:
                "convex/v1 must use orgQuery/orgMutation/orgAdminMutation/authedMutation from convex/lib/tenancy.",
            },
          ],
          paths: [
            {
              name: "convex/server",
              importNames: [
                "queryGeneric",
                "mutationGeneric",
                "actionGeneric",
                "internalQueryGeneric",
                "internalMutationGeneric",
                "internalActionGeneric",
                "httpActionGeneric",
              ],
              message: "convex/v1 must use the tenancy wrappers from convex/lib/tenancy.",
            },
          ],
        },
      ],
    },
  },
  // Credentials (Phase 4): only convex/connections/credentialStore.ts may touch the
  // `credentials` table or decrypt. Everything else goes through withConnectionCredential.
  // Canonical writes (Phase 5): only convex/sync/upsert.ts may insert into the canonical
  // ad/metric tables (single natural-key write path). Both are `no-restricted-syntax`
  // selectors, so the file sets below combine them (a later config would override).
  {
    files: ["convex/**/*.ts"],
    ignores: [
      ...CREDENTIAL_EXEMPT,
      ...CANONICAL_WRITE_EXEMPT,
      "convex/_generated/**",
      "**/*.test.ts",
      "**/*.suite.ts",
    ],
    rules: {
      "no-restricted-syntax": ["error", CREDENTIALS_LITERAL, CANONICAL_INSERT],
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [DECRYPT_IMPORT] }],
    },
  },
  {
    files: CREDENTIAL_EXEMPT,
    ignores: ["**/*.test.ts", "**/*.suite.ts"],
    rules: { "no-restricted-syntax": ["error", CANONICAL_INSERT] },
  },
  {
    files: CANONICAL_WRITE_EXEMPT,
    ignores: ["**/*.test.ts", "**/*.suite.ts"],
    rules: {
      "no-restricted-syntax": ["error", CREDENTIALS_LITERAL],
      "@typescript-eslint/no-restricted-imports": ["error", { patterns: [DECRYPT_IMPORT] }],
    },
  },
  // No logging in the connection layer or the sync engine (credentials, codes, states,
  // cursors and provider payloads must never reach logs).
  {
    files: ["convex/connections/**/*.ts", "convex/sync/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "no-console": "error" },
  },
  // convex/providers and convex/mapping are pure: no database, no Convex function
  // builders, no tenancy runtime. Type-only imports (Doc/Id, Tenant) stay allowed.
  {
    files: ["convex/providers/**/*.ts", "convex/mapping/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/_generated/server", "**/_generated/api"],
              allowTypeImports: true,
              message:
                "Providers and mapping are database-free: no Convex function builders, ctx, or api references.",
            },
            {
              group: ["**/lib/tenancy", "**/lib/auth", "**/lib/audit"],
              allowTypeImports: true,
              message:
                "Providers and mapping are tenant-free at runtime; tenant identity only enters via mapping scopes.",
            },
            {
              group: ["convex/server", "convex-test", "convex/browser", "convex/react"],
              allowTypeImports: true,
              message: "Providers and mapping must not depend on Convex runtime or client APIs.",
            },
            DECRYPT_IMPORT,
          ],
        },
      ],
    },
  },
  // Must stay last: turns off stylistic rules that Prettier owns.
  prettier,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "convex/_generated/**",
    ".convex/**",
    "test-results/**",
    "playwright-report/**",
    "coverage/**",
    ".dev-keys/**",
  ]),
]);

export default eslintConfig;
