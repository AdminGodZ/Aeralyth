use actix_web::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE,
    ETAG, IF_RANGE, RANGE,
};
use actix_web::http::{Method, StatusCode};
use actix_web::{Error, HttpRequest, HttpResponse, Result, error, web};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use futures_util::{Stream, StreamExt};
use sha2::{Digest, Sha256};
use tokio::fs::File;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncSeekExt};
use tokio_util::io::ReaderStream;

const LOCAL_DOWNLOAD_BUFFER_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq)]
enum DownloadRange {
    Full,
    Partial { start: u64, end: u64 },
    Unsatisfiable,
}

// Replacements get a new storage key. Include the opened object's filesystem
// identity as well, so atomic republication at the same path invalidates a resume.
fn content_etag(storage_identity: &str, metadata: &std::fs::Metadata) -> String {
    let mut digest = Sha256::new();
    digest.update(storage_identity.as_bytes());
    digest.update([0]);
    digest.update(metadata.len().to_be_bytes());
    if let Ok(modified) = metadata.modified()
        && let Ok(modified) = modified.duration_since(std::time::UNIX_EPOCH)
    {
        digest.update(modified.as_nanos().to_be_bytes());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        digest.update(metadata.dev().to_be_bytes());
        digest.update(metadata.ino().to_be_bytes());
        digest.update(metadata.ctime().to_be_bytes());
        digest.update(metadata.ctime_nsec().to_be_bytes());
    }
    format!("\"{}\"", URL_SAFE_NO_PAD.encode(digest.finalize()))
}

fn range_number(value: &str) -> Option<u64> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    // A decimal beyond u64 is still valid HTTP syntax. Saturation preserves its
    // meaning for a suffix or end offset without permitting arithmetic overflow.
    Some(value.bytes().fold(0_u64, |number, byte| {
        number
            .saturating_mul(10)
            .saturating_add(u64::from(byte - b'0'))
    }))
}

fn download_range(request: &HttpRequest, size_bytes: u64, etag: &str) -> DownloadRange {
    if request.method() != Method::GET {
        return DownloadRange::Full;
    }
    let mut ranges = request.headers().get_all(RANGE);
    let Some(range) = ranges.next() else {
        return DownloadRange::Full;
    };
    // Multipart ranges are deliberately unsupported. Ignoring them gives the
    // client a normal full representation, as allowed by HTTP range semantics.
    if ranges.next().is_some() {
        return DownloadRange::Full;
    }
    let mut validators = request.headers().get_all(IF_RANGE);
    if let Some(validator) = validators.next()
        && (validators.next().is_some() || validator.as_bytes() != etag.as_bytes())
    {
        // Weak tags, stale tags and dates cannot establish this immutable version.
        return DownloadRange::Full;
    }
    let Ok(range) = range.to_str() else {
        return DownloadRange::Unsatisfiable;
    };
    let Some((unit, range)) = range.trim().split_once('=') else {
        return DownloadRange::Full;
    };
    if !unit.eq_ignore_ascii_case("bytes") || range.contains(',') {
        return DownloadRange::Full;
    }
    let Some((start, end)) = range.split_once('-') else {
        return DownloadRange::Unsatisfiable;
    };
    if size_bytes == 0 {
        return DownloadRange::Unsatisfiable;
    }
    if start.is_empty() {
        return match range_number(end) {
            Some(suffix) if suffix > 0 => DownloadRange::Partial {
                start: size_bytes.saturating_sub(suffix),
                end: size_bytes - 1,
            },
            _ => DownloadRange::Unsatisfiable,
        };
    }
    let Some(start) = range_number(start).filter(|start| *start < size_bytes) else {
        return DownloadRange::Unsatisfiable;
    };
    let end = if end.is_empty() {
        size_bytes - 1
    } else {
        let Some(end) = range_number(end).filter(|end| *end >= start) else {
            return DownloadRange::Unsatisfiable;
        };
        end.min(size_bytes - 1)
    };
    DownloadRange::Partial { start, end }
}

