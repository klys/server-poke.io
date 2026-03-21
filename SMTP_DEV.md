# SMTP Development Guide

During development you don't need a real mail server. Use one of the options below to capture outgoing emails locally without actually delivering them.

---

## Option 1 — Mailpit (recommended)

[Mailpit](https://github.com/axllent/mailpit) is a lightweight local SMTP server with a web UI to inspect captured emails.

**Run with Docker:**

```bash
docker run -d \
  --name mailpit \
  -p 1025:1025 \
  -p 8025:8025 \
  axllent/mailpit
```

- SMTP listens on port **1025**
- Web UI available at **http://localhost:8025**

**`.env` configuration:**

```env
SMTP_HOST=127.0.0.1
SMTP_PORT=1025
SMTP_SECURE=false
SMTP_USER=dev
SMTP_PASS=dev
SMTP_FROM=no-reply@localhost
```

---

## Option 2 — Nodemailer's built-in test account (Ethereal)

[Ethereal](https://ethereal.email) is a fake SMTP service hosted by the Nodemailer team. Emails are captured on their servers and viewable via a web link.

1. Go to https://ethereal.email and click **Create Ethereal Account**.
2. Copy the credentials shown and use them in `.env`:

```env
SMTP_HOST=smtp.ethereal.email
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<ethereal-username>
SMTP_PASS=<ethereal-password>
SMTP_FROM=no-reply@ethereal.email
```

3. After an email is sent, log in at https://ethereal.email/messages to view it.

---

## Disabling email entirely

If you leave any of `SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`, or `SMTP_FROM` empty, the server starts without SMTP and logs a warning:

```
SMTP is not configured. Email delivery is disabled.
```

Emails that would have been sent are silently skipped with a console warning. This is the default when running from a bare `.env` copy.

---

## Emails sent by the server

| Trigger | Subject |
|---|---|
| New user registration | `Welcome to Poke.io` |
| Email validation request | `Validate your email address` |
| Username recovery | `Your Poke.io username` |
| Password reset | `Reset your Poke.io password` |

Validation and reset links point to `APP_PUBLIC_URL` + the configured path and include a `?token=` query parameter.

```env
APP_PUBLIC_URL=http://localhost:3000
EMAIL_VALIDATION_PATH=/#/validate-email
PASSWORD_RESET_PATH=/#/recover-password
```

Token TTLs are controlled by:

```env
AUTH_EMAIL_VALIDATION_TTL_SECONDS=86400   # 24 hours
AUTH_PASSWORD_RESET_TTL_SECONDS=3600      # 1 hour
```
