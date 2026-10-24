# ADR 0015 — WhatsApp outbound messages and the inbox

- Status: implemented. Text replies, approved templates, delivery statuses and the dashboard
  inbox are tested in-process against the fake Graph (`convex/whatsapp/fakeGraph.fixtures.ts`)
  and the dashboard harness. Nothing here has run against Meta.
- Date: 2026-10-24

## Context

[ADR 0013](0013-whatsapp-inbox.md) receives customer messages and status webhooks into
per-org conversations; [ADR 0014](0014-whatsapp-connections.md) connects a customer's WhatsApp
Business Account through Embedded Signup and stores its business token. Customers now need to
read their threads in the dashboard and answer: free-form replies, and approved templates when
the customer has not written for a day.

Facts from Meta's documentation read for this work ("Send messages", "Text messages",
"Template management", the templates components and pricing pages, the status webhook
reference, error codes, permissions):

- A message is sent with `POST /{phone-number-id}/messages`
  (`messaging_product: "whatsapp"`, `recipient_type: "individual"`, `to`, `type`). A text body is
  at most 4096 characters. A 200 answer carries `messages[0].id` (the wamid) and means Meta
  accepted the request, not that it was delivered.
- `to` is the recipient with `+` and the country code; without `+`, Meta prepends the business
  number's own country code. Sending to a webhook `wa_id` (digits, no `+`) is not described.
- Meta documents no idempotency key and no guidance for retrying after a timeout.
- The customer-service window opens, and is refreshed, with each message or call from the
  customer and lasts 24 hours. Outside it only approved templates may be sent; free-form text is
  refused with 131047.
- `GET /{waba-id}/message_templates` lists a WABA's templates with `name`, `language`, `status`
  (APPROVED, PENDING, REJECTED, PAUSED, DISABLED, …), `category`, `parameter_format`
  (`POSITIONAL` or `NAMED`) and `components` (HEADER with a format, BODY, FOOTER, BUTTONS, and
  others such as CAROUSEL). Positional values are sent in placeholder order; named ones carry
  `parameter_name`. Since v23 a parameter problem at send time is error 132018.
- Status webhooks report `sent`, `delivered`, `read` and `failed` (with `errors[].code`), and
  a delivery Meta does not see answered is sent again (docs/whatsapp.md), so a status may come
  twice. Whether a status can arrive before the send call returns is not documented.
- Sending needs `whatsapp_business_messaging` (requested by our signup). A number sends up to 80
  messages per second, and one message every 6 seconds to the same user.

## Decision

1. **Pages** (D1). `/whatsapp` is the inbox: the org's conversations, newest activity first,
   paged with Convex's `usePaginatedQuery`. `/whatsapp/conversations/[conversationId]` is one
   thread, oldest message at the top, with each outbound message's status. Connecting a number
   moved to `/whatsapp/settings` (admins connect; every member sees the accounts). List and
   thread are separate pages, like Organic posts.
2. **Who** (D2). Every member reads (`listConversations`, `getConversation`, `listMessages`).
   Editors and admins send: `v1/whatsapp:sendText` (`orgMutation`, editor) and
   `v1/whatsapp:listTemplates` / `sendTemplate` (`orgAction`, editor). The org and the sender come
   from the verified JWT; another org's conversation is `NOT_FOUND`.
3. **One send, never repeated** (D3). `sendText` stores the message `pending` under the
   browser's `clientMessageId` (an org-first index makes a repeated submit return the same
   message) and schedules one delivery. The delivery claims the message (`sendAttemptedAt`),
   checks the number again and makes ONE Meta call with the org's own token from the number's own
   connection (`convex/whatsapp/outbound.ts`). Accepted: `submitted` with the wamid. Refused
   (4xx): `failed` with Meta's code and a sanitized `failureReason`; a refused token also moves
   the connection to `needs_reauth`. No usable answer (timeout, network, 5xx, unreadable): the
   new status `unknown`, never retried automatically.
4. **A watchdog for a stuck send** (added after D3). Convex does not retry a failed action, so
   each queued message also schedules `settleStuckSend` 5 minutes later. Still pending and
   claimed (the delivery failed after its claim; Meta may have the message): `unknown`
   (`no_result`). Never claimed (no Meta call was made): `failed` (`not_sent`), and a late
   delivery finds it no longer pending. A real result recorded after the watchdog's `unknown`
   still replaces it.
5. **Statuses that come early** (D10). When the send result is recorded, status events stored
   `unmatched` for that wamid (looked up by their dedupe keys `status:<wamid>:<status>`, an
   org-first index) are applied in the same transaction. No new global index.
6. **Scope** (D4, D7). Replies and templates in existing conversations only: no new contacts,
   no media, no quoted replies, no read receipts sent.
7. **Window** (D3). Text needs the customer's 24-hour window (`lastInboundAt`),
   checked by the server when the reply is queued (`service_window_closed`); templates may be
   sent at any time. The page shows the window and re-checks it every 30 seconds.
8. **Which numbers send** (D8). Numbers connected through Embedded Signup whose account,
   connection and number are active and registered. Operator-managed numbers have no stored
   token: `number_cannot_send`.
9. **Templates** (D5). Read from Meta when the picker opens (no cache); only APPROVED ones are
   listed. Supported: a TEXT header or none, the BODY, a FOOTER, and QUICK_REPLY, PHONE_NUMBER or
   URL buttons (a URL may end in one variable). Others are listed with the reason and cannot be
   chosen. `sendTemplate` reads the template again, checks every value (none missing, unexpected,
   blank or too long; header ≤ 60 and body ≤ 1024 characters filled in) and builds the components
   before anything is stored (`convex/whatsapp/templates.ts`); the message keeps the template's
   name, language, the exact components sent and the text the customer reads.
10. **Recipient** (D6). `+` followed by the customer's `wa_id`.
11. **No new flag** (D9). Only connected accounts can send, and connecting stays behind
    `WHATSAPP_CONNECTIONS_ENABLED`.
12. **Fixed words** (D11). Refusals and delivery problems are shown in fixed texts
    (`lib/whatsapp/messages.ts`); Meta's and the server's own texts never reach the page. Nothing
    logs; the token travels only in the `Authorization` header.

## Consequences

- Schema, additive: `whatsappMessages` gains optional `clientMessageId`, `sentBySubject`,
  `sendAttemptedAt`, `failureReason` and `template`, the status `unknown`, and the org-first index
  `by_org_client_message`. No global index.
- Three new `v1/whatsapp` functions (`sendText`, `listTemplates`, `sendTemplate`); the message
  DTO gains `failureReason` and `template` (additive).
- Every send is one scheduled action plus its watchdog; every template listing or template send
  reads the WABA's templates from Meta.
- An `unknown` message has no wamid, so no later status can reach it.
- A reply typed while the window closes is lost (the text box gives way to templates); the
  server would refuse it anyway.
- Unverified until real traffic (docs/whatsapp.md, "Real-account validation required"): sending
  to `+` and the `wa_id`, the answer's shape, statuses that arrive before the send result, where
  131047 is reported, the URL button value without `parameter_name` in NAMED templates, and
  parameter values with line breaks.
- Nobody can send in production until a number is connected through Embedded Signup there (Meta
  configuration and the connection flag, ADR 0014). The test number registered by an operator
  cannot send.
