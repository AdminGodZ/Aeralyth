use actix_web::{Result, error};
use deadpool_postgres::GenericClient;

use crate::db::{execute_cached, query_one_cached};

pub const MAX_PENDING_UPLOADS: i64 = 20;
// Share-link editors draw on the owner's pending slots, so bound each link and all
// links together. The remainder stays available to the owner.
pub const MAX_PENDING_UPLOADS_PER_SHARE_LINK: i64 = 5;
pub const MAX_PENDING_SHARE_LINK_UPLOADS: i64 = 15;
pub const PENDING_UPLOAD_SECONDS: i64 = 24 * 60 * 60;
// A share-link upload that never receives a write expires quickly; the first write
// request restores the normal pending lifetime.
pub const UNTOUCHED_SHARE_LINK_UPLOAD_SECONDS: i64 = 15 * 60;
const _: () = assert!(MAX_PENDING_UPLOADS_PER_SHARE_LINK <= MAX_PENDING_SHARE_LINK_UPLOADS);
const _: () = assert!(MAX_PENDING_SHARE_LINK_UPLOADS < MAX_PENDING_UPLOADS);
const _: () = assert!(UNTOUCHED_SHARE_LINK_UPLOAD_SECONDS < PENDING_UPLOAD_SECONDS);

pub fn initial_pending_upload_seconds(share_link_id: Option<&str>) -> i64 {
    if share_link_id.is_some() {
        UNTOUCHED_SHARE_LINK_UPLOAD_SECONDS
    } else {
        PENDING_UPLOAD_SECONDS
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReservationAmount {
    pub ledger_bytes: i64,
    pub quota_delta: i64,
}

pub async fn reserve_upload_capacity<Client>(
    client: &Client,
    owner_id: &str,
    share_link_id: Option<&str>,
    amount: ReservationAmount,
    storage_quota_bytes: u64,
) -> Result<()>
where
    Client: GenericClient,
{
    if amount.ledger_bytes < 0 {
        return Err(error::ErrorInternalServerError(
            "upload reservation cannot be negative",
        ));
    }
    let quota_bytes = i64::try_from(storage_quota_bytes)
        .map_err(|_| error::ErrorInternalServerError("storage quota is too large"))?;
    let reserved = execute_cached(
        client,
        "
            UPDATE user_storage_usage
            SET reserved_bytes = reserved_bytes + $2::bigint,
                pending_uploads = pending_uploads + 1,
                updated_at = now()
            WHERE owner_id = $1::text
              AND pending_uploads < $3::bigint
              AND used_bytes::numeric + reserved_bytes::numeric + $5::bigint
                    <= $4::bigint
        ",
        &[
            &owner_id,
            &amount.ledger_bytes,
            &MAX_PENDING_UPLOADS,
            &quota_bytes,
            &amount.quota_delta,
        ],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    if reserved == 1 {
        return match share_link_id {
            Some(share_link_id) => {
                enforce_share_link_pending_limits(client, owner_id, share_link_id).await
            }
            None => Ok(()),
        };
    }

    let usage = query_one_cached(
        client,
        "
            SELECT used_bytes, reserved_bytes, pending_uploads
            FROM user_storage_usage
            WHERE owner_id = $1
        ",
        &[&owner_id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    let used_bytes: i64 = usage.get("used_bytes");
    let reserved_bytes: i64 = usage.get("reserved_bytes");
    let pending_uploads: i64 = usage.get("pending_uploads");

    if pending_uploads >= MAX_PENDING_UPLOADS {
        return Err(error::ErrorTooManyRequests("too many uploads are pending"));
    }
    let quota_total =
        i128::from(used_bytes) + i128::from(reserved_bytes) + i128::from(amount.quota_delta);
    if quota_total > i128::from(quota_bytes) {
        return Err(error::ErrorPayloadTooLarge("storage quota exceeded"));
    }

    Err(error::ErrorConflict(
        "storage reservation changed; retry the upload",
    ))
}

// Runs after the ledger UPDATE above, which row-locks the owner's usage. Concurrent
// reservations for the same owner therefore serialize, and this count sees every
// committed competitor. An error aborts the caller's transaction, undoing the slot.
async fn enforce_share_link_pending_limits<Client>(
    client: &Client,
    owner_id: &str,
    share_link_id: &str,
) -> Result<()>
where
    Client: GenericClient,
{
    let pending = query_one_cached(
        client,
        "
            SELECT count(*) FILTER (WHERE share_link_id = $2)::bigint AS link_pending,
                   count(*)::bigint AS links_pending
            FROM file_uploads
            WHERE owner_id = $1
              AND share_link_id IS NOT NULL
              AND status IN ('initializing', 'pending', 'completing', 'aborting')
        ",
        &[&owner_id, &share_link_id],
    )
    .await
    .map_err(error::ErrorInternalServerError)?;
    share_link_pending_limit_error(pending.get("link_pending"), pending.get("links_pending"))
}

fn share_link_pending_limit_error(link_pending: i64, links_pending: i64) -> Result<()> {
    if link_pending >= MAX_PENDING_UPLOADS_PER_SHARE_LINK {
        return Err(error::ErrorTooManyRequests(
            "too many uploads are pending for this share link",
        ));
    }
    if links_pending >= MAX_PENDING_SHARE_LINK_UPLOADS {
        return Err(error::ErrorTooManyRequests(
            "too many share-link uploads are pending for this owner",
        ));
    }
    Ok(())
}

pub fn reservation_amount(
    requested_bytes: i64,
    replacement_credit: i64,
) -> Result<ReservationAmount> {
    if requested_bytes < 0 || replacement_credit < 0 {
        return Err(error::ErrorInternalServerError(
            "upload reservation inputs are invalid",
        ));
    }
    let quota_delta = requested_bytes
        .checked_sub(replacement_credit)
        .ok_or_else(|| error::ErrorInternalServerError("upload reservation overflowed"))?;
    Ok(ReservationAmount {
        ledger_bytes: quota_delta.max(0),
        quota_delta,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_PENDING_SHARE_LINK_UPLOADS, MAX_PENDING_UPLOADS, MAX_PENDING_UPLOADS_PER_SHARE_LINK,
        PENDING_UPLOAD_SECONDS, ReservationAmount, UNTOUCHED_SHARE_LINK_UPLOAD_SECONDS,
        initial_pending_upload_seconds, reservation_amount, reserve_upload_capacity,
        share_link_pending_limit_error,
    };
    use actix_web::http::StatusCode;
    use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
    use tokio_postgres::NoTls;

    #[test]
    fn share_links_leave_pending_slots_for_the_owner() {
        assert!(share_link_pending_limit_error(0, 0).is_ok());
        assert!(
            share_link_pending_limit_error(
                MAX_PENDING_UPLOADS_PER_SHARE_LINK - 1,
                MAX_PENDING_SHARE_LINK_UPLOADS - 1
            )
            .is_ok()
        );
        for (link_pending, links_pending) in [
            (
                MAX_PENDING_UPLOADS_PER_SHARE_LINK,
                MAX_PENDING_UPLOADS_PER_SHARE_LINK,
            ),
            (0, MAX_PENDING_SHARE_LINK_UPLOADS),
        ] {
            let error = share_link_pending_limit_error(link_pending, links_pending)
                .expect_err("share-link pending limits must reject");
            assert_eq!(
                error.as_response_error().status_code(),
                StatusCode::TOO_MANY_REQUESTS
            );
        }
    }

    #[test]
    fn untouched_share_link_uploads_expire_before_owner_uploads() {
        assert_eq!(initial_pending_upload_seconds(None), PENDING_UPLOAD_SECONDS);
        assert_eq!(
            initial_pending_upload_seconds(Some("link")),
            UNTOUCHED_SHARE_LINK_UPLOAD_SECONDS
        );
    }

    #[actix_web::test]
    #[ignore = "requires an initialized PostgreSQL test database"]
    async fn database_share_link_reservations_cannot_exhaust_owner_slots() {
        let database_url = std::env::var("DATABASE_URL").expect("DATABASE_URL is required");
        let postgres_config = database_url
            .parse::<tokio_postgres::Config>()
            .expect("database URL should parse");
        let manager = Manager::from_config(
            postgres_config,
            NoTls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(1)
            .runtime(Runtime::Tokio1)
            .build()
            .expect("test pool should build");
        let mut client = pool.get().await.expect("test database should connect");
        let transaction = client
            .transaction()
            .await
            .expect("test transaction should start");
        transaction
            .batch_execute(
                "INSERT INTO users (id, username, password_hash, role, status)
                   VALUES ('usr_link_slots', 'link_slots', 'not-a-login-hash', 'user', 'active');
                 INSERT INTO user_storage_usage (owner_id) VALUES ('usr_link_slots')
                   ON CONFLICT (owner_id) DO NOTHING;
                 INSERT INTO files (
                   id, owner_id, original_name, storage_name, size_bytes,
                   state, entry_type, e2ee_state
                 ) VALUES (
                   'fil_link_slots', 'usr_link_slots', 'shared', 'tests/link-slots', 0,
                   'active', 'folder', 'legacy'
                 );
                 INSERT INTO share_links (
                   id, token_hash, owner_id, root_file_id, access_scope, permission
                 )
                 SELECT 'link_slots_' || n, 'link-slots-hash-' || n, 'usr_link_slots',
                        'fil_link_slots', 'public', 'editor'
                 FROM generate_series(1, 4) AS n;",
            )
            .await
            .expect("share-link fixtures should insert");

        let amount = ReservationAmount {
            ledger_bytes: 0,
            quota_delta: 0,
        };
        let mut sequence = 0;
        let mut reserve = async |share_link_id: Option<&str>| {
            sequence += 1;
            transaction
                .execute("SAVEPOINT reservation", &[])
                .await
                .expect("savepoint should open");
            let reserved = reserve_upload_capacity(
                &transaction,
                "usr_link_slots",
                share_link_id,
                amount,
                1 << 40,
            )
            .await;
            if reserved.is_err() {
                transaction
                    .execute("ROLLBACK TO SAVEPOINT reservation", &[])
                    .await
                    .expect("failed reservation should roll back");
                return reserved;
            }
            transaction
                .execute(
                    "INSERT INTO file_uploads (
                       id, file_id, owner_id, original_name, object_key, size_bytes,
                       upload_mode, share_link_id, reservation_bytes, status, expires_at
                     ) VALUES (
                       'upl_link_slots_' || $1::text, 'fil_link_slots_upload_' || $1::text,
                       'usr_link_slots', 'empty-' || $1::text, 'tests/link-slots/' || $1::text,
                       0, 'local', $2, 0, 'pending', now() + interval '15 minutes'
                     )",
                    &[&sequence.to_string(), &share_link_id],
                )
                .await
                .expect("reserved upload should insert");
            reserved
        };

        for _ in 0..MAX_PENDING_UPLOADS_PER_SHARE_LINK {
            reserve(Some("link_slots_1"))
                .await
                .expect("link slot should reserve");
        }
        assert!(
            reserve(Some("link_slots_1")).await.is_err(),
            "one link must not exceed its own pending cap"
        );
        for link in ["link_slots_2", "link_slots_3"] {
            for _ in 0..MAX_PENDING_UPLOADS_PER_SHARE_LINK {
                reserve(Some(link))
                    .await
                    .expect("other links should reserve");
            }
        }
        assert!(
            reserve(Some("link_slots_4")).await.is_err(),
            "share links together must leave the owner's slots free"
        );
        for _ in MAX_PENDING_SHARE_LINK_UPLOADS..MAX_PENDING_UPLOADS {
            reserve(None)
                .await
                .expect("the owner keeps their reserved slots");
        }
        assert!(
            reserve(None).await.is_err(),
            "the owner-wide pending cap still applies"
        );

        let pending: i64 = transaction
            .query_one(
                "SELECT pending_uploads FROM user_storage_usage WHERE owner_id = 'usr_link_slots'",
                &[],
            )
            .await
            .expect("ledger should load")
            .get("pending_uploads");
        assert_eq!(pending, MAX_PENDING_UPLOADS);
        transaction
            .rollback()
            .await
            .expect("test transaction should roll back");
    }

    #[test]
    fn replacement_credit_only_reserves_net_growth() {
        assert_eq!(
            reservation_amount(100, 40).unwrap(),
            ReservationAmount {
                ledger_bytes: 60,
                quota_delta: 60,
            }
        );
        assert_eq!(
            reservation_amount(100, 100).unwrap(),
            ReservationAmount {
                ledger_bytes: 0,
                quota_delta: 0,
            }
        );
        assert_eq!(
            reservation_amount(40, 100).unwrap(),
            ReservationAmount {
                ledger_bytes: 0,
                quota_delta: -60,
            }
        );
    }

    #[test]
    fn reservation_inputs_cannot_be_negative() {
        assert!(reservation_amount(-1, 0).is_err());
        assert!(reservation_amount(0, -1).is_err());
    }
}
