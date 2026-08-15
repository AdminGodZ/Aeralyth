# Internal identifier storage policy

Aeralyth's existing public identifiers remain `TEXT` because rewriting every primary key, foreign key, cursor, encrypted record, and object reference would create more migration risk and temporary index overhead than its current measured benefit.

New high-volume tables must use a compact native internal key (`UUID` by default, or a deliberately benchmarked 16-byte alternative). Prefixed strings belong at the API boundary, not in new join/index keys. Existing legacy `TEXT` primary and foreign keys are frozen in `legacy_text_identifier_columns`; the database regression suite fails when an unapproved `TEXT` PK/FK is added.

Reconsider an online dual-key conversion of an existing table only when production relation sizes and representative join benchmarks justify the extra column, backfill, dual-write period, foreign-key swap, and rollback plan.
