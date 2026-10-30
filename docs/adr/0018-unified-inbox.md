# ADR 0018 — Unified messaging inbox

- Status: implemented, not validated. IM7.2 (the thread index, its write paths, backfill and
  check), IM7.3 (the read API `v1/inbox:listThreads`) and IM7.4 (the `/inbox` page) are
  implemented and tested in-process, and `/inbox` was checked in a browser against a local mock
  deployment. Facebook Page messages (Messenger) are a separate track, M1–M6, gated on Meta
  approvals. Each checkpoint needs explicit approval.
- Date: 2026-10-30

## Context

The service has two messaging channels, built separately and both tested in-process only:

|              | WhatsApp ([ADR 0013](0013-whatsapp-inbox.md), [0014](0014-whatsapp-connections.md), [0015](0015-whatsapp-messaging.md)) | Instagram DMs ([ADR 0017](0017-instagram-messaging.md))                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Account      | `whatsappPhoneNumbers` (one org per number)                                                                             | `instagramMessagingAccounts` (one org per Instagram account)                                                                         |
| Conversation | `whatsappConversations` (`numberId`, `contactWaId`, `contactName`, `lastInboundAt`, `lastMessageAt`)                    | `instagramConversations` (`messagingAccountId`, `contactIgsid`, `contactUsername` / `contactName`, `lastInboundAt`, `lastMessageAt`) |
| Messages     | `whatsappMessages` (statuses up to `delivered`, templates)                                                              | `instagramMessages` (no delivery receipt; echoes, edits, deletions)                                                                  |
| List order   | `by_org_last_message` (`orgId`, `lastMessageAt`), newest first, account joined per page                                 | the same                                                                                                                             |
| Read API     | `v1/whatsapp:listConversations`, `getConversation`, `listMessages` (viewer)                                             | `v1/instagramMessaging:listConversations`, `getConversation`, `listMessages` (viewer)                                                |
| Send         | `sendText` (editor), `sendTemplate` (editor); 4,096 characters; 24-hour service window, templates outside it            | `sendText` (editor); 1,000 UTF-8 bytes; 24-hour window, nothing outside it; `replyBlocker`                                           |
| Privacy      | the DTO carries the customer's phone number (`contactWaId`), shown as `+<number>` without a name                        | the customer's IGSID never leaves the server                                                                                         |
| Retention    | conversations and messages are never deleted (docs/whatsapp.md)                                                         | deleted 30 days after messaging stops (D14) and at once on a Meta data-deletion request                                              |
| Pages        | `/whatsapp`, `/whatsapp/conversations/[id]`, `/whatsapp/settings`                                                       | `/instagram/messages`, `/instagram/messages/conversations/[id]`, `/instagram/messages/settings`                                      |
| Gate         | connections: `WHATSAPP_CONNECTIONS_ENABLED`                                                                             | `INSTAGRAM_MESSAGING_ENABLED`                                                                                                        |

Conversation recency is written in four functions only (six statements): WhatsApp
`processing.ts` (insert and patch) and `outbound.ts` (a queued reply or template); Instagram
`messaging/processing.ts` (insert and patch) and `messaging/outbound.ts`. Only Instagram
`messaging/purge.ts` deletes conversations. The roadmap reserved a "unified inbox" for Phase 11 (`convex/inbox/README.md`,
`docs/data-model.md`), and the Instagram DM plan (D17) deferred it. The goal now: one inbox across
WhatsApp, Instagram DMs and later Facebook Page messages, keeping each channel's own behaviour,
permissions and privacy rules.

## Decisions

### Unified inbox (IM7.2–IM7.4)

1. **Channels stay authoritative.** Each channel keeps its tables, webhook and ingestion,
   sending, reply-window rules, statuses, retention, roles and privacy. The inbox adds an index
   over their conversations; it never copies messages or conversation content, and it never
   sends.
