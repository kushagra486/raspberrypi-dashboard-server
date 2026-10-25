# Importing Supabase cloud projects

`cloud-import.sh` copies a project from Supabase cloud onto the Pi. The cloud project is only **read**:
nothing there is changed or deleted, so you can switch the app over when you are ready and keep the
cloud project as a fallback until you trust the Pi copy.

## 1. Store the connection string (you, once per project)

In the Supabase dashboard: your project → **Connect** → **Session pooler** → copy the URI and put the
database password into it. Then, in **Pi Console → >_ Terminal**:

```
~/raspberrypi-dashboard-server/supabase/import/cloud-import.sh add shop
```

and paste it at the hidden prompt. It is checked, then stored only on the Pi
(`~/.config/pi-import/shop.url`, readable only by you). Never paste it in a chat.
Forgot the database password? Dashboard → Project Settings → Database → Reset password
(apps using the API keys are not affected).

## 2. Inspect and import (Claude can do this part)

```
cloud-import.sh inspect shop                          # tables, rows, users, storage, realtime, triggers + recommendation
cloud-import.sh run shop --as isolated --name shop    # own database, users and keys
cloud-import.sh run blog --as shared --name blog      # one schema in the main database, no users
cloud-import.sh forget shop                           # delete the stored connection string afterwards
```

| | isolated | shared |
|---|---|---|
| For | apps with their own sign-up users | apps without users (or users not needed) |
| Copies | schemas, data, RLS, policies, functions, **users + logins (passwords keep working)**, new-user triggers | one schema (renamed to `--name`), data, RLS, policies, functions |
| App change | new URL + anon key (printed at the end) | Pi URL + key with `db: { schema: '<name>' }` |

Every import checks that each table's row count on the Pi equals the cloud's, and that the user count
matches; on any failure the half-made copy is removed again (the cloud is untouched either way).
Proof: `test-cloud-import.sh` (36 checks against stand-in cloud projects with real Supabase Auth).

## Not copied (honest limits)

- **Storage files** (uploads). Refused unless you add `--without-storage`.
- **Realtime** (isolated projects have none yet). Refused unless `--without-realtime`.
- **Edge functions**, **pg_cron jobs**, **MFA factors**, OAuth provider settings (Google login etc.),
  email templates: redo by hand.
- **Sessions**: users sign in once more (new signing key). Passwords stay the same.
- Writes made in the cloud **after** the import stay in the cloud. Import in a quiet moment, then switch
  the app; if the counts differ the import stops and says so.
- Shared import of `public` renames it: functions that spell out `public.` are listed so you can fix them.
