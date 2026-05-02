# Talkflix API — database reference

## Canonical snapshot (full `CREATE TABLE`)

**File:** [`docs/schema-snapshots/talkflix-2026-03-13-phpmyadmin.sql`](./schema-snapshots/talkflix-2026-03-13-phpmyadmin.sql)

- Export from **phpMyAdmin**, DB `talkflix`, **2026-03-13**, MySQL **8.4.7**.
- Original path on disk: `/Users/genius/talkflixproject/talkflix.sql` (keep in sync when you re-dump).

**Tables in the snapshot:** `email_verifications`, `password_resets`, `users`, `direct_messages`, `follows`, plus **seed `INSERT`** for four `@talkflix.test` users.

---

## `users` (from snapshot — authoritative column list)

| Column | Type | Notes |
|--------|------|--------|
| `id` | `int` AI | PK |
| `email` | `varchar(191)` | unique |
| `password_hash` | `varchar(255)` | |
| `display_name` | `varchar(80)` | |
| `username` | `varchar(50)` | unique |
| `from_country` | `varchar(80)` | nationality / “from” |
| `first_language`, `learn_language` | `varchar(80)` | |
| `dob` | `date` | |
| `gender` | `varchar(30)` | |
| `created_at` | `timestamp` | |
| `profile_photo_url` | `varchar(500)` | |
| `city`, `region`, `country` | `varchar(120)` | geo |
| `country_code` | `varchar(2)` | |
| `lat`, `lon` | `decimal(10,7)` | |
| `location_source`, `location_updated_at` | | |
| **`membership`** | `varchar(20)` default `'free'` | Present in DB; app logic today centers on **`plan`** / **`role`** in `server.js` |
| **`membership_expires_at`** | `datetime` | Same note as above |
| `role` | `varchar(20)` default `'user'` | e.g. `admin` |
| `plan` | `varchar(20)` default `'free'` | `free`, `trial`, `pro` |
| `trial_ends_at`, `pro_ends_at`, `trial_started_at` | `datetime` | |
| `trial_used` | `tinyint(1)` | |
| `meet_languages_json` | `text` | JSON array string |

**Not in the Mar 2026 snapshot** (added later by app startup `ensureTables()` in `server.js` — run on boot against real DB):

- `bio_text` VARCHAR(150) NULL  
- `bio_audio_url` LONGTEXT NULL  
- `bio_audio_duration` INT NULL  

**Planned (not yet in snapshot):** e.g. `can_publish_video` — see `migrations/001_creator_videos_content_mysql.sql`.

---

## `direct_messages` — drift vs snapshot

Snapshot matches core DM shape. **`server.js` `ensureTables()`** also applies (idempotent, ignores duplicate errors):

- `reply_to_message_id` BIGINT NULL + index `idx_dm_reply_to_message_id`  
- May re-assert `message_type`, `message_text` nullability, `image_url`, `audio_url`, etc.

Production row: compare `SHOW CREATE TABLE direct_messages` to snapshot + `ensureTables` alters.

---

## Tables created only in code (not in Mar 2026 dump)

`server.js` `ensureTables()` creates if missing:

- `user_blocks`
- `user_reports`
- `direct_message_reports`

If your **production** DB predates these routes, confirm they exist: `SHOW TABLES LIKE 'user_blocks';` etc.

---

## Live / realtime

Live broadcast state is **in memory** in `socket.js`, not in MySQL.

---

## New migrations (same database)

| File | Purpose |
|------|---------|
| `migrations/001_creator_videos_content_mysql.sql` | Creator video catalog, assets, transcripts, pipeline jobs |

All new FKs to `users` use **`INT`** to match `users.id`.

---

## Maintenance

1. After meaningful schema changes on staging/production, export a new snapshot into `docs/schema-snapshots/` with a dated filename.  
2. Update this doc’s “Canonical snapshot” link to point at the newest file.  
3. Keep `/Users/genius/talkflixproject/talkflix.sql` as your working export **or** replace it with a symlink to `talkflix-api/docs/schema-snapshots/...` if you prefer a single file.
