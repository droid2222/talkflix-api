# Production Database Migration Status

Last verified: 2026-06-11

This document records production schema checks that were performed for the v1 mobile release.

## 2026-06-11 Stripe Pro Subscription Migration

`migrations/006_stripe_pro_subscriptions_mysql.sql` adds `stripe_pro_subscriptions`, the backend audit/link table used to map Stripe subscription webhooks back to Talkflix users for web Pro checkout.

The backend also creates this table at startup through `ensureTables`.

Production verification after deploy:

```text
table:stripe_pro_subscriptions|1
```

## 2026-06-07 Pro Entitlements Migration

`migrations/005_pro_entitlements_usage_mysql.sql` adds `user_daily_usage`, the backend daily counter table used by configurable free-plan limits.

The backend also creates this table at startup through `ensureEntitlementTables`.

Production verification after deploy:

```text
user_daily_usage:present
```

## Verified Production Schema

The following schema checks were run against the production database using the production server `.env` through Node/dotenv. Credentials were not printed.

Result before applying migration `004_direct_call_receive_defaults_mysql.sql`:

```text
table:content_saves|1
table:iap_purchases|1
column:receive_voice_calls|1|default=0|nullable=NO
column:receive_video_calls|1|default=0|nullable=NO
```

Interpretation:

- `002_content_feed_upgrade_mysql.sql` was already satisfied because `content_saves` existed.
- `003_mobile_iap_purchases_mysql.sql` was already satisfied because `iap_purchases` existed.
- `004_direct_call_receive_defaults_mysql.sql` was not yet satisfied because new users would still default to direct-call receiving off.

## Migration Applied On 2026-06-05

Applied to production:

```sql
ALTER TABLE users
  MODIFY COLUMN receive_voice_calls TINYINT(1) NOT NULL DEFAULT 1,
  MODIFY COLUMN receive_video_calls TINYINT(1) NOT NULL DEFAULT 1;
```

This changes defaults for new users only. It intentionally does not backfill existing `0` values because those may represent explicit user opt-outs.

Verification after applying:

```text
receive_video_calls|default=1|nullable=NO
receive_voice_calls|default=1|nullable=NO
```

## Current Required Migration Files

```text
migrations/002_content_feed_upgrade_mysql.sql
migrations/003_mobile_iap_purchases_mysql.sql
migrations/004_direct_call_receive_defaults_mysql.sql
migrations/005_pro_entitlements_usage_mysql.sql
migrations/006_stripe_pro_subscriptions_mysql.sql
```

## Handoff Rule

When adding future migrations:

- Add an idempotent migration file under `migrations/`.
- Add startup safeguards in `server.js` only when safe for production startup.
- Verify production schema after deploy.
- Update this file with the exact verification result and date.
