# ADR 0019 — WhatsApp coexistence (keep using the WhatsApp Business app)

- Status: implemented, not validated. The signup, imports, webhooks, partner removal, dashboard
  and legal pages are implemented and tested in-process against the fake Graph and signed fake
  webhooks. No real coexistence signup has been made. Supersedes ADR 0014 D6 ("coexistence numbers
  are not in the first release").
- Date: 2026-11-03

## Context

Embedded Signup (ADR 0014) connects a number that is new to WhatsApp: Meta registers it for the
Cloud API, and from then on it works only through the API. A number already used in the
WhatsApp app is refused by Meta ("This phone number is already registered to a WhatsApp account").
Businesses want to connect the number they already use, and keep using it on the phone.

Meta's answer is coexistence ("Onboarding WhatsApp Business app users", read 2026-11-03):
Embedded Signup with `extras.featureType: "whatsapp_business_app_onboarding"` lets the business
connect its existing WhatsApp Business app account. The number stays in the app (messages
sent there arrive as `smb_message_echoes` webhooks) and is also served by the Cloud API. Meta
documents:

- the finish event `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` with `waba_id` (the converted
  account keeps its id);
- no phone number registration (the number is already registered);
- within 24 hours of the signup, `POST /{phone}/smb_app_data` with `sync_type`
  `smb_app_state_sync` (contacts), then `history` (chat history; the business decides in the app
  whether to share it). Each is accepted once; afterwards the business must offboard and sign up
  again;
- the webhook fields `smb_message_echoes`, `history`, `smb_app_state_sync` and `account_update`
  (`PARTNER_REMOVED` with `disconnection_info`, `ACCOUNT_OFFBOARDED`, `ACCOUNT_RECONNECTED`);
- `GET /{phone}?fields=is_on_biz_app,platform_type` (expected `true` and `CLOUD_API`);
- the Deregister API does not work for such a number: the business disconnects in the app
  (Settings, Account, Business Platform);
- limits: WhatsApp Business app 2.24.17 or newer, 20 messages per second, all companion devices
  are unlinked at signup (WhatsApp for Windows and WearOS cannot be re-linked), no groups,
  calls, broadcast lists, disappearing or view-once messages through the API; the 24-hour
  window opens only for customer messages after the signup.

Personal WhatsApp numbers are not eligible: they first move to the WhatsApp Business app (in the
app, keeping their chats). Linking a personal number the way WhatsApp Web does is only possible
with unofficial clients that break WhatsApp's terms; not done (D7).

## Decisions

1. **D1 Two connect buttons.** `/whatsapp/settings` offers "Connect a new number" (unchanged:
   `extras: { setup: {} }`) and "Connect my WhatsApp Business app" (adds the `featureType`). The
   proven path does not change. A reconnect of a coexistence account opens the second one.
2. **D2 Import contacts and chat history.** After the webhook subscription, the contacts import
   and then the history import are requested once each (`accounts.ts claimImport` /
   `recordImportResult`, `signup.ts runSetupSteps`): one claim at a time, at most
   `MAX_IMPORT_ATTEMPTS` (3) attempts, nothing after `COEXISTENCE_IMPORT_WINDOW_MS` (24 hours;
   `import_expired` tells the admin to disconnect in the app and sign up again). Setup shows the
   new step `import` until both were accepted. Meta's `request_id`s are kept on the number.
3. **D3 Contacts only name conversations.** `smb_app_state_sync` contacts are kept in
   `whatsappContacts` (name per business number and wa_id) and copied to
   `whatsappConversations.savedName`, which the inbox shows before the customer's profile name. A
   contact removed in the app is deleted. No contact list is shown.
4. **D4 History never opens the reply window.** Imported messages (origin `history`) and echoes
   (origin `business_app`) move `lastMessageAt` and the unified inbox thread, never
   `lastInboundAt`. History is exempt from the activation cutoff (it describes the past and is
   only sent after our request); echoes are not.
5. **D5 Echoes are the business's own messages.** Stored as outbound `sent` messages with
   `origin: "business_app"`; Meta's status webhooks move them forward like any reply. The
   conversation page labels them "sent from the WhatsApp Business app", and imported messages
   "imported".
6. **D6 Disconnect.** Our disconnect is unchanged (routing stops, our app is unsubscribed, the
   token deleted); the dialog adds where to release the number in the app. For a coexistence
   account, a `PARTNER_REMOVED` or `ACCOUNT_OFFBOARDED` webhook is confirmed with Meta as before
   (reading the WABA), and when the WABA is still readable, each number is read: `platform_type`
   present and not `CLOUD_API` ends the account the same way (`partnerRemoval.ts`).
7. **D7 No unofficial clients** (see Context).

### Server-side checks

- The browser's finish variant is a claim only: `completeSignup` with `onboarding:
"coexistence"` reads the number from Meta and refuses (`not_business_app_number`) unless
  `is_on_biz_app` is true, before anything is stored. A Cloud API signup never reads it.
- Without `phone_number_id` (Meta's coexistence page documents only `waba_id`), the WABA must
  have exactly one number (`phone_number_missing` otherwise).
- A coexistence number is never registered: `platformRegisteredAt` is set at signup and
  `coexistence.onboardedAt` starts the import window. The stored credential keeps its shape; its
  PIN is never sent for such a number.
- Coexistence webhook events (echoes, history, contacts) are accepted only for a number with
  coexistence state; for any other number they are counted as unrouted. Large deliveries are
  stored in slices of `INGEST_BATCH_SIZE` events (`webhook.ts ingestBatches`); imports may hold
  up to `MAX_IMPORT_EVENTS_PER_DELIVERY` events, live messages and echoes still at most 1000.
- Malformed coexistence changes are ignored like unknown fields; they never reject the
  `messages` beside them.

## Consequences

- Schema: `whatsappPhoneNumbers.coexistence`, `whatsappConversations.savedName`,
  `whatsappMessages.origin`, `whatsappWebhookEvents.kind` (`echo`, `history`, `contact`),
  `setupError.step` `import`, and the tenant table `whatsappContacts` (org-first index only).
- API: `v1/whatsapp:completeSignup` takes `onboarding` and an optional `phoneNumberId`; account
  DTOs carry `onboardingType` and per number `businessApp`, `imported`, `importDeadline`; message
  DTOs carry `origin`; setup steps include `import`.
- The Privacy Policy and Data Deletion pages name the imported contacts, the app's messages and
  the shared history, and the in-app disconnect.
- Meta App Dashboard: the webhook fields `smb_message_echoes`, `history` and
  `smb_app_state_sync` must be subscribed (operator step).

## Real-account validation required

PROVISIONAL until a real coexistence signup:

1. Meta honours `featureType` under our Embedded Signup v4 login configuration (Meta's sample
   also sets `sessionInfoVersion: "3"`, which we do not send). If not, the Business app option
   does not appear in Meta's window; v5 enables it by default.
2. Whether `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` carries `phone_number_id`.
3. Whether `POST /{waba}/subscribed_apps` is still needed and accepted for a converted account.
4. The `smb_app_data` answers, including a repeated request, and the token it accepts.
5. The exact shapes of `smb_message_echoes`, `history` (chunks, `history_context.status` values)
   and `smb_app_state_sync` (`phone_number` format), and whether echoes get status webhooks.
6. What `platform_type` reads after the business disconnects in the app, and which
   `account_update` events arrive.
7. India and other countries: Meta's page lists none; partner sources say India is supported.
