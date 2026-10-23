# ADR 0013 — WhatsApp inbox

- Status: in progress. Stage 1 (inbound webhook slice) implemented and tested against signed
  fake deliveries only. Embedded Signup, outbound sending and the dashboard are not built yet.
  No real Meta interaction has happened; every payload shape is provisional.
- Date: 2026-10-22

## Context

Customers connect their own WhatsApp Business numbers (Meta Embedded Signup) and answer
customers from a shared inbox. Meta delivers inbound messages and delivery statuses to one
webhook URL per app, authenticated only by an HMAC signature with the app secret: the request
says nothing trustworthy about which tenant it belongs to. No real WhatsApp Business account is
available.

## Decisions

1. **Webhook on Convex HTTP actions** (`/whatsapp/webhook`). GET answers Meta's verification
   handshake with the configured verify token (constant-time compare). POST verifies
   `X-Hub-Signature-256` (HMAC-SHA256 over the exact raw bytes, `crypto.subtle.verify`) before
   decoding or parsing anything. Missing configuration fails closed (GET 403, POST 503).
2. **Strict parsing.** A wrong envelope (object, entry, changes, metadata) rejects the whole
   delivery (400). Invalid individual messages / statuses are skipped and counted, so one
   unexpected item cannot block a batch through endless Meta retries. Only allowlisted fields
   are copied; payload organization ids are ignored. Size limits: 3 MiB body, 1000 events.
   Changes for subscribed fields other than `messages` are ignored whatever their value, and a
   malformed Content-Length header is a 400. A contact name is replaced only by one from a
   message at the same platform second or later (`contactNameAt`), since Meta does not
   guarantee order.
3. **Tenant = registered phone number.** `whatsappPhoneNumbers` maps a Meta `phone_number_id`
   to one org. Its global index `by_phone_number_status` is an approved global index
   (convex/schema.test.ts): the webhook cannot be tenant-authenticated, so the org must be
   derived server-side. At most one `active` row per number (enforced on register); the
   webhook also requires exactly one active row and a matching WABA id, otherwise it drops the
   change (still 200, so Meta does not retry forever). Events timestamped before the number's
   current activation (`activatedAt`, set on registration and re-activation) are dropped too,
   so a reassigned number's late retries never reach the new owner.
4. **Idempotent, asynchronous ingestion.** One fast mutation stores each event once per org
   under a dedupe key (`message:<wamid>`, `status:<wamid>:<status>`) and schedules processing in
   batches of 100. Processing applies only `pending` events in the same transaction that marks
   them done, so redelivery, retries and re-runs change nothing. Event bodies are cleared once
   applied. A cron retries events still pending after 5 minutes one by one (a failing event no
   longer holds back its batch). It stores each retry's scheduled job id: a queued retry is never
   duplicated or counted, and any retry that is no longer queued counts, whether its job record
   failed, was canceled or has expired (Convex keeps finished jobs for 7 days). After 3 counted
   retries, or a retry still queued after 24 hours, the event is `failed` for an operator to
   requeue; the requeue is audited under an operator-supplied `operator:<name>` subject that the
   application does not verify. It reads through a second approved global index,
   `whatsappWebhookEvents.by_status_received`, because the sweep has no tenant caller. An
   hourly retention cron reads the same index and deletes events that are no longer pending
   (`processed`, `ignored`, `unmatched`, `failed`) 30 days after receipt, in bounded batches,
   so a `failed` event can be requeued for 30 days (no hold mechanism). `pending` events,
   events whose retry is still queued, messages and conversations are never deleted by it.
5. **Statuses only move forward** (pending < submitted < sent < delivered < read; failed is
   terminal and only before delivery). Out-of-order reports still record their timestamps.
   A status for an unknown message is kept `unmatched` with its body for the send path.
6. **No logging** in `convex/whatsapp/**` and `convex/v1/whatsapp.ts` (ESLint `no-console`).
   Message bodies are stored for the inbox, never logged; failures keep only a numeric code.
7. **Read API** `v1/whatsapp:listConversations`, `getConversation`, `listMessages` (viewer).
   The 24-hour service window is exposed only as `serviceWindowExpiresAt`; send-time
   enforcement is server-side (later stage).

## Consequences

- New Convex env vars: `WHATSAPP_APP_SECRET`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
- Webhook events are kept for deduplication (bodies cleared once applied) and deleted 30 days
  after receipt unless still pending; a `failed` event not requeued by then is lost for good.
- Open risks (event retention, unmatched-status replay, stuck-event recovery, number-transfer
  timing, maximum-size deliveries) are listed in [docs/whatsapp.md](../whatsapp.md#open-risks-stage-1).
- See [docs/whatsapp.md](../whatsapp.md) for the setup checklist and real-account validation.
