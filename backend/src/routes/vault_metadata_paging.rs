//! Bound metadata identities and bytes before loading encrypted records.
use super::*;
use std::io::Write;
use std::sync::LazyLock;

const IDENTITY_QUERY: &str = r#"
    SELECT files.id, files.parent_id, files.state, files.current_generation_number,
           heads.record_version, heads.record_hash
    FROM unnest($1::text[]) WITH ORDINALITY AS requested(id, ordinal)
    CROSS JOIN LATERAL (
      SELECT files.id, files.parent_id, files.state, files.current_generation_number
      FROM visible_files AS files
      WHERE files.id = requested.id AND files.owner_id = $2
        AND files.e2ee_state = 'encrypted'
        AND (files.state = 'active' OR ($4 AND files.state = 'trashed'))
      LIMIT 1
    ) files
    JOIN vault_node_heads AS heads ON heads.node_id = files.id
    ORDER BY requested.ordinal
    LIMIT $3
"#;

const OWNED_SIZES_QUERY: &str = r#"
    SELECT files.id,
           (octet_length(records.bootstrap_cbor)::bigint
            + octet_length(records.bootstrap_signature)
            + octet_length(records.encrypted_manifest)
            + COALESCE((SELECT sum(octet_length(w.canonical_cbor))
                        FROM vault_wrappers w WHERE w.node_id = files.id
                        AND w.record_version = heads.record_version), 0))::bigint AS raw_bytes
    FROM unnest($1::text[]) AS requested(id)
    JOIN visible_files AS files ON files.id = requested.id
    JOIN vault_node_heads heads ON heads.node_id = files.id
    JOIN vault_node_records records ON records.node_id = heads.node_id
                                  AND records.record_version = heads.record_version
"#;

// This query loads identities, hashes and lengths only. Envelopes, manifests and
// wrapper/proof payloads are fetched only after the page has been selected.
pub(super) const SHARED_IDENTITY_QUERY: &str = r#"
    WITH RECURSIVE ancestors AS (
      SELECT id, parent_id, owner_id, ARRAY[id]::text[] AS visited_ids, 0 AS depth
      FROM visible_files AS files WHERE id = $1 AND state = 'active' AND e2ee_state = 'encrypted'
      UNION ALL
      SELECT p.id, p.parent_id, p.owner_id, a.visited_ids || p.id, a.depth + 1
      FROM ancestors a JOIN visible_files p ON p.id = a.parent_id
      WHERE p.state = 'active' AND p.e2ee_state = 'encrypted'
        AND a.depth < 100 AND NOT p.id = ANY(a.visited_ids)
    ), authorized AS MATERIALIZED (
      SELECT s.id, s.owner_id, s.root_node_id, s.active_epoch, s.record_version,
             r.recipient_key_version, e.wrapper_set_root
      FROM ancestors a JOIN vault_shares s ON s.root_node_id = a.id
      JOIN users u ON u.id = s.owner_id AND u.status = 'active'
      JOIN vault_share_recipients r ON r.share_id = s.id
        AND r.recipient_id = $2 AND r.status = 'active'
      JOIN vault_share_epochs e ON e.share_id = s.id AND e.epoch = s.active_epoch
        AND e.status = 'published'
      WHERE s.status = 'active'
      ORDER BY s.created_at, s.id LIMIT 1
    )
    SELECT f.id, f.parent_id, f.current_generation_number,
           h.record_version, h.record_hash,
           a.id AS share_id, a.active_epoch, a.record_version AS share_record_version,
           a.recipient_key_version, a.wrapper_set_root,
           envelope.envelope_hash, directory.wrapper_set_root AS directory_root,
           (octet_length(n.bootstrap_cbor)::bigint + octet_length(n.bootstrap_signature)
            + octet_length(n.encrypted_manifest)
            + COALESCE(envelope.raw_bytes, 0)
            + COALESCE(octet_length(directory.canonical_cbor), 0)
            + COALESCE(octet_length(directory.signature), 0)
            + COALESCE((SELECT sum(octet_length(w.canonical_cbor)::bigint
                                      + COALESCE(octet_length(w.merkle_proof),0))
                        FROM vault_share_wrappers w
                        WHERE w.share_id = a.id AND w.epoch = a.active_epoch
                          AND w.node_id = f.id AND w.record_version = h.record_version
                          AND (w.wrapper_kind = 'metadata' OR
                               (w.wrapper_kind = 'generation_dek'
                                AND w.generation_id = f.current_generation_id))), 0))::bigint AS raw_bytes
    FROM authorized a JOIN visible_files f ON f.id = $1 AND f.owner_id = a.owner_id
    JOIN vault_node_heads h ON h.node_id = f.id
    JOIN vault_node_records n ON n.node_id = h.node_id AND n.record_version = h.record_version
    LEFT JOIN LATERAL (
      SELECT env.envelope_hash,
             (octet_length(env.canonical_cbor)::bigint + octet_length(env.signature)) AS raw_bytes
      FROM vault_share_envelopes env
      WHERE env.share_id = a.id AND env.epoch = a.active_epoch AND env.recipient_id = $2
      ORDER BY env.created_at DESC, env.envelope_id DESC LIMIT 1
    ) envelope ON TRUE
    LEFT JOIN vault_share_wrapper_directories directory
      ON directory.node_id = f.id AND directory.record_version = h.record_version
