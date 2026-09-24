import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

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