pub(crate) async fn local_download_response(
    request: &HttpRequest,
    mut stored_file: File,
    storage_identity: &str,
    content_type: &str,
    original_name: &str,
) -> Result<HttpResponse> {
    let metadata = stored_file
        .metadata()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let size_bytes = metadata.len();
    let etag = content_etag(storage_identity, &metadata);
    let range = download_range(request, size_bytes, &etag);
    let mut response = HttpResponse::build(match range {
        DownloadRange::Full => StatusCode::OK,
        DownloadRange::Partial { .. } => StatusCode::PARTIAL_CONTENT,
        DownloadRange::Unsatisfiable => StatusCode::RANGE_NOT_SATISFIABLE,
    });
    response
        // Preserve byte offsets and the strong validator through compression proxies.
        .insert_header((CACHE_CONTROL, "private, no-store, no-transform"))
        .insert_header((ACCEPT_RANGES, "bytes"))
        .insert_header((ETAG, etag))
        .insert_header((CONTENT_TYPE, content_type))
        .insert_header((
            CONTENT_DISPOSITION,
            format!(
                "attachment; filename=\"{}\"",
                original_name.replace(['"', '\r', '\n'], "")
            ),
        ));
    let length = match range {
        DownloadRange::Full => size_bytes,
        DownloadRange::Partial { start, end } => {
            stored_file
                .seek(std::io::SeekFrom::Start(start))
                .await
                .map_err(error::ErrorInternalServerError)?;
            response.insert_header((CONTENT_RANGE, format!("bytes {start}-{end}/{size_bytes}")));
            end - start + 1
        }
        DownloadRange::Unsatisfiable => {
            return Ok(response
                .insert_header((CONTENT_RANGE, format!("bytes */{size_bytes}")))
                .insert_header((CONTENT_LENGTH, "0"))
                .finish());
        }
    };
    Ok(response
        .insert_header((CONTENT_LENGTH, length.to_string()))
        .streaming(local_file_stream(stored_file.take(length))))
}