"#;

#[derive(Clone, Debug)]
struct Identity {
    id: String,
    parent_id: Option<String>,
    version: i64,
    hash: Vec<u8>,
    generation: i64,
    scope: String,
    raw_bytes: usize,
    shared: bool,
}

pub(super) struct Page {
    pub owned_rows: Vec<tokio_postgres::Row>,
    pub wrapper_rows: Vec<tokio_postgres::Row>,
    pub shared_rows: Vec<(String, tokio_postgres::Row)>,
    pub order: Vec<String>,
    pub continuation: Option<usize>,
    pub snapshot: String,
}

fn conflict() -> actix_web::Error {
    error::ErrorConflict("metadata snapshot changed; restart metadata resolution")
}

fn order_identities(
    ids: &[String],
    nodes: &HashMap<String, Identity>,
    include_owned_ancestors: bool,
) -> Result<Vec<Identity>> {
    fn visit(
        id: &str,
        nodes: &HashMap<String, Identity>,
        visiting: &mut HashSet<String>,
        emitted: &mut HashSet<String>,
        ordered: &mut Vec<Identity>,
        depth: usize,
        include_owned_ancestors: bool,
    ) -> Result<()> {
        if emitted.contains(id) {
            return Ok(());
        }
        let Some(node) = nodes.get(id) else {
            return Err(conflict());
        };
        if depth > 100 || !visiting.insert(id.to_owned()) {
            return Err(error::ErrorConflict(
                "metadata hierarchy is cyclic or too deep",
            ));
        }
        if include_owned_ancestors
            && !node.shared
            && let Some(parent) = &node.parent_id
        {
            visit(parent, nodes, visiting, emitted, ordered, depth + 1, true)?;
        }
        visiting.remove(id);
        emitted.insert(id.to_owned());
        ordered.push(node.clone());
        Ok(())
    }
    let mut ordered = Vec::with_capacity(nodes.len());
    let mut emitted = HashSet::with_capacity(nodes.len());
    for id in ids {
        visit(
            id,
            nodes,
            &mut HashSet::new(),
            &mut emitted,
            &mut ordered,
            0,
            include_owned_ancestors,
        )?;
    }
    Ok(ordered)
}

fn snapshot(identities: &[Identity], user: &str, purpose: bool) -> String {
    let mut hash = Sha256::new();
    hash.update(b"aeralyth/metadata-page/v1");
    let mut field = |bytes: &[u8]| {
        hash.update((bytes.len() as u64).to_be_bytes());
        hash.update(bytes);
    };
    field(user.as_bytes());
    field(&[u8::from(purpose)]);
    for identity in identities {
        field(identity.id.as_bytes());
        field(identity.parent_id.as_deref().unwrap_or("").as_bytes());
        field(&identity.version.to_be_bytes());
        field(&identity.hash);
        field(&identity.generation.to_be_bytes());
        field(identity.scope.as_bytes());
        field(&(identity.raw_bytes as u64).to_be_bytes());
    }
    encode_bytes(hash.finalize())
}

fn select_page(identities: &[Identity], offset: usize) -> Result<usize> {
    if offset > identities.len() {
        return Err(error::ErrorBadRequest("metadata continuation is invalid"));
    }
    // JSON base64 expansion is <= 4/3. Two times binary bytes plus 16 KiB per
    // record also covers proof arrays, keys, numeric fields and escaped IDs.
    let mut budget = 1024usize;
    let mut end = offset;
    for identity in &identities[offset..] {
        let estimate = identity
            .raw_bytes
            .saturating_mul(2)
            .saturating_add(16 * 1024);
        if budget.saturating_add(estimate) > MAX_METADATA_PLAN_RESPONSE_BYTES {
            break;
        }
        budget += estimate;
        end += 1;
    }
    if end == offset && offset < identities.len() {
        return Err(error::ErrorPayloadTooLarge(
            "one metadata record exceeds the bounded page budget",
        ));
    }
    Ok(end)
}

