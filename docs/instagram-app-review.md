# Instagram: going live and App Review

How to take the Instagram Meta app (Instagram API with Unified Login, `INSTAGRAM_APP_ID`) from
"works for people with a role on the app" to "works for any business". Everything here is done in
Meta's dashboards by the app's admin; nothing in it changes the code. Decisions:
[ADR 0017](adr/0017-instagram-messaging.md), [ADR 0021](adr/0021-messaging-reply-tools.md).

## 1. Before testing (once)

1. **An Instagram professional account in the business portfolio.** Meta Business Settings →
   Accounts → Instagram accounts → Add, and sign in to the account. A personal account first
   switches to Professional (Business or Creator) in the Instagram app.
2. **Message access.** In the Instagram app, on that account: Settings → Messages and story
   replies → Message controls → Connected tools → **Allow access to messages**.
3. **Webhooks** (App Dashboard → Instagram → API setup with Unified login → Webhooks): callback
   `<CONVEX_SITE_URL>/instagram/webhook`, the verify token, fields `messages` and
   `messaging_seen`; add `messaging_postbacks` if Meta offers it (ice breaker taps and template
   reply buttons).

## 2. Publish the app (like the WhatsApp app)

App Dashboard → App settings → Basic:

| Field                             | Value                                                     |
| --------------------------------- | --------------------------------------------------------- |
| Privacy policy URL                | `https://marketing-microservice.vercel.app/privacy`       |
| User data deletion (instructions) | `https://marketing-microservice.vercel.app/data-deletion` |
| Terms of service URL (optional)   | the same privacy URL until terms exist                    |
| App icon                          | 1024 × 1024 PNG                                           |
| Category                          | Business and pages (or Messaging)                         |
| Business                          | Hyperion Future Tech Ventures (verified)                  |

Then **Publish** (top of the dashboard). Published with Standard Access, the app works for
accounts of people who have a role on the app and the verified business's own assets.

## 3. Real test (production)

1. `/connections` → Instagram → Connect, choose the professional account, allow every permission.
2. Link the account, then Instagram DMs → Settings → **Turn on direct messages**.
3. From another Instagram account, send a DM. It appears in `/instagram/messages` and `/inbox`.
4. Reply from the conversation (also try a saved reply, quick-reply buttons and a template
   from Instagram DMs → Templates).
5. Set ice breakers in Instagram DM settings; open a new chat from a phone to see them.

## 4. App Review (Advanced Access, for other businesses)

App Dashboard → App Review → Permissions and features. Request, with the use case text below:

| Permission / feature        | Why the app needs it (paste and adapt)                                                                                                                                                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instagram_basic`           | To identify the Instagram professional account the business connects, and show its username in the dashboard.                                                                                                                                                  |
| `instagram_manage_messages` | To receive the direct messages customers send the business and let the business's team answer them from a shared inbox, within Meta's windows.                                                                                                                 |
| Human Agent (feature)       | So a member of the business's team can still answer a customer's question personally for up to 7 days, when the answer needs more than 24 hours (for example checking stock or an order). Only people send these replies; nothing is automated or promotional. |

**Screencast** (one per permission is fine; 1-3 minutes, English captions):

1. Sign in to Marketing Microservice; open Connections; click Connect Instagram; Meta's dialog;
   choose the professional account; allow the permissions; back on Connections, the account
   appears.
2. Link it; open Instagram DMs → Settings; turn on direct messages.
3. From a phone, send a DM to the business; show it arriving in the Instagram DMs inbox.
4. Open it; reply (show a saved reply being inserted, a quick-reply button); show the reply on
   the phone.
5. Human Agent: show a conversation older than 24 hours, the "Human agent window" note and a
   personal reply from a team member, and explain who may send it.
6. Show Disconnect / Turn off direct messages and the Data Deletion page.

**Reviewer access:** give the reviewer a test user (App roles → Testers) and an Instagram test
account they can message from, with written steps matching the screencast.

After approval: set `INSTAGRAM_HUMAN_AGENT_ENABLED=true` on the production Convex deployment
(only once the Human Agent feature shows Advanced Access).