2. **A thread index, `inboxThreads` (IM7.2), one row per channel conversation.** Fields:
   `orgId`, `channel` (`whatsapp` | `instagram`; `messenger` added by M1), exactly one typed
   reference (`whatsappConversationId` or `instagramConversationId`, matching `channel`),
   `lastMessageAt` (the conversation's, the sort key), `createdAt`, `updatedAt`. No contact name,
   phone number, username, IGSID, message text or preview: labels and reply state are read from
   the channel's own rows at query time, so purges and privacy rules stay in one place. Indexes,
   all org-first (no new global index): `by_org_last_message` (`orgId`, `lastMessageAt`),
   `by_org_channel_last_message` (`orgId`, `channel`, `lastMessageAt`),
   `by_org_whatsapp_conversation`, `by_org_instagram_conversation` (for the upsert).
3. **Maintained in the same transaction as the conversation.** One helper module
   (`convex/inbox/threads.ts`): `touchThread` upserts the row by its typed reference and sets
   `lastMessageAt` to the conversation's; `removeThread` deletes it. Called after each of the six
   writes above that create a conversation or move its `lastMessageAt`, and `removeThread`
   before Instagram's purge deletes a conversation. WhatsApp never deletes
   conversations, so its rows are never removed. A thread write never changes a channel's
   behaviour; it is one extra write per conversation update.
4. **Backfill and consistency (IM7.2).** An internal, idempotent, paged migration
   (`inbox/threads:backfill`, run once per deployment with `npx convex run`, resumable from its
   cursor) creates the missing rows from both conversation tables. An internal check
   (`inbox/threads:check`, paged) reports conversations without a row, rows without a
   conversation, and a `lastMessageAt` that differs; the backfill also repairs those. Invariants
   tested: exactly one row per conversation, the same `lastMessageAt`, the row's org and channel
   equal to the conversation's, and no row left after an Instagram purge. Production (where the
   WhatsApp inbox is deployed) needs the backfill at the IM7.2 deploy.

   As built: the backfill walks three phases, `whatsapp` (conversations), `instagram`
   (conversations), `threads` (rows), `batch` rows (default 100) per transaction, each step
   scheduling the next (`chain: false` runs one page and returns `continueCursor` and `phase` to
   resume from). Per conversation it creates the missing row, sets a stale `lastMessageAt` and
   deletes duplicates; per row it deletes an orphan (conversation gone, another org, or a
   reference that does not match `channel`). The check takes the same `phase` / `cursor` /
   `batch` and returns the conversation ids that are `missing`, `stale` or `duplicated` and the
   `orphaned` row ids: Convex ids only. Thread lookups only take rows of the reference's own
   channel, so a malformed row is never updated in place of the real one.

   Operator commands (per deployment, after the IM7.2 deploy):

   ```bash
   npx convex run inbox/threads:backfill '{}'
   npx convex run inbox/threads:check '{"phase":"whatsapp"}'
   ```

   Follow each `continueCursor` until `isDone`, then the phases `instagram` and `threads`; every
   list must be empty before IM7.3 is released.

