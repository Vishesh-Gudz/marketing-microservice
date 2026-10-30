# convex/inbox

Unified messaging inbox: an index of the channels' conversations (WhatsApp, Instagram DMs; Facebook Page messages later), never a copy of their messages. Design: [ADR 0018](../../docs/adr/0018-unified-inbox.md).

- `threads.ts` (IM7.2): `touchThread` / `removeThread`, called by the channels in the same transaction as their conversation writes; the operator `backfill` and `check`.
- The read API is `convex/v1/inbox.ts` (`v1/inbox:listThreads`, IM7.3); the dashboard page is `/inbox` (IM7.4, `components/dashboard/views/inbox-view.tsx`).
