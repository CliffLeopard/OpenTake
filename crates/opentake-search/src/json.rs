//! Tiny JSON writer helpers. The crate is dependency-free by design, so the
//! few JSON payloads the integration contract needs are rendered here.

use std::fmt::Write as _;

/// Render `value` as a JSON string literal (quotes and escapes included).
pub fn string(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Finite f32 as a JSON number (non-finite values render as `0`).
pub fn f32_number(value: f32) -> String {
    if value.is_finite() {
        format!("{value}")
    } else {
        "0".to_string()
    }
}

/// Finite f64 as a JSON number (non-finite values render as `0`).
pub fn f64_number(value: f64) -> String {
    if value.is_finite() {
        format!("{value}")
    } else {
        "0".to_string()
    }
}

/// `null` or a JSON number for an optional score-like field.
pub fn optional_f32(value: Option<f32>) -> String {
    value.map_or_else(|| "null".to_string(), f32_number)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_json_strings() {
        assert_eq!(string("plain"), "\"plain\"");
        assert_eq!(string("a\"b\\c\n\t"), "\"a\\\"b\\\\c\\n\\t\"");
        assert_eq!(string("bell\u{0007}"), "\"bell\\u0007\"");
        assert_eq!(string("unicode ✓"), "\"unicode ✓\"");
    }

    #[test]
    fn renders_finite_numbers_and_rejects_non_finite() {
        assert_eq!(f32_number(1.5), "1.5");
        assert_eq!(f32_number(f32::NAN), "0");
        assert_eq!(f64_number(f64::INFINITY), "0");
        assert_eq!(optional_f32(None), "null");
        assert_eq!(optional_f32(Some(0.5)), "0.5");
    }
}
