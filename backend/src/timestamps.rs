use time::OffsetDateTime;

pub fn api(value: OffsetDateTime) -> String {
    let value = value.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
    )
}

pub fn optional_api(value: Option<OffsetDateTime>) -> Option<String> {
    value.map(api)
}

pub fn cursor(value: OffsetDateTime) -> String {
    let value = value.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:06}Z",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.nanosecond() / 1_000,
    )
}

pub fn version_millis(value: OffsetDateTime) -> String {
    let value = value.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}{:03}",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.nanosecond() / 1_000_000,
    )
}

pub fn version_micros(value: OffsetDateTime) -> String {
    let value = value.to_offset(time::UtcOffset::UTC);
    format!(
        "{:04}{:02}{:02}{:02}{:02}{:02}{:06}",
        value.year(),
        u8::from(value.month()),
        value.day(),
        value.hour(),
        value.minute(),
        value.second(),
        value.nanosecond() / 1_000,
    )
}

#[cfg(test)]
mod tests {
    use time::{Date, Month, PrimitiveDateTime, Time, UtcOffset};

    use super::{api, cursor, version_micros, version_millis};

    #[test]
    fn preserves_the_existing_utc_wire_formats() {
        let date = Date::from_calendar_date(2026, Month::August, 15).expect("valid date");
        let time = Time::from_hms_micro(14, 3, 7, 123_456).expect("valid time");
        let value = PrimitiveDateTime::new(date, time).assume_offset(UtcOffset::UTC);

        assert_eq!(api(value), "2026-08-15T14:03:07Z");
        assert_eq!(cursor(value), "2026-08-15T14:03:07.123456Z");
        assert_eq!(version_millis(value), "20260815140307123");
        assert_eq!(version_micros(value), "20260815140307123456");
    }

    #[test]
    fn hot_route_queries_never_format_timestamps_in_postgres() {
        for (name, source) in [
            ("auth", include_str!("auth.rs")),
            ("admin", include_str!("routes/admin.rs")),
            ("files", include_str!("routes/files.rs")),
            ("invitations", include_str!("routes/invitations.rs")),
            ("repositories", include_str!("routes/repositories.rs")),
            ("share_links", include_str!("routes/share_links.rs")),
            ("vault", include_str!("routes/vault.rs")),
        ] {
            assert!(
                !source.to_ascii_lowercase().contains("to_char("),
                "{name} moved timestamp formatting back into PostgreSQL"
            );
        }
    }
}
