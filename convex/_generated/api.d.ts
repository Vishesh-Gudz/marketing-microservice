/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_integrationApps from "../admin/integrationApps.js";
import type * as health from "../health.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_authIssuers from "../lib/authIssuers.js";
import type * as lib_dto from "../lib/dto.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as lib_validation from "../lib/validation.js";
import type * as v1_audit from "../v1/audit.js";
import type * as v1_dto_audit from "../v1/dto/audit.js";
import type * as v1_dto_org from "../v1/dto/org.js";
import type * as v1_orgs from "../v1/orgs.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/integrationApps": typeof admin_integrationApps;
  health: typeof health;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/authIssuers": typeof lib_authIssuers;
  "lib/dto": typeof lib_dto;
  "lib/errors": typeof lib_errors;
  "lib/tenancy": typeof lib_tenancy;
  "lib/validation": typeof lib_validation;
  "v1/audit": typeof v1_audit;
  "v1/dto/audit": typeof v1_dto_audit;
  "v1/dto/org": typeof v1_dto_org;
  "v1/orgs": typeof v1_orgs;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
