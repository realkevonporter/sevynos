//! Minimal UTC clock helpers (ISO-8601, no chrono — the relay crate
//! stays small and std-only plus crypto).

use std::time::{SystemTime, UNIX_EPOCH};

/// Current UTC time as ISO-8601, e.g. `2026-11-25T22:00:00Z`.
pub fn iso_now() -> String {
    iso_from_system_time(SystemTime::now())
}

pub fn iso_from_system_time(t: SystemTime) -> String {
    let secs = t
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    iso_from_unix_secs(secs)
}

fn iso_from_unix_secs(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let tod = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let (hh, mm, ss) = (tod / 3600, (tod % 3600) / 60, tod % 60);
    format!("{year:04}-{month:02}-{day:02}T{hh:02}:{mm:02}:{ss:02}Z")
}

/// Days since 1970-01-01 -> (year, month, day). Howard Hinnant's
/// civil-from-days algorithm; valid for the whole i64 day range.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_dates() {
        // 1970-01-01T00:00:00Z
        assert_eq!(iso_from_unix_secs(0), "1970-01-01T00:00:00Z");
        // 2026-11-25T00:00:00Z
        assert_eq!(iso_from_unix_secs(1_795_564_800), "2026-11-25T00:00:00Z");
        // 2000-02-29 (leap day) 12:34:56Z
        assert_eq!(iso_from_unix_secs(951_827_696), "2000-02-29T12:34:56Z");
    }
}
