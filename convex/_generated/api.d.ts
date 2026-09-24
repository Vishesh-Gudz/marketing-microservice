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
import type * as domain_identity from "../domain/identity.js";
import type * as domain_metrics from "../domain/metrics.js";
import type * as domain_types from "../domain/types.js";
import type * as domain_validators from "../domain/validators.js";
import type * as health from "../health.js";
import type * as lib_audit from "../lib/audit.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_authIssuers from "../lib/authIssuers.js";
import type * as lib_dates from "../lib/dates.js";
import type * as lib_dto from "../lib/dto.js";
import type * as lib_errors from "../lib/errors.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as lib_validation from "../lib/validation.js";
import type * as tables_ads from "../tables/ads.js";
import type * as tables_common from "../tables/common.js";
import type * as tables_metrics from "../tables/metrics.js";
import type * as tables_social from "../tables/social.js";
import type * as tables_tenancy from "../tables/tenancy.js";
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
  "domain/identity": typeof domain_identity;
  "domain/metrics": typeof domain_metrics;
  "domain/types": typeof domain_types;
  "domain/validators": typeof domain_validators;
  health: typeof health;
  "lib/audit": typeof lib_audit;
  "lib/auth": typeof lib_auth;
  "lib/authIssuers": typeof lib_authIssuers;
  "lib/dates": typeof lib_dates;
  "lib/dto": typeof lib_dto;
  "lib/errors": typeof lib_errors;
  "lib/money": typeof lib_money;
  "lib/tenancy": typeof lib_tenancy;
  "lib/validation": typeof lib_validation;
  "tables/ads": typeof tables_ads;
  "tables/common": typeof tables_common;
  "tables/metrics": typeof tables_metrics;
  "tables/social": typeof tables_social;
  "tables/tenancy": typeof tables_tenancy;
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
