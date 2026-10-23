---
title: Mail and notifications
description: Mail rendered with the commit and sent by a job, and notifications sent once to every channel a principal chose.
sidebar:
  order: 5
---

Sending mail from a request handler has two classic failures. The handler sends, then its
transaction rolls back, and a customer receives a receipt for an order that does not exist. Or the
SMTP server is slow, and every request waits on it. Notifications add a third: the same message
written separately for the inbox, the mail and the push service, each with its own idea of what
the user wanted.

In sofie, a mail is queued with the handler's commit and sent by a job, so it leaves only if the
work it reports happened and no request waits on SMTP. A notification is sent once, and a job
delivers it to every channel the principal chose, honouring their quiet hours and digests.

## Mail

Mail is the `sofie-mail` crate, behind the `mail` feature of `sofie`.

### Sending

A handler, job or task takes `Mailer` as an argument. An app never constructs one: `sofie::run`
reads its settings once.

```rust
pub fn receipt(mailer: &Mailer, to: Address, order: &OrderView) -> Result<Queued> {
    let body = mailer.body("order/receipt", &order)?;
    mailer.send(Mail::new(to, "Your receipt", body)?)
}
```

- `mailer.body("order/receipt", &data)` renders `src/mails/receipt.html` of module `order` with the
  screen engine. The build compiles the template, like a screen, and the text part is derived from
  the HTML.
- `Mail::new(Address::new(&email)?, subject, body)?` is checked once: an address cannot end an SMTP
  command or a header, and a subject is one line.
- `mailer.send(mail)` returns `Queued`, a job queued with the handler's commit.

`sofie new mail MODULE name [--list LIST]` writes a template and the function that sends it.

### Delivery

One job, `sofie_mail.deliver`, sends every mail. It writes the headers and a multipart body and
speaks SMTP itself: STARTTLS or TLS from the start, and authentication only inside TLS.

- **Sent once.** The message id is the job's idempotency key, marked right after the server
  accepts the mail, so a retried job sends nothing again.
- **Retried when the cause is temporary.** A 4xx reply, a lost connection or a failed TLS handshake
  is retried. A 5xx to the message itself buries the job at once.
- **Per recipient.** A recipient the server refuses is left out and the others still get the mail.
  A 550, 551 or 553 for a recipient suppresses that address, as a provider's hard bounce would.
- **Traced without content.** Each send is a `mail` span and a `sofie.mail.duration` measurement
  with the transport and outcome (`ok`, `refused` or `error`), never an address, subject or body.

### Transports

`SOFIE_MAIL_TRANSPORT` chooses how mail leaves:

| Transport | Settings | Use |
|---|---|---|
| `smtp` | `SOFIE_MAIL_SMTP_HOST`, `_PORT`, `_SECURITY` (`starttls`, `tls` or `none`), `_USERNAME`, `_PASSWORD` | Any SMTP server or provider |
| `log` | `SOFIE_MAIL_PREVIEW_DIR` (`off` to stop) | Debug builds only: writes each mail, links included, to the log and as a page under `target/mail-preview` to open in a browser |

Every transport also reads `SOFIE_MAIL_FROM` and `SOFIE_MAIL_BASE_URL`.

Tests use sofie-testing's `mail` feature, a fake transport read with
`sofie_testing::sent_mails(&app)` after `app.drain()`.

### Bulk mail and suppressions

A mail of a list is marked with `.bulk(…)`:

```rust
mailer.send(Mail::new(to, "Weekly news", body)?.bulk("news")?)
```

