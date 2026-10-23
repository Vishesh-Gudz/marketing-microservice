# WhatsApp inbox

Multi-tenant WhatsApp inbox on the WhatsApp Cloud API. Decisions: [ADR 0013](adr/0013-whatsapp-inbox.md).

**Status:** Stage 1, the inbound webhook slice, is implemented and tested in-process with signed
fake deliveries. Embedded Signup (connecting a number), outbound replies, templates, quick
replies and the dashboard are not implemented. Nothing has been verified against real Meta.

## Webhook

URL: `<CONVEX_SITE_URL>/whatsapp/webhook`.

| Request                  | Result                                                                 |
| ------------------------ | ---------------------------------------------------------------------- |
| GET, valid handshake     | 200, body = `hub.challenge`                                            |
| GET, anything else       | 403 (also when `WHATSAPP_WEBHOOK_VERIFY_TOKEN` is unset)               |
| POST, secret not set     | 503 (Meta retries later)                                               |
| POST, body > 3 MiB       | 413                                                                    |
| POST, bad signature      | 401                                                                    |
| POST, malformed envelope | 400                                                                    |
| POST, ingestion failure  | 500 (Meta retries; ingestion is idempotent)                            |
| POST, valid              | 200 `EVENT_RECEIVED`, also for numbers no org has registered (dropped) |

Processing is asynchronous: the POST stores events and schedules their processing.

## Configuration (Convex environment variables)

| Name                            | Purpose                                               |
| ------------------------------- | ----------------------------------------------------- |
| `WHATSAPP_APP_SECRET`           | Meta app secret; verifies `X-Hub-Signature-256`.      |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | Operator-chosen verify token entered in the Meta app. |

Both are secrets (8–512 characters, no whitespace) and are never logged or returned. Set them
per deployment with `npx convex env set`; never in source files or `.env.local`.

## Data

| Table                   | Holds                                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `whatsappPhoneNumbers`  | phone_number_id → org routing (WABA id, status, activation time). Global lookup index.                     |
| `whatsappWebhookEvents` | One row per received event (dedupe key; body cleared once applied; recovery state). Global recovery index. |
| `whatsappConversations` | One thread per (business number, customer wa_id); last inbound time.                                       |
| `whatsappMessages`      | Inbound and outbound messages; delivery status and timestamps.                                             |

Phone numbers are registered only by internal functions (the Embedded Signup flow, later; tests
today). No public function routes a number or accepts an org id.

## Public API (read only so far)

`v1/whatsapp:listConversations` (`{ paginationOpts }`), `v1/whatsapp:getConversation`
(`{ conversationId }`), `v1/whatsapp:listMessages` (`{ conversationId, paginationOpts }`). All
`orgQuery` (viewer). Another org's conversation is `NOT_FOUND`.

## Open risks (Stage 1)

Known gaps in the inbound slice, to be closed before customers depend on it:

