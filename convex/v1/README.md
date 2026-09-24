# convex/v1 — public integration contract

Only versioned, integration-facing Convex functions live here (`api.v1.*`). Used by the dashboard, the `@<company>/marketing-client` SDK and parent applications.

Rules (from Phase 1): tenant-aware wrappers only, `args` + `returns` validators, DTOs never raw documents, cursor pagination. Breaking changes go to `convex/v2/`.
