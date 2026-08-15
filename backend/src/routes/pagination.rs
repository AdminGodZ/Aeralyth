use actix_web::{Result, error};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Serialize, de::DeserializeOwned};

const MAX_CURSOR_LENGTH: usize = 2_048;

pub(crate) fn decode_cursor<T>(encoded: Option<&str>) -> Result<Option<T>>
where
    T: DeserializeOwned,
{
    let Some(encoded) = encoded.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    if encoded.len() > MAX_CURSOR_LENGTH {
        return Err(error::ErrorBadRequest("invalid pagination cursor"));
    }

    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| error::ErrorBadRequest("invalid pagination cursor"))?;
    let cursor = serde_json::from_slice(&bytes)
        .map_err(|_| error::ErrorBadRequest("invalid pagination cursor"))?;
    Ok(Some(cursor))
}

pub(crate) fn encode_cursor<T>(cursor: &T) -> Result<String>
where
    T: Serialize,
{
    let bytes = serde_json::to_vec(cursor).map_err(error::ErrorInternalServerError)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn row_limit(page_size: usize) -> Result<i64> {
    i64::try_from(page_size.saturating_add(1))
        .map_err(|_| error::ErrorInternalServerError("invalid page size"))
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};

    use super::{decode_cursor, encode_cursor};

    #[derive(Debug, Deserialize, PartialEq, Serialize)]
    struct TestCursor {
        scope: String,
        id: String,
    }

    #[test]
    fn cursor_round_trip_is_url_safe_and_opaque() {
        let cursor = TestCursor {
            scope: "repositories".to_owned(),
            id: "repo_123".to_owned(),
        };
        let encoded = encode_cursor(&cursor).expect("cursor should encode");

        assert!(!encoded.contains(['+', '/', '=']));
        assert_eq!(
            decode_cursor::<TestCursor>(Some(&encoded)).expect("cursor should decode"),
            Some(cursor)
        );
    }

    #[test]
    fn malformed_or_oversized_cursors_are_rejected() {
        assert!(decode_cursor::<TestCursor>(Some("not-json")).is_err());
        assert!(decode_cursor::<TestCursor>(Some(&"a".repeat(2_049))).is_err());
    }
}