5. **Read API `v1/inbox:listThreads` (IM7.3), viewer and up.** Paginated, newest first, optional
   `channel` filter (the channel index). Each row loads its conversation and account under the
   caller's org (`getOwned` semantics; a row whose conversation is gone is skipped) and returns
   a unified DTO: `id` (the thread), `channel`, `conversationId` (for the channel's own pages and
   APIs), `accountLabel`, `contactLabel`, `lastMessageAt`, `lastInboundAt`, `replyState`
   (`open` | `closed` | `unavailable`) and `replyWindowExpiresAt`. Per-channel rules: WhatsApp
   labels the contact by name, else its phone number (as `/whatsapp` does today); Instagram by
   `@username`, else name, else "Instagram user", never the IGSID; `unavailable` reuses
   Instagram's `replyBlocker` and WhatsApp's number status. The existing channel APIs are
   unchanged; detail, history and sending stay there, with their own role checks.

   As built (`convex/v1/inbox.ts`, DTO `convex/v1/dto/inbox.ts`): `orgQuery` (viewer and up),
   args `paginationOpts` (clamped to 100) and `channel?`; the org's thread index newest first
   (or its channel index). Labels: WhatsApp contact `contactName`, else `+<phone>`; account the
   number's display phone number, else "WhatsApp number" (never Meta's phone number id).
   Instagram contact `@username`, else name, else "Instagram user"; account `@username`, else
   name, else "Instagram account". `replyState`: `unavailable` when the channel's own sender
   check refuses (WhatsApp `whatsapp/outbound.ts senderOf`; Instagram `replyBlockerOf`, moved
   to `instagram/messaging/outbound.ts` and now shared with `v1/instagramMessaging`), else
   `open` / `closed` from the shared 24-hour window (`messaging/window.ts`); a conversation the
   customer never wrote in is `closed`. A skipped row (conversation gone, another org's,
   malformed) makes a page shorter, never wrong. `replyState` is evaluated when the query runs
   and is not re-evaluated as time passes: clients compare `replyWindowExpiresAt` with their own
   clock (as the channel pages do), and each channel's send endpoint decides again.

   ```json
   {
     "page": [
       {
         "id": "<thread id>",
         "channel": "instagram",
         "conversationId": "<instagram conversation id>",
         "accountLabel": "@shop",
         "contactLabel": "@ana.lisboa",
         "lastMessageAt": "2026-10-30T12:01:01.000Z",
         "lastInboundAt": "2026-10-30T12:01:01.000Z",
         "replyState": "open",
         "replyWindowExpiresAt": "2026-10-31T12:01:01.000Z"
       },
       {
         "id": "<thread id>",
         "channel": "whatsapp",
         "conversationId": "<whatsapp conversation id>",
         "accountLabel": "+1 555-000-0001",
         "contactLabel": "Ana",
         "lastMessageAt": "2026-10-30T12:00:01.000Z",
         "replyState": "unavailable"
       }
     ],
     "isDone": true,
     "continueCursor": "<cursor>"
   }
   ```

6. **Dashboard `/inbox` (IM7.4).** Nav item "Inbox"; one list across channels with a channel
   filter, a channel badge per row, and the reply state; each row links to the channel's
   existing conversation page (`/whatsapp/conversations/[id]`,
   `/instagram/messages/conversations/[id]`), where the channel-specific composer stays
   (templates for WhatsApp, the byte counter for Instagram). The per-channel pages and nav items
   stay until a later decision; no route is removed or changed.

   As built (`app/(dashboard)/inbox/page.tsx`, `components/dashboard/views/inbox-view.tsx`,
   `lib/inbox/threads.ts`): the nav item "Inbox" comes before "WhatsApp" and "Instagram DMs";
   the channel filter is a single-choice toggle (All / WhatsApp / Instagram, a choice always
   kept) held in the page's state, and changing it reloads the list (25 per page, "Show more
   conversations"). Each row shows the channel badge, the contact and account labels, the reply
   state and the time. The reply state is re-checked on the browser's clock every 30 seconds:
   an `open` thread whose `replyWindowExpiresAt` has passed shows as closed; `closed` and
   `unavailable` are never upgraded. The page reads `v1/inbox:listThreads` only.

7. **Tenancy and authorization.** Every inbox read and write is under the row's own `orgId`
   through org-first indexes; nothing in the inbox is reachable across orgs, and the thread
   index adds no new authorization path: listing is viewer-level like both channels' lists, and
   every action stays behind the channel's own endpoint.

### Facebook Page messages (Messenger, M1–M6): design note

Facts from Meta's documentation, read 2026-10-30, marked [doc] (Messenger Platform pages under
developers.facebook.com/documentation/business-messaging/messenger-platform; Embedded Signup
under …/business-messaging/whatsapp/embedded-signup; Facebook Login for Business); anything
else is [assume] or unknown:

- **Onboarding is Facebook Login for Business, not Embedded Signup.** Embedded Signup (v4; v5
  since 2026-10-20, which replaces `waba_id` with `messaging_account_ids`) onboards WhatsApp and
  lists only ads products for Pages and Instagram accounts [doc]. Facebook Login for Business is
  "the preferred authentication and authorization solution for tech providers" [doc]; a
  configuration (`config_id`) chooses user or business-integration system-user tokens [doc].
