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

| Table                   | Holds                                                                                                                                                    |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `whatsappPhoneNumbers`  | phone_number_id → org routing (WABA id, status, activation time). Global lookup index.                                                                   |
| `whatsappWebhookEvents` | One row per received event (dedupe key; body cleared once applied; recovery state). Global recovery index. Deleted 30 days after receipt unless pending. |
| `whatsappConversations` | One thread per (business number, customer wa_id); last inbound time.                                                                                     |
| `whatsappMessages`      | Inbound and outbound messages; delivery status and timestamps.                                                                                           |

Phone numbers are registered only by internal functions (the Embedded Signup flow, later; tests
today). No public function routes a number or accepts an org id.

## Public API (read only so far)

`v1/whatsapp:listConversations` (`{ paginationOpts }`), `v1/whatsapp:getConversation`
(`{ conversationId }`), `v1/whatsapp:listMessages` (`{ conversationId, paginationOpts }`). All
`orgQuery` (viewer). Another org's conversation is `NOT_FOUND`.

## Open risks (Stage 1)

Known gaps in the inbound slice, to be closed before customers depend on it:

1. **Event retention (mitigated).** The `whatsapp event retention` cron (hourly,
   `convex/whatsapp/retention.ts`) deletes `whatsappWebhookEvents` rows that are no longer
   pending once they are at least 30 days old, counted from receipt (`receivedAt`), reading the
   approved global index `whatsappWebhookEvents.by_status_received`:

   | Event status           | What the row holds                                    | Retention                  |
   | ---------------------- | ----------------------------------------------------- | -------------------------- |
   | `processed`, `ignored` | dedupe key, wamid, number (body cleared)              | deleted after 30 days      |
   | `unmatched`            | status body, including the customer's WhatsApp id     | deleted after 30 days      |
   | `failed`               | full body (message text, contact name), for requeue   | deleted after 30 days      |
   | `pending`              | full body and recovery state (recovery still owns it) | never deleted by retention |

   Messages and conversations are never deleted automatically. 30 days is far longer than
   Meta's retry period for a delivery (about 7 days, unverified), so a deleted dedupe key is
   not expected to be needed again. If an event is redelivered after its row was deleted, it is
   stored again as a new row and changes nothing: a message already stored is `ignored`
   (messages are unique per org and wamid), a status already recorded is `ignored` (statuses
   only move forward), and a status for an unknown message is `unmatched` again.

   **Failed events and requeue.** A `failed` event can be requeued (risk 3) until it is 30
   days old. Requeuing makes it `pending` again, so retention leaves it alone until it is
   processed (or fails again); once processed, an event already older than 30 days is deleted
   by the next run. After retention has deleted a failed event, `requeueFailedEvent` returns
   `false` and writes no audit entry: the event and its body are gone, and its message was
   never stored. There is no hold mechanism; an operator who needs a failed event must requeue
   it before then.

   **Pending events and queued retries.** Retention never reads `pending` rows (the type of its
   status list excludes them) and never deletes a row whose recovery retry (`retryJobId`) is
   still queued. A retry still queued 30 days after receipt would take a scheduler stall of
   weeks, so that check is a guard. A processing job that runs after its event was deleted
   (the original batch's job is not tracked) finds no row and skips it.

   Each run examines at most 200 rows. A run that deletes a full batch schedules a follow-up
   run at once, at most 20 in a chain; the next hourly run continues after that. Every run reads
   and deletes in one transaction: Convex mutations are serializable and a mutation whose reads
   conflict with another's writes is re-run (Convex docs, "OCC and Atomicity"), so a retried or
   overlapping run deletes each row at most once and never a row that no longer qualifies.
   Limits:
   - The requeue window counts from receipt, not from the failure. Recovery normally fails an
     event about 20 minutes after receipt; a scheduler backlog can stretch that to a few days
     (each retry may wait up to 24 hours in the queue). An event requeued late that fails again
     after its 30th day is deleted by the next hourly run.
   - No alert for `failed` events (risk 3): one nobody notices within 30 days is deleted, and
     its message is lost for good.
   - Nothing reads `unmatched` rows today. The planned unmatched-status replay (risk 2) must
     apply them well within 30 days; it is meant to run when the send result is recorded.
   - At most 4,200 rows are deleted per hour (21 runs of 200), about 100,000 a day. A sustained
     volume above that lets the backlog of expired rows grow until volume drops.
   - Rows kept for a queued retry count against a run's 200 rows; they could only build up if
     the scheduler stalled for weeks.
   - `pending` rows are never deleted, however old; recovery turns every stuck event into
     `processed` or `failed` (normally within minutes, at most a few days under a backlog).
   - Retention and deletion of stored message text and contact names (`whatsappMessages`,
     `whatsappConversations`) are not defined, and there is no per-org data deletion.

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
   attempts including the original batch), or after a day with a retry that never ran. A
   `failed` event can be requeued until retention deletes it, 30 days after receipt (risk 1).

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
   - No alert yet: `failed` events are only visible in the data (filter `status = "failed"`),
     and retention deletes them 30 days after receipt whether or not anyone looked.
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
