# ADR 0020 — WhatsApp template management

- Status: implemented, not validated. The page, the API and the Meta calls are implemented and
  tested in-process against the fake Graph. No template has been created through it at Meta yet.
- Date: 2026-11-03

## Context

Outside the 24-hour reply window a business may only send templates Meta approved in advance
(ADR 0015). The app could send approved templates (the picker in a conversation) but not create
them: admins had to use Meta's WhatsApp Manager. Businesses also need good templates to start
from: the common order, delivery, appointment, payment, support and marketing messages.

Meta ("Message templates", "Template components", "Template management", read 2026-11-03):

- `POST /{waba}/message_templates` with `name` (lowercase letters, digits, `_`; up to 512),
  `language`, `category`, `parameter_format` (`named` or positional, the default) and
  `components`: a HEADER (TEXT up to 60 characters, one variable; or media / location), a BODY
  (up to 1024 characters), a FOOTER (up to 60) and BUTTONS (up to 10: 10 quick replies, 2 URLs
  with one trailing variable, 1 phone number, …). Every variable needs a sample. Meta reviews
  every template; the category may change during review.
- `GET /{waba}/message_templates` lists them with `status` (APPROVED, PENDING, REJECTED, PAUSED,
  DISABLED, …) and `rejected_reason`.
- `DELETE /{waba}/message_templates` with `hsm_id` and `name` deletes one language; by `name`
  alone, every language. An approved template's name cannot be used again for 30 days.
- Edits (`POST /{template-id}`) are limited (approved: 10 per 30 days, 1 per 24 hours) and
  replace every component. Limits: 250 templates per unverified portfolio, 100 created per hour.

## Decisions

1. **T1 A templates page**, `/whatsapp/templates`, linked from the WhatsApp inbox and settings and
   from the template picker when an account has no approved template. It lists every template of
   a connected WhatsApp Business Account (name, status, category, language, preview, Meta's
   rejection reason in fixed words, and whether this app can send it).
2. **T2 Admins create and delete; every member sees the list** (`v1/whatsapp:listAccountTemplates`
   viewer, `createTemplate` / `deleteTemplate` admin, through `orgAction` / `orgAdminAction`).
3. **T3 Only what this app can send**: a TEXT header or none, the body, a footer, quick reply / URL
   / phone number buttons; categories Utility and Marketing. Media headers, authentication
   templates and other buttons stay in WhatsApp Manager.
4. **T4 Named variables by default** (`{{customer_name}}`); positional ones (`{{1}}`) are accepted.
   One style per template; the form asks for a sample per variable as it finds them, with a live
   preview filled with the samples.
5. **T5 No editing** in this release (Meta's limits; it replaces everything): delete and create.
6. **T6 Meta is the only store.** The list is read from Meta when the page opens and on Refresh;
   no copy, no status webhook (`message_template_status_update` is a later step).
7. **T7 Fixed words only.** Our own checks return a `reason` and `field` with their own text;
   Meta's refusals are reported by code and subcode (`meta_100_2388024`), never Meta's text.
8. **T8 Delete one language at a time**, after a confirmation that warns about the 30-day hold
   for an approved template. Creations and deletions are audited (`whatsapp.template_created` /
   `whatsapp.template_deleted`: template id, name, language, category; never the text).

### Ready-made templates

The builder starts from a gallery of 21 templates (`lib/whatsapp/template-starters.ts`) by use
case: orders and delivery (confirmation, shipping, out for delivery, delivered, cancellation,
refund), appointments and bookings (reminder with confirm / reschedule replies, confirmation with
a call button, booking confirmation), payments (reminder with a pay link, received, failed),
support and account (request update, account change alert) and marketing (welcome, special
offer, abandoned cart, back in stock, new arrivals, feedback request, we miss you, event
invitation). They follow Meta's writing guidelines (variables inside sentences and never side by
side, utility without promotion, marketing with a "Stop promotions" reply) and use a placeholder
website (`https://your-website.com`) and an empty phone number that the form makes the admin
replace. A test builds every one of them through the server's checks
(`convex/whatsapp/templateStarters.test.ts`).

### Checks

`convex/whatsapp/templateDrafts.ts` checks a draft completely before Meta is called: the name,
language code and category; header length, one line and at most one variable; body length;
footer length without variables; variable syntax, one style, positional numbers 1..n in order;
exactly one non-blank sample (up to 200 characters) per variable; the button counts, quick
replies first, labels up to 25 characters, full http(s) links with at most a trailing `{{1}}` and
its sample, and phone numbers with `+` and the country code. The page runs the same limits for
its counters and its "Before submitting" list; the server's check is the authority.

## Consequences

- New: `convex/whatsapp/templateDrafts.ts`, `templateAdmin.ts`; Graph calls
  `createMessageTemplate` / `deleteMessageTemplate`; the listing also reads `rejected_reason`;
  `ParsedTemplate` gains `id`, `rejectedReason` and button `url` / `phoneNumber`.
- No schema change and no new environment variable.
- The business token's `whatsapp_business_management` permission (already granted at signup)
  covers template management.

## Real-account validation required

1. The exact create answer (`id`, `status`, `category`) and Meta's error codes for a duplicate
   name (assumed 100 / 2388024) or a name still being deleted (assumed 100 / 2388023).
2. `parameter_format: "named"` in lowercase, as the creation page writes it.
3. A URL button's `example` as the trailing value only (Meta's example shows `["A1234"]`).
4. The `rejected_reason` values (INVALID_FORMAT, ABUSIVE_CONTENT, PROMOTIONAL, …) and how long
   review takes.
5. Whether Meta moves a Utility starter to Marketing.
