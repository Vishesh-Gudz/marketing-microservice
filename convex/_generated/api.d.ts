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
import type * as mapping_ads from "../mapping/ads.js";
import type * as mapping_resolver from "../mapping/resolver.js";
import type * as mapping_scope from "../mapping/scope.js";
import type * as providers_capabilities from "../providers/capabilities.js";
import type * as providers_errors from "../providers/errors.js";
import type * as providers_hash from "../providers/hash.js";
import type * as providers_index from "../providers/index.js";
import type * as providers_mock_credential from "../providers/mock/credential.js";
import type * as providers_mock_flavor from "../providers/mock/flavor.js";
import type * as providers_mock_generator from "../providers/mock/generator.js";
import type * as providers_mock_google from "../providers/mock/google.js";
import type * as providers_mock_index from "../providers/mock/index.js";
import type * as providers_mock_meta from "../providers/mock/meta.js";
import type * as providers_mock_scenarios from "../providers/mock/scenarios.js";
import type * as providers_pagination from "../providers/pagination.js";
import type * as providers_registry from "../providers/registry.js";
import type * as providers_types from "../providers/types.js";
import type * as providers_validate from "../providers/validate.js";
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
  "mapping/ads": typeof mapping_ads;
  "mapping/resolver": typeof mapping_resolver;
  "mapping/scope": typeof mapping_scope;
  "providers/capabilities": typeof providers_capabilities;
  "providers/errors": typeof providers_errors;
  "providers/hash": typeof providers_hash;
  "providers/index": typeof providers_index;
  "providers/mock/credential": typeof providers_mock_credential;
  "providers/mock/flavor": typeof providers_mock_flavor;
  "providers/mock/generator": typeof providers_mock_generator;
  "providers/mock/google": typeof providers_mock_google;
  "providers/mock/index": typeof providers_mock_index;
  "providers/mock/meta": typeof providers_mock_meta;
  "providers/mock/scenarios": typeof providers_mock_scenarios;
  "providers/pagination": typeof providers_pagination;
  "providers/registry": typeof providers_registry;
  "providers/types": typeof providers_types;
  "providers/validate": typeof providers_validate;
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
