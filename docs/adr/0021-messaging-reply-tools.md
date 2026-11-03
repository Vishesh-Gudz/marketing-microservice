# ADR 0021 — Reply tools: saved replies, Instagram quick replies, ice breakers, Human Agent

- Status: implemented, not validated. Tested in-process against the fake Instagram API and signed
  fake webhooks; no Instagram account is connected on production yet. Human Agent replies stay
  off until Meta approves the permission (`INSTAGRAM_HUMAN_AGENT_ENABLED`).
- Date: 2026-11-03

## Context

WhatsApp has Meta-approved templates (ADR 0015, 0020). Instagram has none: a business may reply
only after the person writes, freely for 24 hours; the only way past 24 hours is Meta's
`HUMAN_AGENT` tag (a person, not automation, up to 7 days after the person's last message), which
needs Meta's approval in App Review [doc: Send API reference]. What Instagram offers instead
[doc: Instagram Messaging features]: quick replies (up to 13 plain-text buttons of 20
characters, `message.quick_replies`), ice breakers (up to 4 questions shown to people opening a
chat, `messenger_profile`, taps as `messaging_postbacks`) and generic templates (image cards).
Businesses also need reusable answers for both channels.

## Decisions

1. **I1 One saved-reply library for WhatsApp and Instagram** (`savedReplies`, tenant-owned;
   `v1/savedReplies:list|create|update|remove`). Each reply names its channels; Instagram ones may
   carry quick-reply buttons. They are inserted into the reply box and edited there; sending
   checks everything again (window, length). In WhatsApp they work only inside the 24-hour
   window: templates stay for anything later. At most 200 per org; titles unique per org.
2. **I2 Editors and admins manage saved replies** (`orgMutation`, editor); every member reads
   them. Not audited (business text, like replies themselves).
3. **I3 Only `{{customer_name}}`** is filled in, by the dashboard when inserting: the contact's
   first name, or nothing (with the comma or space before it) when unknown.
4. **I4 Quick replies now, image cards later.** `sendText` takes `quickReplies` (1-13, 1-20
   characters, different; checked by `checkQuickReplies`, shared with saved replies); the payload
   is the button's position (`QUICK_REPLY_n`), never customer data. A tap arrives as the
   customer's text with `quick_reply`; it is stored with `tap: "quick_reply"`, the payload never.
5. **I5 Ice breakers** on the Instagram DM settings page (admins, `setIceBreakers` /
   `clearIceBreakers`; 1-4 different questions of up to 80 characters, our limit since Meta
   states none): `POST` / `DELETE /<IG_ID>/messenger_profile` with a JSON body [doc], the token in
   the header only (two new transport routes). The account keeps what was set (`iceBreakers`)
   and each change is audited with a count. A tap (`postback` with our `ICE_BREAKER_` payload) is
   stored as the customer's message with the question as text and `tap: "ice_breaker"` (another
   button's postback: `"button"`), opening the 24-hour window like any customer message.
6. **I6 Human Agent behind a switch.** With `INSTAGRAM_HUMAN_AGENT_ENABLED=true` (only after
   Meta's approval; never on by default, also not locally), a reply after the 24-hour window and
   within 7 days of the customer's last message is stored with `tag: "human_agent"` and sent with
   `messaging_type: "MESSAGE_TAG"`, `tag: "HUMAN_AGENT"` [doc]; `claimDelivery` checks the window
   again (a tagged reply that falls inside 24 hours is sent untagged). The conversation DTO
   carries `humanAgentWindowExpiresAt` only while the switch is on; the page then offers "Send
   as human agent" with Meta's rule in words.
7. **I7 Order**: the real setup (an Instagram professional account in the business portfolio,
   "Allow access to messages", publishing the Meta app) runs beside the code; the App Review kit
   is `docs/instagram-app-review.md`.

## Consequences

- Schema: the tenant table `savedReplies` (index `by_org_title`);
  `instagramMessagingAccounts.iceBreakers`; `instagramMessages.quickReplies`, `tag`, `tap`; the
  webhook event content gains `tap`. No new global index.
- API: `v1/savedReplies:*`, `v1/instagramMessaging:setIceBreakers|clearIceBreakers`,
  `sendText.quickReplies`; DTOs gain `iceBreakers`, `humanAgentWindowExpiresAt`, `quickReplies`,
  `humanAgent`, `tap`.
- Pages: `/inbox/saved-replies` (linked from the inbox), "Saved replies" in both reply boxes,
  quick-reply buttons in the Instagram reply box, ice breakers in Instagram DM settings.
- The unified inbox's reply state still uses the 24-hour window only (a Human Agent reply is
  possible from the conversation page).
- The webhook subscription fields are unchanged (`messages,messaging_seen` under Unified Login):
  Meta does not list `messaging_postbacks` for Unified Login, and asking for a field Meta refuses
  would fail the subscription. Ice breaker taps arrive only if the app's webhook fields include
  `messaging_postbacks`.

## Real-account validation required

1. `messenger_profile` on graph.facebook.com with the Unified Login system-user token
   [assume], and its answer (`{"result": "success"}`).
2. Whether ice breaker taps reach us under Unified Login (`messaging_postbacks`), and a
   postback's `mid`.
3. Quick replies under Unified Login (`/<IG_ID>/messages`, the documented body).
4. Meta approving the Human Agent permission; then the tagged send.
