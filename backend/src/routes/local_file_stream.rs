use actix_web::{Error, error, web};
use futures_util::{Stream, StreamExt};
use tokio::io::AsyncRead;
use tokio_util::io::ReaderStream;

const LOCAL_DOWNLOAD_BUFFER_BYTES: usize = 64 * 1024;

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
    use std::pin::Pin;
    use std::task::{Context, Poll};

    use futures_util::StreamExt;
    use tokio::io::{AsyncRead, ReadBuf};

    use super::local_file_stream;

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
