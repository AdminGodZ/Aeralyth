# Trash retention and automatic lock

Settings accepts a trash duration in days, hours, and minutes. The combined
duration must be a whole number of minutes between 1 and 525,600, inclusive.
One year means 365 days. The existing 30-day default is unchanged.

The duration saves when focus leaves the three inputs or the user presses Enter.
This avoids applying intermediate values while someone edits several units.
The value is normalized on save, so 90 minutes becomes 1 hour and 30 minutes.
Invalid input stays visible with an error and is not submitted.

Retention starts when an item enters Trash and applies to items already there.
At the deadline, the background worker removes expired leaf entries and queues
stored objects for deletion. It checks due work with one-second scheduling
granularity, keeps the existing bounded batches, and backs off while idle.
Deletion can take longer under load or while a storage provider is unavailable.
It does not delete an item before its configured deadline.

Automatic lock now includes **Never**, alongside 5, 15, 30, and 60 minutes.
Never disables inactivity deadlines, including after refreshes, new tabs, and
browser restarts while the account remains signed in. It does not extend the
login session itself. Signing out, session revocation, and explicit locking
still remove access.

For Never, the browser keeps a resume pointer in localStorage and a
non-extractable HKDF key in IndexedDB. No password or raw key is stored in
localStorage. The worker binds the saved key to the authenticated session,
identity fingerprint, and vault version. Reopening requires authenticated
unlock material from the API before that key can be installed. Timed options
continue using an expiring marker in sessionStorage. Signing out awaits key
removal before navigating away.

## Migration and compatibility

Migration `027_flexible_retention_and_vault_lock.sql` converts existing day
preferences to minutes and adds zero as the Never value. Existing choices are
preserved. Apply it before deploying the updated backend:

```bash
npm run db:migrate:flexible-settings
```

The full migration command and Railway's pre-deploy script include this file.
The legacy day column remains synchronized for older clients and workers.
Minute values round up to a whole day in that column, so an older worker cannot
delete data earlier than the new preference allows. Older profile requests using
`trash_retention_days` are still accepted and converted to minutes.

## Validation

```bash
npm test
npm run test:performance
npm run db:test:flexible-settings
DATABASE_URL=postgres://aeralyth:aeralyth@127.0.0.1:5432/aeralyth \
  cargo test --locked --manifest-path backend/Cargo.toml \
  trash_expiry_executes_leaf_first_and_queues_file_objects -- --ignored
```

The database fixture covers migration preservation/replay, one-minute and
one-year limits, invalid settings, and legacy-writer compatibility. The expiry
test checks the one-minute cutoff, leaf-first deletion, preservation of newer
trash and restored files, and queued object deletion. Browser verification uses
a disposable encrypted account and S3-compatible local storage.
