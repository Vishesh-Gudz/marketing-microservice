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

/**
 * D23 frontend allowlist (exact). Runtime: the generated public api and four pure,
 * secret-free modules. Type-only: the generated data model. Nothing else under convex/ may
 * cross the frontend boundary, not even as a type.
 */
const FRONTEND_RUNTIME_CONVEX = [
  "_generated/api",
  "lib/errors",
  "lib/money",
  "lib/dates",
  "analytics/periods",
];
const FRONTEND_TYPE_ONLY_CONVEX = ["_generated/dataModel"];
/** `@/convex/...`, `./convex/...` or `../../convex/...` */
const CONVEX_DIR = String.raw`^(?:@/|\./|(?:\.\./)+)convex`;

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
  // No logging in the connection layer, the sync engine or the providers (credentials,
  // codes, states, cursors, tokens and provider payloads must never reach logs; Phase 8 D27).
  {
    files: ["convex/connections/**/*.ts", "convex/sync/**/*.ts", "convex/providers/**/*.ts"],
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
  // Analytics (Phase 6) reads canonical tables only: never connections/credentials, the
  // sync write/worker path, or provider implementations (static capabilities via the
  // providers registry are allowed). No logging.
  {
    files: ["convex/analytics/**/*.ts", "convex/v1/analytics.ts", "convex/v1/dto/analytics.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-console": "error",
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "**/connections/**",
                "**/sync/worker",
                "**/sync/runs",
                "**/sync/upsert",
                "**/sync/planner",
                "**/sync/admin",
                "**/providers/mock",
                "**/providers/mock/**",
                "**/providers/meta",
                "**/providers/meta/**",
                "**/providers/oauth",
              ],
              message:
                "Analytics is query-time aggregation over canonical rows: no connections, credentials, sync writes or provider calls.",
            },
            DECRYPT_IMPORT,
          ],
        },
      ],
    },
  },
  // Dashboard (Phase 7, D23): the frontend consumes application data only through the
  // generated public API with `convex/react`. Exact allowlist for app/, components/, lib/
  // (tests included):
  //   runtime:   @/convex/_generated/api, convex/react, convex/lib/{errors,money,dates},
  //              convex/analytics/periods
  //   type-only: convex/server, convex/values, @/convex/_generated/dataModel
  // Everything else from convex/ or the convex package (e.g. analytics internals,
  // connections, sync, providers, admin, tables, schema, lib/crypto, convex/browser) is
  // forbidden, including type-only imports.
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}", "lib/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: `${CONVEX_DIR}(?:$|/(?!(?:${[...FRONTEND_RUNTIME_CONVEX, ...FRONTEND_TYPE_ONLY_CONVEX].join("|")})$))`,
              message:
                "Not on the frontend allowlist (D23). Use the generated api (api.v1.*) with convex/react; only convex/lib/{errors,money,dates} and convex/analytics/periods may be imported, and convex/_generated/dataModel as a type.",
            },
            {
              regex: `${CONVEX_DIR}/(?:${FRONTEND_TYPE_ONLY_CONVEX.join("|")})$`,
              allowTypeImports: true,
              message: "convex/_generated/dataModel is type-only in frontend code (D23).",
            },
            {
              regex: String.raw`^convex(?:$|/(?!(?:react|server|values)$))|^convex-(?:test|helpers)(?:$|/)`,
              message:
                "Frontend code may use convex/react at runtime and convex/server / convex/values as types only (D23).",
            },
          ],
          paths: ["convex/server", "convex/values"].map((name) => ({
            name,
            allowTypeImports: true,
            message: `${name} is type-only in frontend code (D23).`,
          })),
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