It has one recipient and carries `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058), its
link sealed per recipient with the app's keys.

`sofie.mail_suppressions` holds what an address no longer gets:

| Suppression | After |
|---|---|
| `All` | A permanent bounce |
| `Bulk` | A complaint |
| `List` | An unsubscribe from that list |

The delivery job leaves suppressed recipients out and sends nothing when none is left.
`sofie_mail::suppress` adds one by hand.

With the `mail-web` feature, `sofie::mail::web::routes(routes, &Events::from_environment()?)`, in
the `Web` area, serves:

- `/mail/unsubscribe`: a page that asks first, and the one-click `POST` a mailbox provider sends.
- `/mail/events/postmark`, with basic authentication from `SOFIE_MAIL_POSTMARK_WEBHOOK_AUTH`.
- `/mail/events/mailgun`, an HMAC over timestamp and token with `SOFIE_MAIL_MAILGUN_SIGNING_KEY`,
  within fifteen minutes.
- `/mail/events/signed`, for any provider: an HMAC-SHA256 of the body in `X-Sofie-Signature`, with
  `SOFIE_MAIL_WEBHOOK_SECRET`.

## Notifications

Notifications are the `sofie-notify` crate, behind the `notify` feature, which brings `mail` and
`local-time`. Its tables come with the framework's migrations, so nothing is wired per app.

### Topics

A module declares what it notifies about as `Topic` constants, named `<module>.<name>`, with the
channels on for a principal who chose nothing:

```rust
pub const SHIPPED: Topic = Topic::new("order.shipped").channels(&[Channel::Inbox, Channel::Mail]);
pub const SIGN_IN_ELSEWHERE: Topic = Topic::new("account.sign_in_elsewhere").urgent();
```

| Channel | Where it arrives |
|---|---|
| `Inbox` | A list in the app, the only default without `channels` |
| `Mail` | Through `Mailer`, to the recipient's address |
| `Push` | The principal's subscribed browsers |

`urgent()` marks a topic that quiet hours and digests never hold, such as a security notice.
`never_digested()` mails at once even to a principal who reads mail as a digest.

### Sending

A handler takes `Notify` as an argument and sends once:

```rust
fn shipped(notify: &Notify, customer: AccountId, email: &Email) -> Result<Queued> {
    let notice = Notice::new("Your order has shipped")?.link("/account/orders")?;
    notify.send(Recipient::from(customer).email(email), SHIPPED, notice)
}
```

`send` queues a job with the commit, so nothing is sent for a refused action. A recipient without
an email skips the mail channel.

### What the delivery job does

1. Applies the principal's choices for the topic.
2. Fills the inbox at once.
3. Holds mail and push until the principal's quiet hours end, in their time zone.
4. Keeps mail for a daily or weekly digest, sent at a local time. A digest mails the 50 oldest
   held items; the rest wait for the next one.
5. Queues one push job per browser subscription, so a failing push service retries only its own.

### Each principal's choices

`Preferences` holds what a principal chose:

- `choose(topic, channel, enabled)` turns a channel of a topic on or off.
- `quiet_hours(Some((from, until)), zone)` holds mail and push in that window; `None` ends quiet
  hours.
- `digest(Digest::Daily(time), zone)` or `Digest::Weekly(day, time)` collects mail into a digest;
  `Digest::Off` mails each one.

Times are local, with an IANA time zone, so a 09:00 digest stays at 09:00 across a clock change and
follows a change to the zone's rules.

### The inbox

`Inbox`, for the request's principal, offers `latest`, `unread`, `mark_read` and `mark_all_read`.
A screen route listing it with `.live(…)` refreshes as the worker commits new rows.

Every hour, `sofie_notify.prune` deletes inbox items read, and digest items mailed, more than
90 days ago. Unread and unsent ones stay.

### Web push

The app routes the handlers `subscribe_push::<Area>`, `unsubscribe_push::<Area>` and `vapid_key`,
and serves `SERVICE_WORKER` as its service worker script. Keys come from
`SOFIE_NOTIFY_VAPID_PUBLIC_KEY`, `SOFIE_NOTIFY_VAPID_PRIVATE_KEY` and
`SOFIE_NOTIFY_VAPID_SUBJECT` (VAPID, RFC 8292).

- The message is encrypted as `aes128gcm` (RFC 8291) and sent through `Outgoing::untrusted`, since
  the browser chose the push service, not the app.
- A 404 or 410 from the push service marks the subscription gone. A 400, 401 or 403, most often the
  sender's own setup, logs an error and keeps it.
- A principal keeps its 20 newest browsers subscribed. A browser signing out stops its principal's
  pushes.

### Closed accounts

When an account closes, its notification settings, choices, inbox, held digest items and push
subscriptions are deleted and its digest schedule canceled. A delivery queued before the close
skips it. sofie-identity's `notify` feature registers this as part of the account's personal data.

## Trade-offs

- Mail is sent by the worker. An app running only the web role sends no mail until a worker runs.
- The `log` transport works in debug builds only; a release build needs `smtp`.
- A digest sends at most 50 items at a time; more wait for the next digest.
- Bounces and complaints reach the suppression list only from the providers with a webhook here
  (Postmark, Mailgun, or one that signs with `X-Sofie-Signature`), or from SMTP refusals.
