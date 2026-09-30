# convex/domain

Canonical, platform-independent domain model (Phase 2). See [docs/data-model.md](../../docs/data-model.md).

- `types.ts`: platforms, levels, placements, statuses, objectives, action types (const arrays + types)
- `validators.ts`: Convex validators derived from those arrays
- `metrics.ts`: metric catalog (kind, additivity) + metric column validators
- `identity.ts`: canonical external-id forms and natural keys

Table definitions live in `convex/tables/`.
