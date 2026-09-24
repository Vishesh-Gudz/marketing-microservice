# ADR 0001 — Convex as backend, database and API layer

- Status: accepted
- Date: 2026-09-24

## Context

The Marketing Microservice has to store multi-tenant marketing data, run background syncs against
Meta and Google APIs, receive webhooks and OAuth callbacks, and expose a stable API to its own
dashboard and to other applications. The mentor explicitly ruled out a separate REST layer.

## Decision

Use Convex for all of it:

- **Database:** Convex tables and indexes.
- **API:** versioned public Convex functions in `convex/v1/`, called with Convex clients
  (`ConvexReactClient`, `ConvexHttpClient`, `ConvexClient`) or Convex's built-in HTTP API.
- **Background work:** scheduled functions, crons, and Convex components (Workpool, rate limiter).
- **External I/O:** actions for outbound API calls; HTTP actions only where an inbound URL is
  unavoidable (OAuth callbacks, webhooks).
- **Auth:** Convex custom JWT providers verify tokens issued by parent applications. No auth system
  inside this service.

Next.js is only the dashboard host. It has no API routes and no server-side data layer.

## Consequences

- No PostgreSQL, Redis, Kafka, BullMQ, Express/Fastify, TanStack Query, or user-auth provider.
- Design within Convex limits:
  - per-transaction read/write caps and short query/mutation budgets, so pre-aggregate into rollup
    tables and batch writes
  - a 10-minute action limit, so sync fetches one page per action
  - `"use node"` files can't export queries or mutations
- Parent applications integrate through the same `v1` contract the dashboard uses.
