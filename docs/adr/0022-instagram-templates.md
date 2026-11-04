# ADR 0022 — Instagram templates: button messages and cards

- Status: implemented, not validated. Tested in-process against the fake Instagram API and
  signed fake webhooks. Real Instagram DMs and text replies work on production (2026-11-03); a
  real template send has not been tried yet.
- Date: 2026-11-04

## Context

WhatsApp has Meta-approved templates (ADR 0015, 0020). The business asked for "the same template
feature" for Instagram DMs. Instagram has no approved templates: a business may message a person
only within 24 hours of their last message (or, with Meta's approval, as a Human Agent within 7
days; ADR 0021), and nothing is submitted for review. What Instagram offers instead are rich
messages [doc: Instagram Messaging, "Button template" and "Generic template"]:

- **Button template** (`template_type: "button"`): a text of up to 640 characters with 1-3
  buttons.
- **Generic template** (`template_type: "generic"`): up to 10 elements shown side by side, each
  with a title and subtitle of 80 characters, an optional image, an optional `default_action`
  (a link opened when the element is tapped) and up to 3 buttons; besides its title an element
  needs another property.
- Buttons are `web_url` (opens a link in the in-app browser) or `postback` (sends a
  `messaging_postbacks` event with the button's payload and title). Both are sent as
  `message.attachment` `{type: "template", payload}` to `POST /<IG_ID>/messages`.
- Meta notes these messages are not shown on instagram.com (the web version).

Saved replies (ADR 0021) already cover reusable text.

## Decisions

1. **T1 Page `/instagram/messages/templates`**, linked from the Instagram DMs page as
   **Templates** (as WhatsApp's): the list, a builder with a preview, and a gallery of
   ready-made templates.
2. **T2 15 ready-made templates** (`lib/instagram/template-starters.ts`): greetings and help
   (welcome menu, frequent questions, store cards, visit our website), orders (tracking,
   shipping, returns), bookings (book an appointment, service cards), products and offers
   (product cards, prices, current offer, payment link), support (a person will reply,
   feedback). Each uses the example site `https://your-website.com` and [brackets]; the builder
   refuses to save until the business replaces both. A Convex test checks every one against the
   server's rules.
3. **T3 Stored in this app only**: the tenant table `instagramTemplates` (`orgId`, unique
   `name`, `content`; index `by_org_name`), at most 100 per org. Two kinds: `buttons` (`text`,
   1-3 buttons) and `cards` (1-10 cards: `title`, optional `subtitle`, `imageUrl`, `linkUrl`, 0-3
   buttons). A button is `{type: "url", title, url}` or `{type: "reply", title}`. Editing works
   directly because nothing goes to Meta.
4. **T4 Editors and admins** create, change and delete templates (`v1/instagramTemplates:create|
update|remove`, `orgMutation`); every member lists them (`list`). Not audited (business
   content, like saved replies).
5. **T5 Only `{{customer_name}}`**, in the button message's text and in card titles and
   subtitles (never in button labels or links); any other `{{…}}` is refused
   (`unknown_placeholder`). It is filled on the server when sending, with the conversation's
   contact name or left out with the comma before it (the same rule as saved replies; the
   dashboard's copy is parity-tested). A template left empty without the name is refused before
   anything is stored.
6. **T6 Sending**: `v1/instagramMessaging:sendTemplate` (`accountId`, `conversationId`,
   `templateId`, `clientMessageId`; editors and admins) uses the text reply's pipeline
   (`queueReply` in `convex/instagram/messaging/outbound.ts`): the same sender and window checks,
   the Human Agent rule, one Meta call per message, the repeated-submit guard, the watchdog and
   echo matching by mid. The message is stored as sent: type `template`, `template` (the filled
   content), `templateName`, and `text` (the button message's text or the first card's title,
   for lists). Later changes to the template never change it; a deletion clears `template` with
   `text`.
7. **T7 Shown in the conversation** as its buttons or cards, with "Template “name”" under it.
   A reply button's payload is only its position (`TEMPLATE_REPLY_<n>`, on cards
   `TEMPLATE_REPLY_<card>_<n>`), never customer data; a tap arrives as the customer's message
   with the button's title and `tap: "button"` (the ADR 0021 postback path), which needs the
   app's webhook field `messaging_postbacks`. Link buttons need nothing more.
8. **T8 Pictures and links are the business's own `https` addresses** (a host name with a dot,
   no IP address, no credentials, no spaces, at most 1000 characters). The dashboard never loads
   a picture: previews show where it comes from. Uploading pictures is a later step.
9. **T9 Fixed words**: refusals are `reason` codes with dashboard texts; Meta's refusals of a
   send are `meta_<code>` as for text replies.

## Consequences

- Schema: tenant table `instagramTemplates` (index `by_org_name`, no global index);
  `instagramMessages.template` and `templateName`; message type `template`.
- API: `v1/instagramTemplates:list|create|update|remove`, `v1/instagramMessaging:sendTemplate`;
  the message DTO gains `template`, `templateName`.
- Pages: `/instagram/messages/templates`; **Templates** in the Instagram reply box (choose,
  preview for this customer, send).
- Echoes of templates sent from other tools are stored as "Unsupported message" placeholders
  (the type list of incoming attachments is unchanged).
- The unified inbox's reply state is unchanged (templates are sent from the conversation page).

## Real-account validation required

1. That `POST graph.facebook.com/v26.0/<IG_ID>/messages` accepts the template attachment with
   the Unified Login token [assume], for both kinds, and returns `message_id`.
2. The echo of a template (expected under `messages` with `is_echo`, matched by mid).
3. Button titles: 20 characters is Messenger's limit; Meta states none for Instagram [assume].
4. A reply button tap under Unified Login (`messaging_postbacks` in the app's webhook fields).
5. How a card's picture shows (Meta states no size or format; JPG or PNG over https expected).
