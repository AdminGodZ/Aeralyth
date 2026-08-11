use actix_web::{Result, error};
use deadpool_postgres::GenericClient;

use crate::db::{execute_cached, query_one_cached};

pub const MAX_PENDING_UPLOADS: i64 = 20;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReservationAmount {
    pub ledger_bytes: i64,
    pub quota_delta: i64,
}

pub async fn reserve_upload_capacity<Client>(
    client: &Client,
    owner_id: &str,
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
        return Ok(());
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
    use super::{ReservationAmount, reservation_amount};

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