- **Permissions:** `pages_messaging`, `pages_show_list`, `business_management` and
  `pages_manage_metadata` [doc]. Other businesses' Pages need Tech Provider status, App Review
  for Advanced Access and business verification [doc]. The `HUMAN_AGENT` tag (7 days after the
  customer's last message) needs separate approval [search index only].
- **Tokens and subscription:** Page tokens from `GET /{user-id}/accounts` with a user token;
  long-lived Page tokens do not expire [doc]. `POST /{page-id}/subscribed_apps` with
  `subscribed_fields` and the Page token [doc]. A Page token from a system-user token is not
  documented.
- **Webhook:** `object: "page"`, `entry[].messaging[]` with Page-scoped `sender.id` (PSID) and
  `recipient.id` (the Page); `X-Hub-Signature-256` with the app secret [doc]. Fields include
  `messages`, `message_echoes`, `message_deliveries`, `message_reads`, `message_edits` [doc].
  Failing deliveries for an hour disable the webhook and unsubscribe the Page [doc].
- **Send:** `POST /{page-id}/messages`, `messaging_type` RESPONSE / UPDATE / MESSAGE_TAG /
  UTILITY [doc]; 24-hour standard window [doc]; text under 2,000 characters [search index only].
  Delivery and read come as watermarks [doc]. The Meta Business Suite inbox is "another
  application connected to your page"; replies must be coordinated, and `standby` events must
  not be answered [doc].

Design (each a later decision of its checkpoint, recorded here so IM7.2 leaves room):

- **M1 data model:** `messengerPages` (one org per Page, the WhatsApp/Instagram holder rule and
  activation cutoff), `messengerWebhookEvents`, `messengerConversations` (contact = PSID, never
  shown), `messengerMessages` (statuses up to `delivered` and `read` from watermarks);
  `inboxThreads` gains `channel: "messenger"` and `messengerConversationId`.
- **M2 connection:** a new provider through a Facebook Login for Business configuration with the
  Page permissions; Page discovery and selection; Page tokens stored encrypted per Page;
  `subscribed_apps` per Page; disconnect and the deauthorize / data-deletion callbacks for the
  Facebook Login app (IM6's signed-request module generalized; they then also cover Meta Ads
  data, still open in docs/providers/meta.md).
- **M3 webhook and ingest:** `/messenger/webhook`, a dedicated signing-secret variable with no
  fallback, the IM2 pipeline (verified bytes, idempotent per-org events, bounded processing),
  echoes from the Business Suite inbox stored as outbound with origin `page`.
- **M4 send:** `RESPONSE` inside the 24-hour window; `HUMAN_AGENT` only behind a flag after Meta
  approves it; no automatic retry (the IM4 pattern).
- **M5 retention:** the D14 rules (grace period, purge, data-deletion request at once).
- **M6 inbox and UI:** the channel joins `inboxThreads`, `listThreads` and `/inbox`.
- **Unknown until a real Page:** whether a system-user token can read Page tokens, the
  `timestamp` unit, the exact error codes for a closed window, resubscription after Meta disables
  a webhook, and how Business Suite shows replies sent through the app.

## Alternatives rejected

- **Merging the channel lists at query time** (no index): Convex allows one paginated query per
  function, so a merged cursor over two or three tables needs hand-made cursors, and page
  boundaries move as messages arrive (no stable reactive pagination).
- **Copying contact labels or a message preview into the index:** duplicates personal data and
  every purge, retention and privacy rule would have to cover it too.
- **Database triggers (`convex-helpers` Triggers):** every mutation builder that writes
  conversations would have to be wrapped; the few explicit call sites are simpler to review.
- **One shared conversations/messages table for all channels:** rewrites two tested channels and
  mixes incompatible statuses, limits and privacy rules.
- **Onboarding Messenger through Embedded Signup:** not supported for Page messaging [doc].

## Consequences

- IM7.2 touches shared channel code at the four recency functions and Instagram's purge, one
  extra write each; WhatsApp and Instagram tests must stay green unchanged, plus the invariant tests.
- Every deployment with conversations needs the IM7.2 backfill before IM7.3's list is trusted;
  the check query is the release gate.
- A thread write that fails fails its conversation write too (same transaction): drift is only
  possible through code that bypasses the helper, which the check query detects.
- The inbox list costs one conversation read and at most one account read per row (25 per page).
- The Messenger track needs, before any live use: business verification, Tech Provider
  approval, App Review for `pages_messaging` and its dependencies, a Facebook Login for Business
  configuration, and a real Page; HUMAN_AGENT needs its own approval.