pub(super) async fn load_page(
    state: &AppState,
    user: &SessionPrincipal,
    body: &MetadataPlansRequest,
) -> Result<Page> {
    let mut client = state.db.get().await.map_err(crate::db::http_error)?;
    let transaction = client
        .build_transaction()
        .isolation_level(IsolationLevel::RepeatableRead)
        .start()
        .await
        .map_err(error::ErrorInternalServerError)?;
    let page = load_transaction_page(&transaction, &user.id, body).await?;
    transaction
        .commit()
        .await
        .map_err(error::ErrorInternalServerError)?;
    drop(client);
    Ok(page)
}

pub(super) async fn load_transaction_page(
    transaction: &deadpool_postgres::Transaction<'_>,
    user_id: &str,
    body: &MetadataPlansRequest,
) -> Result<Page> {
    let share_preparation = body.purpose == MetadataPlanPurpose::SharePreparation;
    let offset = body.continuation.unwrap_or(0);
    if offset > MAX_METADATA_PLAN_EXPANDED_NODES {
        return Err(conflict());
    }
    let mut nodes = HashMap::new();
    let mut attempted = HashSet::new();
    let mut frontier = body.node_ids.clone();
    for _depth in 0..=100 {
        frontier.retain(|id| attempted.insert(id.clone()));
        if frontier.is_empty() {
            break;
        }
        let limit = (MAX_METADATA_PLAN_EXPANDED_NODES - nodes.len() + 1) as i64;
        let rows = query_cached(
            transaction,
            IDENTITY_QUERY,
            &[&frontier, &user_id, &limit, &!share_preparation],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
        if nodes.len() + rows.len() > MAX_METADATA_PLAN_EXPANDED_NODES {
            return Err(error::ErrorPayloadTooLarge(
                "metadata plan ancestry exceeds the bounded batch limit",
            ));
        }
        frontier.clear();
        for row in rows {
            let id: String = row.get("id");
            let parent_id: Option<String> = row.get("parent_id");
            if !share_preparation && let Some(parent) = &parent_id {
                frontier.push(parent.clone());
            }
            nodes.insert(
                id.clone(),
                Identity {
                    id,
                    parent_id,
                    version: row.get("record_version"),
                    hash: row.get("record_hash"),
                    generation: row.get("current_generation_number"),
                    scope: row.get("state"),
                    raw_bytes: 0,
                    shared: false,
                },
            );
        }
        if share_preparation {
            break;
        }
    }
    if frontier
        .iter()
        .any(|id| !attempted.contains(id) && !nodes.contains_key(id))
    {
        return Err(error::ErrorConflict(
            "metadata ancestry exceeds the supported depth",
        ));
    }
    if share_preparation && nodes.len() != body.node_ids.len() {
        return Err(conflict());
    }
    let owned_ids: Vec<_> = nodes.keys().cloned().collect();
    if !owned_ids.is_empty() {
        let rows = query_cached(transaction, OWNED_SIZES_QUERY, &[&owned_ids])
            .await
            .map_err(error::ErrorInternalServerError)?;
        if rows.len() != owned_ids.len() {
            return Err(conflict());
        }
        for row in rows {
            let id: String = row.get("id");
            nodes
                .get_mut(&id)
                .expect("selected owned identity")
                .raw_bytes = usize::try_from(row.get::<_, i64>("raw_bytes"))
                .map_err(error::ErrorInternalServerError)?;
        }
    }
    if !share_preparation {
        let shared_ids: Vec<_> = body
            .node_ids
            .iter()
            .filter(|id| !owned_ids.contains(id))
            .cloned()
            .collect();
        if nodes.len().saturating_add(shared_ids.len()) > MAX_METADATA_PLAN_EXPANDED_NODES {
            return Err(error::ErrorPayloadTooLarge(
                "metadata identity budget exceeded",
            ));
        }
        let rows = if shared_ids.is_empty() {
            Vec::new()
        } else {
            query_cached(
                transaction,
                &SHARED_IDENTITY_BATCH_QUERY,
                &[&shared_ids, &user_id],
            )
            .await
            .map_err(error::ErrorInternalServerError)?
        };
        for row in rows {
            let id: String = row.get("id");
            let scope = serde_json::to_string(&(
                row.get::<_, String>("share_id"),
                row.get::<_, i64>("active_epoch"),
                row.get::<_, i64>("share_record_version"),
                row.get::<_, i64>("recipient_key_version"),
                row.get::<_, Option<Vec<u8>>>("wrapper_set_root"),
                row.get::<_, Option<Vec<u8>>>("envelope_hash"),
                row.get::<_, Option<Vec<u8>>>("directory_root"),
            ))
            .map_err(error::ErrorInternalServerError)?;
            nodes.insert(
                id.clone(),
                Identity {
                    id: id.clone(),
                    parent_id: row.get("parent_id"),
                    version: row.get("record_version"),
                    hash: row.get("record_hash"),
                    generation: row.get("current_generation_number"),
                    scope,
                    raw_bytes: usize::try_from(row.get::<_, i64>("raw_bytes"))
                        .map_err(error::ErrorInternalServerError)?,
                    shared: true,
                },
            );
        }
    }
    if body.node_ids.iter().any(|id| !nodes.contains_key(id)) {
        return Err(if body.snapshot.is_some() || offset > 0 {
            conflict()
        } else {
            error::ErrorNotFound("requested metadata is not available")
        });
    }
    let ordered = order_identities(&body.node_ids, &nodes, !share_preparation)?;
    let snapshot = snapshot(&ordered, user_id, share_preparation);
    if (offset > 0 && body.snapshot.is_none())
        || body
            .snapshot
            .as_ref()
            .is_some_and(|previous| previous != &snapshot)
    {
        return Err(conflict());
    }
    let end = select_page(&ordered, offset)?;
    let selected = &ordered[offset..end];
    let selected_owned: Vec<_> = selected
        .iter()
        .filter(|id| !id.shared)
        .map(|id| id.id.clone())
        .collect();
    let owned_rows = if selected_owned.is_empty() {
        Vec::new()
    } else {
        query_cached(
            transaction,
            if share_preparation {
                OWNED_SHARE_PREPARATION_PLANS_QUERY
            } else {
                OWNED_METADATA_PLANS_QUERY
            },
            &[&selected_owned, &user_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
    };
    let wrapper_rows = if selected_owned.is_empty() {
        Vec::new()
    } else {
        query_cached(
            transaction,
            OWNED_METADATA_WRAPPERS_QUERY,
            &[&selected_owned],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
    };
    let selected_shared: Vec<_> = selected
        .iter()
        .filter(|id| id.shared)
        .map(|id| id.id.clone())
        .collect();
    let shared_rows = if selected_shared.is_empty() {
        Vec::new()
    } else {
        query_cached(
            transaction,
            &SHARED_PAYLOAD_BATCH_QUERY,
            &[&selected_shared, &user_id],
        )
        .await
        .map_err(error::ErrorInternalServerError)?
        .into_iter()
        .map(|row| (row.get::<_, String>("requested_node_id"), row))
        .collect::<Vec<_>>()
    };
    if shared_rows.len() != selected_shared.len() || owned_rows.len() != selected_owned.len() {
        return Err(conflict());
    }
    Ok(Page {
        owned_rows,
        wrapper_rows,
        shared_rows,
        order: selected.iter().map(|node| node.id.clone()).collect(),
        continuation: (end < ordered.len()).then_some(end),
        snapshot,
    })
}

// Built once so every page reuses the same SQL text and its cached prepared statement.
static SHARED_IDENTITY_BATCH_QUERY: LazyLock<String> = LazyLock::new(|| {
    let query = SHARED_IDENTITY_QUERY.replace("$1", "requested.node_id");
    format!(
        "SELECT snapshot.* FROM unnest($1::text[]) WITH ORDINALITY AS requested(node_id,ordinal) CROSS JOIN LATERAL ({query}) snapshot ORDER BY requested.ordinal"
    )
});

static SHARED_PAYLOAD_BATCH_QUERY: LazyLock<String> = LazyLock::new(|| {
    let query = SHARED_DOWNLOAD_SNAPSHOT_QUERY.replace("$1", "requested.node_id");
    format!(
        "SELECT requested.node_id AS requested_node_id, snapshot.* FROM unnest($1::text[]) WITH ORDINALITY AS requested(node_id,ordinal) CROSS JOIN LATERAL ({query}) snapshot ORDER BY requested.ordinal"
    )
});

struct CappedWriter {
    bytes: Vec<u8>,
    limit: usize,
}
impl Write for CappedWriter {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.bytes.len().saturating_add(bytes.len()) > self.limit {
            return Err(std::io::Error::other(
                "metadata response exceeds byte budget",
            ));
        }
        let required = self.bytes.len() + bytes.len();
        if required > self.bytes.capacity() {
            let capacity = self
                .bytes
                .capacity()
                .saturating_mul(2)
                .max(required)
                .min(self.limit);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .map_err(std::io::Error::other)?;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub(super) fn encode_page(
    mut plans: Vec<MetadataPlanResponse>,
    order: Vec<String>,
    continuation: Option<usize>,
    snapshot: String,
) -> std::result::Result<Bytes, (u16, String)> {
    let positions: HashMap<_, _> = order
        .iter()
        .enumerate()
        .map(|(index, id)| (id.as_str(), index))
        .collect();
    plans.sort_by_key(|plan| positions.get(plan.node_id.as_str()).copied());
    if plans.len() != order.len()
        || plans
            .iter()
            .zip(&order)
            .any(|(plan, id)| &plan.node_id != id)
    {
        return Err((
            409,
            "metadata page is incomplete; restart metadata resolution".into(),
        ));
    }
    let mut writer = CappedWriter {
        bytes: Vec::new(),
        limit: MAX_METADATA_PLAN_RESPONSE_BYTES,
    };
    let response = MetadataPlansResponse {
        plans,
        continuation,
        snapshot,
    };
    serde_json::to_writer(&mut writer, &response).map_err(|failure| {
        if failure.is_io() {
            (413, failure.to_string())
        } else {
            (500, failure.to_string())
        }
    })?;
    Ok(Bytes::from(writer.bytes))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(id: &str, parent: Option<&str>, bytes: usize) -> Identity {
        Identity {
            id: id.into(),
            parent_id: parent.map(str::to_owned),
            version: 1,
            hash: vec![1; 32],
            generation: 1,
            scope: "active".into(),
            raw_bytes: bytes,
            shared: false,
        }
    }

    #[test]
    fn shared_ancestors_are_emitted_once_before_children() {
        let nodes = [
            identity("root", None, 10),
            identity("a", Some("root"), 10),
            identity("b", Some("root"), 10),
        ]
        .into_iter()
        .map(|node| (node.id.clone(), node))
        .collect();
        let ordered = order_identities(&["b".into(), "a".into()], &nodes, true).unwrap();
        assert_eq!(
            ordered.iter().map(|n| n.id.as_str()).collect::<Vec<_>>(),
            vec!["root", "b", "a"]
        );
        let cyclic = [identity("a", Some("b"), 10), identity("b", Some("a"), 10)]
            .into_iter()
            .map(|node| (node.id.clone(), node))
            .collect();
        assert!(order_identities(&["a".into()], &cyclic, true).is_err());
    }

    #[test]
    fn incomplete_requested_and_owned_key_chains_fail_closed() {
        let nodes = [identity("child", Some("missing_parent"), 10)]
            .into_iter()
            .map(|node| (node.id.clone(), node))
            .collect();
        assert!(order_identities(&["missing_request".into()], &nodes, true).is_err());
        assert!(order_identities(&["child".into()], &nodes, true).is_err());
        // Share preparation intentionally selects exact IDs, without key ancestors.
        assert_eq!(
            order_identities(&["child".into()], &nodes, false)
                .unwrap()
                .len(),
            1
        );
        let mut shared = identity("shared", Some("outside_share"), 10);
        shared.shared = true;
        let nodes = [(shared.id.clone(), shared)].into_iter().collect();
        assert_eq!(
            order_identities(&["shared".into()], &nodes, true)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn paging_limits_payload_bytes_before_rows_are_fetched() {
        let nodes: Vec<_> = (0..20)
            .map(|n| identity(&n.to_string(), None, 1024 * 1024))
            .collect();
        assert_eq!(select_page(&nodes, 0).unwrap(), 3);
        assert_eq!(select_page(&nodes, 3).unwrap(), 6);
        assert_eq!(select_page(&nodes, 18).unwrap(), 20);
        assert!(select_page(&nodes, 21).is_err());
        assert!(
            select_page(
                &[identity("huge", None, MAX_METADATA_PLAN_RESPONSE_BYTES)],
                0
            )
            .is_err()
        );
    }

    #[test]
    fn snapshot_binds_identity_record_ancestry_generation_and_permissions() {
        let original = vec![identity("a", None, 10)];
        let expected = snapshot(&original, "owner", false);
        assert_ne!(expected, snapshot(&original, "other", false));
        assert_ne!(expected, snapshot(&original, "owner", true));
        for change in 0..6 {
            let mut nodes = original.clone();
            match change {
                0 => nodes[0].version += 1,
                1 => nodes[0].hash[0] += 1,
                2 => nodes[0].parent_id = Some("new-parent".into()),
                3 => nodes[0].generation += 1,
                4 => nodes[0].scope = "revoked".into(),
                _ => nodes[0].raw_bytes += 1,
            }
            assert_ne!(expected, snapshot(&nodes, "owner", false));
        }
    }

    #[test]
    fn capped_writer_never_allocates_past_response_limit() {
        let mut writer = CappedWriter {
            bytes: Vec::new(),
            limit: 5,
        };
        writer.write_all(b"12345").unwrap();
        assert!(writer.write_all(b"6").is_err());
        assert_eq!(writer.bytes, b"12345");
        assert!(writer.bytes.capacity() <= writer.limit);
        assert_eq!(
            encode_page(
                Vec::new(),
                vec!["missing".into()],
                None,
                "fingerprint".into()
            )
            .unwrap_err()
            .0,
            409
        );
        let encoded = encode_page(Vec::new(), Vec::new(), None, "fingerprint".into()).unwrap();
        let value: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(value["plans"], serde_json::json!([]));
        assert_eq!(value["snapshot"], "fingerprint");
        assert!(value.get("continuation").is_none());
    }

    #[test]
    fn metadata_encoding_allocation_benchmark() {
        fn plans(raw_bytes: usize, count: usize) -> Vec<MetadataPlanResponse> {
            (0..count)
                .map(|index| MetadataPlanResponse {
                    node_id: format!("fil_bench_{index}"),
                    entry_type: "file".into(),
                    generation_number: 1,
                    generation_id: "A".repeat(22),
                    ciphertext_length: 4112,
                    crypto_chunk_bytes: CRYPTO_CHUNK_BYTES as i32,
                    chunk_count: 1,
                    ciphertext_merkle_root: "A".repeat(43),
                    bootstrap_cbor: encode_bytes(vec![0; 128]),
                    bootstrap_signature: encode_bytes(vec![0; 64]),
                    encrypted_manifest: encode_bytes(vec![1; raw_bytes]),
                    wrappers: vec![encode_bytes(vec![0; 128])],
                    signer_key_version: 1,
                    signer_ed25519_public_key: "A".repeat(43),
                    record_version: 1,
                    record_hash: "A".repeat(43),
                    share: None,
                })
                .collect()
        }
        fn encode_fixture(
            plans: Vec<MetadataPlanResponse>,
            order: Vec<String>,
            one_pass: bool,
        ) -> Bytes {
            let count = plans.len();
            if one_pass {
                encode_page(plans, order, Some(count), "benchmark".into()).unwrap()
            } else {
                let sized_bytes: usize = plans
                    .iter()
                    .map(|plan| serde_json::to_vec(plan).unwrap().len())
                    .sum();
                assert!(sized_bytes < MAX_METADATA_PLAN_RESPONSE_BYTES);
                Bytes::from(
                    serde_json::to_vec(&MetadataPlansResponse {
                        plans,
                        continuation: Some(count),
                        snapshot: "benchmark".into(),
                    })
                    .unwrap(),
                )
            }
        }
        const OTHER_BINARY_BYTES: usize = 128 + 64 + 128;
        let max_page_record_bytes =
            (MAX_METADATA_PLAN_RESPONSE_BYTES - 1024 - 4 * 16 * 1024) / 8 - OTHER_BINARY_BYTES;
        for (profile, bytes, count, iterations) in [
            ("small", 64, 8, 100),
            ("maximum_schema_sized_page", max_page_record_bytes, 4, 8),
        ] {
            let identities: Vec<_> = (0..count)
                .map(|index| identity(&index.to_string(), None, bytes + OTHER_BINARY_BYTES))
                .collect();
            assert_eq!(select_page(&identities, 0).unwrap(), count);
            let mut summaries = Vec::new();
            let mut reference = None;
            let mut timings = [0_u128; 2];
            // Warm both paths, then alternate their order. Allocation measurement
            // runs separately, with its counter disabled during these timings.
            for iteration in 0..iterations + 2 {
                for one_pass in if iteration % 2 == 0 {
                    [false, true]
                } else {
                    [true, false]
                } {
                    let plans = plans(bytes, count);
                    let order = plans.iter().map(|plan| plan.node_id.clone()).collect();
                    let started = std::time::Instant::now();
                    let body = encode_fixture(plans, order, one_pass);
                    let elapsed = started.elapsed().as_nanos();
                    std::hint::black_box(&body);
                    if iteration >= 2 {
                        timings[usize::from(one_pass)] += elapsed;
                    }
                }
            }
            for one_pass in [false, true] {
                let mut allocation_bytes = 0_usize;
                let mut allocations = 0_usize;
                for _ in 0..iterations {
                    let plans = plans(bytes, count);
                    let order = plans.iter().map(|plan| plan.node_id.clone()).collect();
                    let (body, allocated, calls) =
                        crate::test_allocations::measure(|| encode_fixture(plans, order, one_pass));
                    if let Some(expected) = &reference {
                        assert_eq!(&body, expected);
                    } else {
                        reference = Some(body.clone());
                    }
                    allocation_bytes += allocated;
                    allocations += calls;
                }
                let row = serde_json::json!({
                    "profile": profile, "implementation": if one_pass { "one_pass" } else { "historical_two_pass" },
                    "release": !cfg!(debug_assertions), "iterations": iterations,
                    "plans": count, "raw_manifest_bytes_per_plan": bytes,
                    "response_bytes": reference.as_ref().unwrap().len(),
                    "mean_encode_nanoseconds": timings[usize::from(one_pass)] / iterations as u128,
                    "timing_allocation_counter_enabled": false,
                    "fixture_crypto_validated": false,
                    "mean_requested_allocation_bytes": allocation_bytes / iterations,
                    "mean_allocation_calls": allocations / iterations,
                });
                println!("metadata_encode_benchmark={row}");
                summaries.push(allocation_bytes);
            }
            assert!(
                summaries[1] < summaries[0],
                "one-pass encoding must reduce allocation volume"
            );
        }
    }

    async fn fixture(transaction: &tokio_postgres::Transaction<'_>) {
        transaction.batch_execute(r#"
            CREATE TEMP TABLE files (
                id text PRIMARY KEY, parent_id text, owner_id text NOT NULL DEFAULT 'owner',
                state text NOT NULL DEFAULT 'active', e2ee_state text NOT NULL DEFAULT 'encrypted',
                entry_type text NOT NULL DEFAULT 'folder', current_generation_number bigint DEFAULT 1,
                current_generation_id bytea DEFAULT decode(repeat('aa',16),'hex')
            );
            CREATE TEMP VIEW visible_files AS SELECT * FROM files;
            CREATE TEMP TABLE vault_node_heads (node_id text PRIMARY KEY, record_version bigint DEFAULT 1,
                record_hash bytea DEFAULT decode(repeat('ab',32),'hex'));
            CREATE TEMP TABLE vault_node_records (node_id text, record_version bigint DEFAULT 1,
                owner_id text DEFAULT 'owner', bootstrap_cbor bytea DEFAULT '\x01',
                bootstrap_signature bytea DEFAULT '\x02', encrypted_manifest bytea DEFAULT '\x03',
                signer_key_version bigint DEFAULT 1, PRIMARY KEY(node_id,record_version));
            CREATE TEMP TABLE vault_wrappers (node_id text, record_version bigint DEFAULT 1,
                wrapper_id bytea, canonical_cbor bytea);
            CREATE TEMP TABLE vault_identity_keys (user_id text, key_version bigint,
                ed25519_public_key bytea);
            CREATE TEMP TABLE vault_object_generations (node_id text,generation_number bigint,
                status text,ciphertext_length bigint,crypto_chunk_bytes integer,chunk_count integer,
                ciphertext_merkle_root bytea);
            INSERT INTO vault_identity_keys VALUES ('owner',1,decode(repeat('01',32),'hex'));
        "#).await.unwrap();
    }

    fn request(ids: Vec<String>) -> MetadataPlansRequest {
        MetadataPlansRequest {
            node_ids: ids,
            continuation: None,
            snapshot: None,
            purpose: MetadataPlanPurpose::Listing,
        }
    }

    #[tokio::test]
    #[ignore = "requires isolated PostgreSQL DATABASE_URL"]
    async fn metadata_database_pages_load_only_selected_payloads_and_reject_changed_snapshot() {
        let mut client = crate::db::test_client(&std::env::var("DATABASE_URL").unwrap()).await;
        let transaction = client.transaction().await.unwrap();
        fixture(&transaction).await;
        transaction.batch_execute(r#"
            INSERT INTO files(id) VALUES ('root');
            INSERT INTO files(id,parent_id,entry_type) SELECT 'child_'||n,'root','file' FROM generate_series(1,20) n;
            INSERT INTO vault_node_heads(node_id) SELECT id FROM files;
            INSERT INTO vault_node_records(node_id,encrypted_manifest)
                SELECT id,decode(repeat('ff',1048576),'hex') FROM files;
        "#).await.unwrap();
        let mut body = request((1..=20).map(|n| format!("child_{n}")).collect());
        let first = load_transaction_page(&transaction, "owner", &body)
            .await
            .unwrap();
        assert_eq!(first.order[0], "root");
        assert_eq!(first.owned_rows.len(), 3);
        assert_eq!(first.continuation, Some(3));
        assert_eq!(
            first
                .owned_rows
                .iter()
                .map(|r| r.get::<_, Vec<u8>>("encrypted_manifest").len())
                .sum::<usize>(),
            3 * 1024 * 1024
        );
        body.continuation = first.continuation;
        body.snapshot = Some(first.snapshot.clone());
        let second = load_transaction_page(&transaction, "owner", &body)
            .await
            .unwrap();
        assert_eq!(second.owned_rows.len(), 3);
        assert!(second.order.iter().all(|id| !first.order.contains(id)));
        let mut seen = first.order;
        seen.extend(second.order);
        body.continuation = second.continuation;
        while body.continuation.is_some() {
            let page = load_transaction_page(&transaction, "owner", &body)
                .await
                .unwrap();
            seen.extend(page.order);
            body.continuation = page.continuation;
        }
        assert_eq!(seen.len(), 21);
        assert_eq!(seen.iter().collect::<HashSet<_>>().len(), 21);
        body.continuation = Some(3);
        transaction.execute("UPDATE vault_node_heads SET record_hash = decode(repeat('ff',32),'hex') WHERE node_id='child_20'",&[]).await.unwrap();
        assert_eq!(
            load_transaction_page(&transaction, "owner", &body)
                .await
                .err()
                .unwrap()
                .as_response_error()
                .status_code(),
            actix_web::http::StatusCode::CONFLICT
        );
        transaction.rollback().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated PostgreSQL DATABASE_URL"]
    async fn metadata_database_rejects_missing_requests_and_owned_ancestors() {
        let mut client = crate::db::test_client(&std::env::var("DATABASE_URL").unwrap()).await;
        let transaction = client.transaction().await.unwrap();
        fixture(&transaction).await;
        transaction
            .batch_execute(
                r#"
            INSERT INTO files(id,parent_id) VALUES ('root',NULL),('orphan','unavailable_parent');
            INSERT INTO vault_node_heads(node_id) SELECT id FROM files;
            INSERT INTO vault_node_records(node_id) SELECT id FROM files;
        "#,
            )
            .await
            .unwrap();
        for ids in [
            vec!["missing".into()],
            vec!["root".into(), "missing".into()],
        ] {
            let mut body = request(ids);
            assert_eq!(
                load_transaction_page(&transaction, "owner", &body)
                    .await
                    .err()
                    .unwrap()
                    .as_response_error()
                    .status_code(),
                actix_web::http::StatusCode::NOT_FOUND
            );
            body.snapshot = Some("previous".into());
            assert_eq!(
                load_transaction_page(&transaction, "owner", &body)
                    .await
                    .err()
                    .unwrap()
                    .as_response_error()
                    .status_code(),
                actix_web::http::StatusCode::CONFLICT
            );
        }
        let body = request(vec!["orphan".into()]);
        assert_eq!(
            load_transaction_page(&transaction, "owner", &body)
                .await
                .err()
                .unwrap()
                .as_response_error()
                .status_code(),
            actix_web::http::StatusCode::CONFLICT
        );
        transaction.rollback().await.unwrap();
    }

    #[tokio::test]
    #[ignore = "requires isolated PostgreSQL DATABASE_URL"]
    async fn metadata_database_rejects_disjoint_ancestry_before_reading_record_contents() {
        let mut client = crate::db::test_client(&std::env::var("DATABASE_URL").unwrap()).await;
        let transaction = client.transaction().await.unwrap();
        fixture(&transaction).await;
        transaction
            .batch_execute(
                r#"
            INSERT INTO files(id,parent_id)
            SELECT 'chain_'||chain||'_'||depth,
                   CASE WHEN depth>0 THEN 'chain_'||chain||'_'||(depth-1) ELSE NULL END
            FROM generate_series(1,6) chain CROSS JOIN generate_series(0,99) depth;
            INSERT INTO vault_node_heads(node_id) SELECT id FROM files;
            -- No record rows: identity rejection must precede any payload/sizing load.
        "#,
            )
            .await
            .unwrap();
        let body = request((1..=6).map(|n| format!("chain_{n}_99")).collect());
        let failure = load_transaction_page(&transaction, "owner", &body)
            .await
            .err()
            .unwrap();
        assert_eq!(
            failure.as_response_error().status_code(),
            actix_web::http::StatusCode::PAYLOAD_TOO_LARGE
        );
        let plan = transaction
            .query(
                &format!("EXPLAIN (ANALYZE,BUFFERS) {IDENTITY_QUERY}"),
                &[&body.node_ids, &"owner", &7_i64, &true],
            )
            .await
            .unwrap();
        for row in plan {
            println!("metadata_identity_plan={}", row.get::<_, String>(0));
        }
        transaction.rollback().await.unwrap();
    }
}