1. **Event retention.** `whatsappWebhookEvents` rows are never deleted. Processed and ignored
   rows keep only the dedupe key, wamid and number; `unmatched` rows keep their status body,
   which includes the customer's WhatsApp id; `failed` rows keep their full body for requeue.
   Planned: a sweep over the approved `by_status_received` index deleting event rows after 30
   days (longer than Meta's retry period, about 7 days, unverified). If a key is deleted and
   Meta redelivers, inbound messages are still unique per (org, wamid) and statuses only move
   forward. Retention and deletion of stored message text and contact names are not defined.
2. **Unmatched-status replay.** A status for a message the org does not know yet is stored as
   `unmatched` and nothing applies it later. Once outbound sending exists, a `sent` webhook that
   arrives before the send result is recorded would be lost. Planned: an org-first
   `(orgId, wamid)` index on events and a replay when the send result is written.
3. **Stuck-event recovery (mitigated).** A processing batch (up to 100 events) runs in one
   transaction, so one event that keeps throwing rolls back its whole batch. The
   `whatsapp stuck event recovery` cron (every 5 minutes, `convex/whatsapp/recovery.ts`) finds
   events still `pending` 5 minutes after receipt, through the approved global index
   `whatsappWebhookEvents.by_status_received`, and retries each one on its own, so healthy
   events succeed. Each retry's scheduled job id is stored on the event (`retryJobId`), and the
   sweep reads that job's state:
   - Still queued (`pending` / `inProgress`): the retry is neither counted nor scheduled again,
     so a scheduler backlog cannot use up an event's retries. A retry still queued 24 hours
     after it was scheduled is canceled and the event marked `failed`.
   - Anything else while the event is still `pending` (the job failed, was canceled, or its
     record is gone) means the retry finished without processing the event, and it counts
     (`attempts`). Convex keeps finished scheduled jobs for 7 days only ("Scheduled function
     results are available for 7 days after they have completed", Convex docs, Scheduled
     Functions), so a missing record is treated as finished, never as a reason to retry
     without counting.

   So every stuck event becomes `failed` (body kept) after at most 3 finished retries (4
   attempts including the original batch), or after a day with a retry that never ran.

   **Requeue (operators).** Once the cause is fixed, someone with admin access to the Convex
   deployment requeues an event with the internal function
   `whatsapp/recovery:requeueFailedEvent`: from the dashboard (Functions → `whatsapp/recovery`
   → `requeueFailedEvent` → Run, arguments
   `{ "eventId": "<event _id>", "actorSubject": "operator:<name>" }`), or from a terminal with a
   deploy key: `npx convex run whatsapp/recovery:requeueFailedEvent '{"eventId":"…","actorSubject":"operator:<name>"}'`.
   It is audited as `whatsapp.event_requeued` in the event's org. `actorSubject` is typed in by
   the operator and is **not verified by this application**: it is a label, not authenticated
   attribution. It must be `operator:<name>` (letters, digits, `.`, `_`, `@`, `-`; at most 64),
   so audit readers can tell it apart from authenticated users (JWT subjects) and system jobs.
   What is controlled is who may run it at all: only deployment admins (Convex dashboard
   access, or a deploy key). Authenticated attribution would need a staff-facing admin mutation
   behind the org's JWT, which does not exist yet. Remaining limits:
   - No alert yet: `failed` events are only visible in the data (filter `status = "failed"`).
   - Each sweep examines at most 100 stuck events; a larger backlog takes several runs.
   - The original batch's job is not tracked, so a retry can be scheduled while that batch is
     still queued. Both then run; processing is idempotent, so the event is applied once.
   - A failing job's error message is kept by Convex (function logs and the scheduled job's
     record). Our errors carry no message content, but that is not enforced for
     platform-generated errors.

4. **Number-transfer timing (mitigated).** Each number records `activatedAt` when it is
   registered or re-activated (updating an already active number keeps it). Ingestion drops
   events whose platform timestamp is before that activation, so Meta's late retries for a
   previous owner (another org, or the same org before a disconnect) are never stored for the
   current owner. Rows registered before this existed use `createdAt`. Remaining limits:
   - Meta timestamps are whole seconds, so the cutoff is the activation's second: an event in
     that same second is accepted. There is no further grace, and no compensation for clock
     skew between Meta and Convex.
   - A status that happens after the move for the previous owner's outbound message (the
     customer reads it later) reaches the new owner as an `unmatched` event: no content, but the
     message id and the customer's WhatsApp id. It never changes the previous owner's data.
   - Messages customers send after the move belong to the new owner, by design.
   - Deliveries for a number that is not registered yet are acknowledged and dropped, so the
     connection flow must register the number before subscribing the app to the WABA's
     webhooks.
5. **Maximum-size delivery.** A delivery at the limits (1000 events, close to 3 MiB) has not
   been tested against Convex transaction and argument limits; tests cover the 413 refusal and
   small batches only. If Convex ever rejects the ingest arguments, its error message (which may
   include argument values, i.e. message text) could reach deployment logs; the HTTP action
   itself logs nothing.

## Real-account validation required

Everything below is modeled on Meta's documentation and unverified:

- the signature header name and format, and that it covers the exact body bytes;
- payload shapes (`entry[].id` = WABA id, `metadata.phone_number_id`, `contacts[].profile.name`,
  `messages[]`, `statuses[]`, `errors[].code`) and timestamps in Unix seconds;
- status values (`sent`, `delivered`, `read`, `failed`) and their real ordering;
- batch sizes, the 3 MB payload ceiling and Meta's retry schedule for non-200 responses;
- whether a WABA id ever differs between webhook `entry[].id` and the registered value.
