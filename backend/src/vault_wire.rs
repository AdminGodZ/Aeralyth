use std::fmt;

use bytes::Bytes;

const MAGIC: &[u8; 4] = b"AVLT";
const VERSION: u8 = 1;
const NODE_PUBLICATION: u8 = 1;
const SHARE_DIRECTORY: u8 = 2;
const CREATE_SHARE: u8 = 3;
const PUBLISH_EPOCH: u8 = 4;
const NULL_LENGTH: u32 = u32::MAX;

#[derive(Debug)]
pub struct WireError(&'static str);

impl fmt::Display for WireError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for WireError {}

pub struct CompletedPart {
    pub part_number: i32,
    pub etag: String,
    pub checksum_sha256: String,
}

pub struct NodePublication {
    pub parts: Vec<CompletedPart>,
    pub bootstrap_cbor: Bytes,
    pub bootstrap_signature: Bytes,
    pub encrypted_manifest: Bytes,
    pub wrappers: Vec<Bytes>,
}

pub struct ShareDirectoryPublication {
    pub directory_cbor: Option<Bytes>,
    pub directory_signature: Option<Bytes>,
    pub wrappers: Vec<Bytes>,
}

pub struct SignedEnvelope {
    pub canonical_cbor: Bytes,
    pub signature: Bytes,
}

pub struct OwnerEpochKey {
    pub wrapper_id: Bytes,
    pub ciphertext: Bytes,
}

pub struct CreateSharePublication {
    pub share_id: String,
    pub root_node_id: String,
    pub recipient_id: String,
    pub recipient_key_version: u64,
    pub wrappers: Vec<Bytes>,
    pub envelopes: Vec<SignedEnvelope>,
    pub owner_epoch_key: OwnerEpochKey,
}

pub struct PublishEpochPublication {
    pub fence_snapshot_hash: Bytes,
    pub wrappers: Vec<Bytes>,
    pub envelopes: Vec<SignedEnvelope>,
    pub owner_epoch_key: OwnerEpochKey,
}

pub fn decode_node_publication(input: Bytes) -> Result<NodePublication, WireError> {
    let mut reader = Reader::new(input, NODE_PUBLICATION)?;
    let part_count = reader.count(10_000)?;
    let mut parts = Vec::with_capacity(part_count);
    for _ in 0..part_count {
        let part_number =
            i32::try_from(reader.u32()?).map_err(|_| WireError("upload part number is invalid"))?;
        parts.push(CompletedPart {
            part_number,
            etag: reader.text(1_024)?,
            checksum_sha256: reader.text(256)?,
        });
    }
    let publication = NodePublication {
        parts,
        bootstrap_cbor: reader.bytes(65_536)?,
        bootstrap_signature: reader.fixed_bytes(64)?,
        encrypted_manifest: reader.bytes(1_048_576)?,
        wrappers: reader.bytes_array(4_096, 65_536)?,
    };
    reader.finish()?;
    Ok(publication)
}

pub fn decode_share_directory(input: Bytes) -> Result<ShareDirectoryPublication, WireError> {
    let mut reader = Reader::new(input, SHARE_DIRECTORY)?;
    let publication = ShareDirectoryPublication {
        directory_cbor: reader.optional_bytes(4_096)?,
        directory_signature: reader.optional_fixed_bytes(64)?,
        wrappers: reader.bytes_array(8_192, 65_536)?,
    };
    reader.finish()?;
    Ok(publication)
}

pub fn decode_create_share(input: Bytes) -> Result<CreateSharePublication, WireError> {
    let mut reader = Reader::new(input, CREATE_SHARE)?;
    let publication = CreateSharePublication {
        share_id: reader.text(128)?,
        root_node_id: reader.text(128)?,
        recipient_id: reader.text(128)?,
        recipient_key_version: reader.u64()?,
        wrappers: reader.bytes_array(8_192, 65_536)?,
        envelopes: reader.envelopes()?,
        owner_epoch_key: reader.owner_epoch_key()?,
    };
    reader.finish()?;
    Ok(publication)
}

pub fn decode_publish_epoch(input: Bytes) -> Result<PublishEpochPublication, WireError> {
    let mut reader = Reader::new(input, PUBLISH_EPOCH)?;
    let publication = PublishEpochPublication {
        fence_snapshot_hash: reader.fixed_bytes(32)?,
        wrappers: reader.bytes_array(8_192, 65_536)?,
        envelopes: reader.envelopes()?,
        owner_epoch_key: reader.owner_epoch_key()?,
    };
    reader.finish()?;
    Ok(publication)
}

struct Reader {
    input: Bytes,
    offset: usize,
}

impl Reader {
    fn new(input: Bytes, expected_kind: u8) -> Result<Self, WireError> {
        if input.len() < 8
            || &input[..4] != MAGIC
            || input[4] != VERSION
            || input[5] != expected_kind
            || input[6] != 0
            || input[7] != 0
        {
            return Err(WireError("vault binary publication header is invalid"));
        }
        Ok(Self { input, offset: 8 })
    }

    fn finish(&self) -> Result<(), WireError> {
        if self.offset == self.input.len() {
            Ok(())
        } else {
            Err(WireError("vault binary publication has trailing bytes"))
        }
    }

    fn count(&mut self, maximum: usize) -> Result<usize, WireError> {
        let count = usize::try_from(self.u32()?)
            .map_err(|_| WireError("vault binary array length is invalid"))?;
        if count > maximum {
            return Err(WireError("vault binary array is too large"));
        }
        Ok(count)
    }

    fn u32(&mut self) -> Result<u32, WireError> {
        Ok(u32::from_be_bytes(
            self.take(4)?.as_ref().try_into().expect("four-byte slice"),
        ))
    }

    fn u64(&mut self) -> Result<u64, WireError> {
        Ok(u64::from_be_bytes(
            self.take(8)?.as_ref().try_into().expect("eight-byte slice"),
        ))
    }

    fn text(&mut self, maximum: usize) -> Result<String, WireError> {
        let value = self.bytes(maximum)?;
        std::str::from_utf8(&value)
            .map(str::to_owned)
            .map_err(|_| WireError("vault binary text is not UTF-8"))
    }

    fn bytes(&mut self, maximum: usize) -> Result<Bytes, WireError> {
        let length = self.length()?;
        if length > maximum {
            return Err(WireError("vault binary field is too large"));
        }
        self.take(length)
    }

    fn fixed_bytes(&mut self, length: usize) -> Result<Bytes, WireError> {
        let value = self.bytes(length)?;
        if value.len() != length {
            return Err(WireError("vault binary field has an invalid length"));
        }
        Ok(value)
    }

    fn optional_bytes(&mut self, maximum: usize) -> Result<Option<Bytes>, WireError> {
        let encoded_length = self.u32()?;
        if encoded_length == NULL_LENGTH {
            return Ok(None);
        }
        let length = usize::try_from(encoded_length)
            .map_err(|_| WireError("vault binary field length is invalid"))?;
        if length > maximum {
            return Err(WireError("vault binary field is too large"));
        }
        self.take(length).map(Some)
    }

    fn optional_fixed_bytes(&mut self, length: usize) -> Result<Option<Bytes>, WireError> {
        let value = self.optional_bytes(length)?;
        if value.as_ref().is_some_and(|value| value.len() != length) {
            return Err(WireError("vault binary field has an invalid length"));
        }
        Ok(value)
    }

    fn bytes_array(
        &mut self,
        maximum_count: usize,
        maximum_item_bytes: usize,
    ) -> Result<Vec<Bytes>, WireError> {
        let count = self.count(maximum_count)?;
        (0..count).map(|_| self.bytes(maximum_item_bytes)).collect()
    }

    fn envelopes(&mut self) -> Result<Vec<SignedEnvelope>, WireError> {
        let count = self.count(1_024)?;
        (0..count)
            .map(|_| {
                Ok(SignedEnvelope {
                    canonical_cbor: self.bytes(131_072)?,
                    signature: self.fixed_bytes(64)?,
                })
            })
            .collect()
    }

    fn owner_epoch_key(&mut self) -> Result<OwnerEpochKey, WireError> {
        Ok(OwnerEpochKey {
            wrapper_id: self.fixed_bytes(16)?,
            ciphertext: self.fixed_bytes(48)?,
        })
    }

    fn length(&mut self) -> Result<usize, WireError> {
        usize::try_from(self.u32()?).map_err(|_| WireError("vault binary field length is invalid"))
    }

    fn take(&mut self, length: usize) -> Result<Bytes, WireError> {
        let end = self
            .offset
            .checked_add(length)
            .filter(|end| *end <= self.input.len())
            .ok_or(WireError("vault binary publication ended unexpectedly"))?;
        let value = self.input.slice(self.offset..end);
        self.offset = end;
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use std::hint::black_box;
    use std::time::Instant;

    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};

    use super::*;

    #[test]
    fn node_publication_slices_raw_fields_without_copying() {
        let mut input = header(NODE_PUBLICATION);
        push_u32(&mut input, 0);
        push_bytes(&mut input, &[1, 2, 3]);
        push_bytes(&mut input, &[4; 64]);
        push_bytes(&mut input, &[5, 6]);
        push_u32(&mut input, 1);
        push_bytes(&mut input, &[7, 8, 9]);
        let input = Bytes::from(input);
        let original_pointer = input.as_ptr() as usize;

        let decoded = decode_node_publication(input.clone()).unwrap();

        assert_eq!(decoded.bootstrap_cbor.as_ref(), &[1, 2, 3]);
        assert_eq!(decoded.wrappers[0].as_ref(), &[7, 8, 9]);
        let bootstrap_pointer = decoded.bootstrap_cbor.as_ptr() as usize;
        let wrapper_pointer = decoded.wrappers[0].as_ptr() as usize;
        assert!(bootstrap_pointer >= original_pointer);
        assert!(wrapper_pointer < original_pointer + input.len());
    }

    #[test]
    fn decodes_the_browser_version_one_node_fixture() {
        let fixture = format!(
            "41564c5401010000000000010000000700000001650000000163000000020102\
             00000040{}0000000304050600000001000000020708",
            "03".repeat(64),
        );
        let publication = decode_node_publication(bytes_from_hex(&fixture)).unwrap();

        assert_eq!(publication.parts.len(), 1);
        assert_eq!(publication.parts[0].part_number, 7);
        assert_eq!(publication.parts[0].etag, "e");
        assert_eq!(publication.parts[0].checksum_sha256, "c");
        assert_eq!(publication.bootstrap_cbor.as_ref(), &[1, 2]);
        assert_eq!(publication.bootstrap_signature.as_ref(), &[3; 64]);
        assert_eq!(publication.encrypted_manifest.as_ref(), &[4, 5, 6]);
        assert_eq!(publication.wrappers[0].as_ref(), &[7, 8]);
    }

    #[test]
    fn decodes_browser_share_publication_fixtures() {
        let directory = format!(
            "41564c5401020000000000010100000040{}00000001000000020506",
            "02".repeat(64),
        );
        let directory = decode_share_directory(bytes_from_hex(&directory)).unwrap();
        assert_eq!(directory.directory_cbor.unwrap().as_ref(), &[1]);
        assert_eq!(directory.directory_signature.unwrap().as_ref(), &[2; 64]);
        assert_eq!(directory.wrappers[0].as_ref(), &[5, 6]);

        let shared_tail = format!(
            "0000000100000002050600000001000000010100000040{}\
             00000010{}00000030{}",
            "02".repeat(64),
            "03".repeat(16),
            "04".repeat(48),
        );
        let created = format!(
            "41564c5401030000000000057368725f610000000566696c5f62\
             000000057573725f630000000000000007{shared_tail}"
        );
        let created = decode_create_share(bytes_from_hex(&created)).unwrap();
        assert_eq!(created.share_id, "shr_a");
        assert_eq!(created.root_node_id, "fil_b");
        assert_eq!(created.recipient_id, "usr_c");
        assert_eq!(created.recipient_key_version, 7);
        assert_eq!(created.wrappers[0].as_ref(), &[5, 6]);
        assert_eq!(created.envelopes[0].canonical_cbor.as_ref(), &[1]);
        assert_eq!(created.envelopes[0].signature.as_ref(), &[2; 64]);
        assert_eq!(created.owner_epoch_key.wrapper_id.as_ref(), &[3; 16]);
        assert_eq!(created.owner_epoch_key.ciphertext.as_ref(), &[4; 48]);

        let epoch = format!("41564c540104000000000020{}{shared_tail}", "08".repeat(32),);
        let epoch = decode_publish_epoch(bytes_from_hex(&epoch)).unwrap();
        assert_eq!(epoch.fence_snapshot_hash.as_ref(), &[8; 32]);
        assert_eq!(epoch.wrappers[0].as_ref(), &[5, 6]);
        assert_eq!(epoch.envelopes[0].canonical_cbor.as_ref(), &[1]);
        assert_eq!(epoch.owner_epoch_key.wrapper_id.as_ref(), &[3; 16]);
    }

    #[test]
    fn representative_share_publication_reuses_one_request_allocation() {
        const WRAPPER_COUNT: usize = 1_024;
        const WRAPPER_BYTES: usize = 4 * 1_024;
        const ENVELOPE_COUNT: usize = 128;
        const ENVELOPE_BYTES: usize = 512;
        const REPEATS: usize = 16;

        let mut input = header(CREATE_SHARE);
        push_bytes(&mut input, b"shr_representative");
        push_bytes(&mut input, b"fil_representative");
        push_bytes(&mut input, b"usr_representative");
        push_u64(&mut input, 7);
        push_u32(&mut input, WRAPPER_COUNT as u32);
        let wrapper = vec![7_u8; WRAPPER_BYTES];
        for _ in 0..WRAPPER_COUNT {
            push_bytes(&mut input, &wrapper);
        }
        push_u32(&mut input, ENVELOPE_COUNT as u32);
        let envelope = vec![8_u8; ENVELOPE_BYTES];
        for _ in 0..ENVELOPE_COUNT {
            push_bytes(&mut input, &envelope);
            push_bytes(&mut input, &[9_u8; 64]);
        }
        push_bytes(&mut input, &[3; 16]);
        push_bytes(&mut input, &[4; 48]);
        let input = Bytes::from(input);
        let allocation_start = input.as_ptr() as usize;
        let allocation_end = allocation_start + input.len();

        let decoded = decode_create_share(input.clone()).unwrap();
        assert_eq!(decoded.wrappers.len(), WRAPPER_COUNT);
        assert_eq!(decoded.envelopes.len(), ENVELOPE_COUNT);
        let copied_binary_field_bytes = decoded
            .wrappers
            .iter()
            .chain(
                decoded
                    .envelopes
                    .iter()
                    .flat_map(|envelope| [&envelope.canonical_cbor, &envelope.signature]),
            )
            .chain([
                &decoded.owner_epoch_key.wrapper_id,
                &decoded.owner_epoch_key.ciphertext,
            ])
            .filter(|field| {
                let pointer = field.as_ptr() as usize;
                pointer < allocation_start || pointer + field.len() > allocation_end
            })
            .map(|field| field.len())
            .sum::<usize>();
        assert_eq!(copied_binary_field_bytes, 0);

        let started = Instant::now();
        for _ in 0..REPEATS {
            black_box(decode_create_share(input.clone()).unwrap());
        }
        let decode_micros = started.elapsed().as_micros();
        let base64 = URL_SAFE_NO_PAD.encode(&input);
        let base64_started = Instant::now();
        for _ in 0..REPEATS {
            black_box(URL_SAFE_NO_PAD.decode(&base64).unwrap());
        }
        let base64_decode_micros = base64_started.elapsed().as_micros();
        assert!(base64.len() as f64 / input.len() as f64 > 1.33);
        assert!(decode_micros < base64_decode_micros);
        println!(
            "{{\"metric\":\"vault_binary_server_share_decode\",\"bodyBytes\":{},\"base64Bytes\":{},\"wireRatio\":{},\"repeats\":{REPEATS},\"binaryDecodeMicros\":{decode_micros},\"optimisticBase64DecodeMicros\":{base64_decode_micros},\"copiedBinaryFieldBytes\":{copied_binary_field_bytes}}}",
            input.len(),
            base64.len(),
            base64.len() as f64 / input.len() as f64,
        );
    }

    #[test]
    fn rejects_wrong_kinds_trailing_bytes_and_oversized_arrays() {
        let wrong_kind = Bytes::from(header(SHARE_DIRECTORY));
        assert!(decode_node_publication(wrong_kind).is_err());

        let mut trailing = header(SHARE_DIRECTORY);
        push_u32(&mut trailing, NULL_LENGTH);
        push_u32(&mut trailing, NULL_LENGTH);
        push_u32(&mut trailing, 0);
        trailing.push(9);
        assert!(decode_share_directory(Bytes::from(trailing)).is_err());

        let mut oversized = header(NODE_PUBLICATION);
        push_u32(&mut oversized, 10_001);
        assert!(decode_node_publication(Bytes::from(oversized)).is_err());
    }

    fn header(kind: u8) -> Vec<u8> {
        vec![MAGIC[0], MAGIC[1], MAGIC[2], MAGIC[3], VERSION, kind, 0, 0]
    }

    fn push_u32(output: &mut Vec<u8>, value: u32) {
        output.extend_from_slice(&value.to_be_bytes());
    }

    fn push_u64(output: &mut Vec<u8>, value: u64) {
        output.extend_from_slice(&value.to_be_bytes());
    }

    fn push_bytes(output: &mut Vec<u8>, value: &[u8]) {
        push_u32(output, value.len() as u32);
        output.extend_from_slice(value);
    }

    fn bytes_from_hex(value: &str) -> Bytes {
        let compact = value
            .bytes()
            .filter(|byte| !byte.is_ascii_whitespace())
            .collect::<Vec<_>>();
        assert_eq!(compact.len() % 2, 0);
        Bytes::from(
            compact
                .as_chunks::<2>()
                .0
                .iter()
                .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
                .collect::<Vec<_>>(),
        )
    }
}