pub(crate) fn local_file_stream<R>(reader: R) -> impl Stream<Item = Result<web::Bytes, Error>>
where
    R: AsyncRead,
{
    ReaderStream::with_capacity(reader, LOCAL_DOWNLOAD_BUFFER_BYTES)
        .map(|chunk| chunk.map_err(error::ErrorInternalServerError))
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::path::PathBuf;
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use actix_web::body::to_bytes;
    use actix_web::http::StatusCode;
    use actix_web::http::header::{
        ACCEPT_RANGES, CACHE_CONTROL, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, ETAG,
        IF_RANGE, RANGE,
    };
    use actix_web::test::TestRequest;
    use futures_util::StreamExt;
    use tokio::fs::File;
    use tokio::io::{AsyncRead, ReadBuf};

    use super::{local_download_response, local_file_stream};

    struct StoredObject(PathBuf);

    impl StoredObject {
        fn new(bytes: &[u8]) -> Self {
            let random = getrandom::u64().expect("random temporary filename");
            let path = std::env::temp_dir().join(format!("aeralyth-range-{random}"));
            std::fs::write(&path, bytes).expect("write test object");
            Self(path)
        }

        async fn response(
            &self,
            range: Option<&str>,
            if_range: Option<&str>,
            generation: &str,
        ) -> actix_web::HttpResponse {
            let mut request = TestRequest::get();
            if let Some(range) = range {
                request = request.insert_header((RANGE, range));
            }
            if let Some(if_range) = if_range {
                request = request.insert_header((IF_RANGE, if_range));
            }
            local_download_response(
                &request.to_http_request(),
                File::open(&self.0).await.expect("open test object"),
                generation,
                "application/octet-stream",
                "test\"\r\n.bin",
            )
            .await
            .expect("local download response")
        }
    }

    impl Drop for StoredObject {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    #[actix_web::test]
    async fn single_ranges_transfer_only_the_selected_bytes() {
        let stored = StoredObject::new(b"0123456789");
        for (range, expected, content_range) in [
            ("bytes=0-2", &b"012"[..], "bytes 0-2/10"),
            ("bytes=4-6", &b"456"[..], "bytes 4-6/10"),
            ("bytes=7-", &b"789"[..], "bytes 7-9/10"),
            ("bytes=-3", &b"789"[..], "bytes 7-9/10"),
            ("bytes=9-100", &b"9"[..], "bytes 9-9/10"),
            ("bytes=-100", &b"0123456789"[..], "bytes 0-9/10"),
            (
                "bytes=-99999999999999999999999999999999999999",
                &b"0123456789"[..],
                "bytes 0-9/10",
            ),
            (
                "bytes=9-99999999999999999999999999999999999999",
                &b"9"[..],
                "bytes 9-9/10",
            ),
        ] {
            let response = stored.response(Some(range), None, "generation-1").await;
            assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT, "{range}");
            assert_eq!(
                response.headers().get(CONTENT_RANGE).expect("header"),
                content_range,
                "{range}"
            );
            assert_eq!(
                response.headers().get(CONTENT_LENGTH).expect("header"),
                expected.len().to_string().as_str(),
                "{range}"
            );
            assert_eq!(
                response.headers().get(ACCEPT_RANGES).expect("header"),
                "bytes"
            );
            assert_eq!(
                response.headers().get(CACHE_CONTROL).expect("header"),
                "private, no-store, no-transform"
            );
            assert_eq!(
                response.headers().get(CONTENT_DISPOSITION).expect("header"),
                "attachment; filename=\"test.bin\""
            );
            assert_eq!(
                to_bytes(response.into_body()).await.expect("stream body"),
                expected,
                "{range}"
            );
        }
    }

    #[actix_web::test]
    async fn invalid_and_unsatisfiable_ranges_have_empty_416_responses() {
        let stored = StoredObject::new(b"0123456789");
        for range in [
            "bytes=10-",
            "bytes=10-11",
            "bytes=4-3",
            "bytes=-0",
            "bytes=-",
            "bytes=abc-def",
            "bytes=+1-3",
            "bytes=0-2-3",
            "bytes=999999999999999999999999999999-",
        ] {
            let response = stored.response(Some(range), None, "generation-1").await;
            assert_eq!(
                response.status(),
                StatusCode::RANGE_NOT_SATISFIABLE,
                "{range}"
            );
            assert_eq!(
                response.headers().get(CONTENT_RANGE).expect("header"),
                "bytes */10"
            );
            assert_eq!(response.headers().get(CONTENT_LENGTH).expect("header"), "0");
            assert_eq!(
                response.headers().get(CACHE_CONTROL).expect("header"),
                "private, no-store, no-transform"
            );
            assert!(
                to_bytes(response.into_body())
                    .await
                    .expect("body")
                    .is_empty()
            );
        }
    }

    #[actix_web::test]
    async fn absent_and_unsupported_ranges_transfer_the_full_object() {
        let stored = StoredObject::new(b"0123456789");
        for range in [None, Some("items=0-2"), Some("bytes=0-2,7-9")] {
            let response = stored.response(range, None, "generation-1").await;
            assert_eq!(response.status(), StatusCode::OK);
            assert!(!response.headers().contains_key(CONTENT_RANGE));
            assert_eq!(
                response.headers().get(CONTENT_LENGTH).expect("header"),
                "10"
            );
            assert_eq!(
                response.headers().get(CACHE_CONTROL).expect("header"),
                "private, no-store, no-transform"
            );
            assert_eq!(
                to_bytes(response.into_body()).await.expect("body"),
                &b"0123456789"[..]
            );
        }
    }

    #[actix_web::test]
    async fn if_range_resumes_only_the_same_immutable_generation() {
        let stored = StoredObject::new(b"0123456789");
        let original = stored.response(None, None, "generation-1").await;
        let original_etag = original
            .headers()
            .get(ETAG)
            .expect("header")
            .to_str()
            .expect("etag")
            .to_owned();
        let response = stored
            .response(Some("bytes=7-"), Some(&original_etag), "generation-1")
            .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(
            to_bytes(response.into_body()).await.expect("body"),
            &b"789"[..]
        );

        // A same-sized replacement must not be appended to an older checkpoint.
        let replacement = StoredObject::new(b"abcdefghij");
        let response = replacement
            .response(Some("bytes=7-"), Some(&original_etag), "generation-2")
            .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_ne!(
            response.headers().get(ETAG).expect("header"),
            original_etag.as_str()
        );
        assert!(!response.headers().contains_key(CONTENT_RANGE));
        assert_eq!(
            to_bytes(response.into_body()).await.expect("body"),
            &b"abcdefghij"[..]
        );

        for validator in [
            format!("W/{original_etag}"),
            "Tue, 01 Sep 2026 12:00:00 GMT".into(),
        ] {
            let response = stored
                .response(Some("bytes=7-"), Some(&validator), "generation-1")
                .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(
                to_bytes(response.into_body()).await.expect("body"),
                &b"0123456789"[..]
            );
        }
        let republished = replacement
            .response(Some("bytes=7-"), Some(&original_etag), "generation-1")
            .await;
        assert_eq!(republished.status(), StatusCode::OK);
        assert_ne!(
            republished.headers().get(ETAG).expect("etag"),
            original_etag.as_str()
        );
    }

    #[actix_web::test]
    async fn empty_objects_support_full_downloads_and_reject_byte_ranges() {
        let stored = StoredObject::new(b"");
        let full = stored.response(None, None, "empty").await;
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers().get(CONTENT_LENGTH).expect("header"), "0");
        assert!(to_bytes(full.into_body()).await.expect("body").is_empty());
        let partial = stored.response(Some("bytes=0-"), None, "empty").await;
        assert_eq!(partial.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(
            partial.headers().get(CONTENT_RANGE).expect("header"),
            "bytes */0"
        );
        assert!(
            to_bytes(partial.into_body())
                .await
                .expect("body")
                .is_empty()
        );
    }

    #[actix_web::test]
    async fn resumed_stream_crosses_multiple_buffers_without_transferring_the_prefix() {
        let bytes: Vec<u8> = (0..300_000).map(|index| (index % 251) as u8).collect();
        let stored = StoredObject::new(&bytes);
        let response = stored
            .response(Some("bytes=100003-280009"), None, "large-generation")
            .await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        let transferred = to_bytes(response.into_body()).await.expect("body");
        assert_eq!(transferred.len(), 180_007);
        assert_eq!(transferred, &bytes[100_003..=280_009]);
    }

    #[actix_web::test]
    async fn compressible_downloads_preserve_byte_ranges_and_validators_through_proxies() {
        let stored = StoredObject::new(b"compressible text payload");
        for (range, expected_status) in [
            (None, StatusCode::OK),
            (Some("bytes=0-11"), StatusCode::PARTIAL_CONTENT),
            (Some("bytes=100-"), StatusCode::RANGE_NOT_SATISFIABLE),
        ] {
            let mut request = TestRequest::get()
                .insert_header((actix_web::http::header::ACCEPT_ENCODING, "gzip, zstd"));
            if let Some(range) = range {
                request = request.insert_header((RANGE, range));
            }
            let response = local_download_response(
                &request.to_http_request(),
                File::open(&stored.0).await.expect("open test object"),
                "text-generation",
                "text/plain",
                "test.txt",
            )
            .await
            .expect("text download");
            assert_eq!(response.status(), expected_status);
            assert_eq!(
                response.headers().get(CACHE_CONTROL).expect("cache policy"),
                "private, no-store, no-transform"
            );
            assert_eq!(
                response.headers().get(ACCEPT_RANGES).expect("ranges"),
                "bytes"
            );
            assert!(response.headers().contains_key(ETAG));
            assert!(
                !response
                    .headers()
                    .contains_key(actix_web::http::header::CONTENT_ENCODING)
            );
        }
    }

    struct FailingReader;

    impl AsyncRead for FailingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _context: &mut Context<'_>,
            _buffer: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Ready(Err(io::Error::other("injected read failure")))
        }
    }

    #[actix_web::test]
    async fn a_read_error_terminates_the_stream() {
        let stream = local_file_stream(FailingReader);
        futures_util::pin_mut!(stream);

        assert!(stream.next().await.expect("error item").is_err());
        assert!(stream.next().await.is_none());
    }
}
