//! pgvector's three column types (`vector`, `halfvec`, `sparsevec`) read off the wire.
//!
//! sqlx asks Postgres for every result column in BINARY, and it has no mapping for an extension
//! type, so these cells used to fall through `decode_pg_cell!` to the raw-bytes branch — whose
//! "valid UTF-8 becomes a string" rule assumes Postgres sent text. pgvector's binary form is
//! packed big-endian numbers, so a `[1,2,3]` reached the grid as `[0,3,0,0,63,128,…]`, and a dump
//! wrote that byte list back as the cell's value: a backup that could not be restored.
//!
//! The cell is returned in pgvector's own TEXT syntax (`[1,2,3]`, `{1:1.5,3:2}/5`) rather than as
//! a JSON array of numbers, because that string is what every other path already expects of a
//! cell: it is what psql shows, what an edited cell is written back as, and what a dumped INSERT
//! casts back into the column — no path needs to learn a new shape.

/// Which of pgvector's types a column is, from `PgTypeInfo::name()`.
///
/// A type from an extension installed in another schema may come back qualified, hence the
/// last segment.
pub(crate) fn pgvector_kind(type_name: &str) -> Option<VectorKind> {
    match type_name.rsplit('.').next().unwrap_or(type_name) {
        "vector" => Some(VectorKind::Vector),
        "halfvec" => Some(VectorKind::HalfVec),
        "sparsevec" => Some(VectorKind::SparseVec),
        _ => None,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum VectorKind {
    Vector,
    HalfVec,
    SparseVec,
}

/// Decode pgvector's binary send format into its text syntax. `None` for a payload whose length
/// does not match its own header — the caller then keeps its generic fallback instead of guessing.
pub(crate) fn pgvector_text(kind: VectorKind, b: &[u8]) -> Option<String> {
    match kind {
        VectorKind::Vector => {
            let dim = dense_dim(b, 4)?;
            let vals = b[4..]
                .as_chunks::<4>()
                .0
                .iter()
                .take(dim)
                .map(|c| f32::from_be_bytes(*c));
            Some(dense_text(vals))
        }
        VectorKind::HalfVec => {
            let dim = dense_dim(b, 2)?;
            let vals = b[4..]
                .as_chunks::<2>()
                .0
                .iter()
                .take(dim)
                .map(|c| f16_to_f32(u16::from_be_bytes(*c)));
            Some(dense_text(vals))
        }
        VectorKind::SparseVec => {
            let dim = be_i32(b, 0)?;
            let nnz = usize::try_from(be_i32(b, 4)?).ok()?;
            // Header is dim, nnz and an unused word; then nnz indices, then nnz values.
            if dim < 0 || b.len() != 12 + nnz.checked_mul(8)? {
                return None;
            }
            let mut out = String::from("{");
            for k in 0..nnz {
                let idx = be_i32(b, 12 + 4 * k)?;
                let v = f32::from_be_bytes(b[12 + 4 * nnz + 4 * k..][..4].try_into().ok()?);
                if k > 0 {
                    out.push(',');
                }
                // Stored 0-based, written 1-based — the text form is what users type.
                out.push_str(&format!("{}:{}", i64::from(idx) + 1, fmt_float(v)));
            }
            out.push_str(&format!("}}/{dim}"));
            Some(out)
        }
    }
}

/// `int16 dim, int16 unused`, then `dim` elements of `width` bytes each.
fn dense_dim(b: &[u8], width: usize) -> Option<usize> {
    if b.len() < 4 {
        return None;
    }
    let dim = usize::from(u16::from_be_bytes([b[0], b[1]]));
    (b.len() == 4 + dim * width).then_some(dim)
}

fn be_i32(b: &[u8], at: usize) -> Option<i32> {
    Some(i32::from_be_bytes(b.get(at..at + 4)?.try_into().ok()?))
}

fn dense_text(vals: impl Iterator<Item = f32>) -> String {
    let parts: Vec<String> = vals.map(fmt_float).collect();
    format!("[{}]", parts.join(","))
}

/// Shortest round-trip spelling, switching to exponent form where pgvector does, so a small
/// component reads `1e-7` rather than `0.0000001`. Both parse back to the same float.
fn fmt_float(v: f32) -> String {
    let a = v.abs();
    if a != 0.0 && !(1e-4..1e15).contains(&a) {
        format!("{v:e}")
    } else {
        format!("{v}")
    }
}

/// IEEE 754 binary16 -> binary32. No `half` crate for one conversion.
fn f16_to_f32(h: u16) -> f32 {
    let sign = u32::from(h >> 15) << 31;
    let exp = u32::from((h >> 10) & 0x1f);
    let mant = u32::from(h & 0x3ff);
    let bits = match (exp, mant) {
        (0, 0) => sign,
        // Subnormal: value is mant * 2^-24, exact in an f32.
        (0, m) => {
            let v = m as f32 * 2f32.powi(-24);
            return if sign != 0 { -v } else { v };
        }
        (0x1f, 0) => sign | 0x7f80_0000,
        (0x1f, m) => sign | 0x7f80_0000 | (m << 13),
        (e, m) => sign | ((e + 127 - 15) << 23) | (m << 13),
    };
    f32::from_bits(bits)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(s: &str) -> Vec<u8> {
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
            .collect()
    }

    // Every payload below is what `vector_send` / `halfvec_send` / `sparsevec_send` returned on
    // pgvector 0.8.6, next to what psql printed for the same cell.

    #[test]
    fn vector_matches_psql() {
        let b = hex("000300003f8000004000000040400000");
        assert_eq!(pgvector_text(VectorKind::Vector, &b).unwrap(), "[1,2,3]");
        let b = hex("000300003dcccccdbe80000033d6bf95");
        assert_eq!(
            pgvector_text(VectorKind::Vector, &b).unwrap(),
            "[0.1,-0.25,1e-7]"
        );
    }

    #[test]
    fn halfvec_matches_psql() {
        let b = hex("000300003c0040004200");
        assert_eq!(pgvector_text(VectorKind::HalfVec, &b).unwrap(), "[1,2,3]");
        // 0.1 is not representable in binary16; psql prints the stored value the same way.
        let b = hex("000300002e66b4007bff");
        assert_eq!(
            pgvector_text(VectorKind::HalfVec, &b).unwrap(),
            "[0.099975586,-0.25,65504]"
        );
    }

    #[test]
    fn sparsevec_matches_psql() {
        let b = hex("00000005000000020000000000000000000000023fc0000040000000");
        assert_eq!(
            pgvector_text(VectorKind::SparseVec, &b).unwrap(),
            "{1:1.5,3:2}/5"
        );
        let b = hex("000000050000000000000000");
        assert_eq!(pgvector_text(VectorKind::SparseVec, &b).unwrap(), "{}/5");
        let b = hex("00000005000000010000000000000004c0400000");
        assert_eq!(
            pgvector_text(VectorKind::SparseVec, &b).unwrap(),
            "{5:-3}/5"
        );
    }

    #[test]
    fn a_length_that_disagrees_with_the_header_is_refused() {
        // Text-format bytes (`[1,2]`) must not be mistaken for a binary payload.
        assert_eq!(pgvector_text(VectorKind::Vector, b"[1,2]"), None);
        assert_eq!(pgvector_text(VectorKind::Vector, &hex("0003000000")), None);
        assert_eq!(pgvector_text(VectorKind::HalfVec, &hex("00")), None);
        assert_eq!(
            pgvector_text(
                VectorKind::SparseVec,
                &hex("00000005000000010000000000000004")
            ),
            None
        );
        assert_eq!(
            pgvector_text(VectorKind::SparseVec, &hex("00000005ffffffff00000000")),
            None
        );
    }

    #[test]
    fn kind_comes_from_the_type_name() {
        assert_eq!(pgvector_kind("vector"), Some(VectorKind::Vector));
        assert_eq!(
            pgvector_kind("extensions.halfvec"),
            Some(VectorKind::HalfVec)
        );
        assert_eq!(pgvector_kind("sparsevec"), Some(VectorKind::SparseVec));
        assert_eq!(pgvector_kind("tsvector"), None);
        assert_eq!(pgvector_kind("VECTOR"), None);
    }

    /// End to end through `decode_pg_cell!`, against a server with pgvector installed:
    /// `PG_URL=… cargo test --lib decodes_real_pgvector_cells -- --ignored`.
    #[tokio::test]
    #[ignore]
    async fn decodes_real_pgvector_cells() {
        use crate::database::decode::decode_pg_cell;
        use serde_json::{Value, json};
        use sqlx::{Row, ValueRef};

        let pool = sqlx::PgPool::connect(&std::env::var("PG_URL").unwrap())
            .await
            .unwrap();
        let row = sqlx::query(
            "SELECT '[1,2,3]'::vector, '[0.1,-0.25,65504]'::halfvec, '{1:1.5,3:2}/5'::sparsevec, NULL::vector",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        let cells: Vec<Value> = (0..4).map(|i| decode_pg_cell!(&row, i)).collect();
        assert_eq!(
            cells,
            vec![
                json!("[1,2,3]"),
                json!("[0.099975586,-0.25,65504]"),
                json!("{1:1.5,3:2}/5"),
                Value::Null
            ]
        );
    }

    #[test]
    fn f16_edge_values() {
        assert_eq!(f16_to_f32(0x0000), 0.0);
        assert_eq!(f16_to_f32(0x8000).to_bits(), (-0.0f32).to_bits());
        assert_eq!(f16_to_f32(0x0001), 2f32.powi(-24));
        assert_eq!(f16_to_f32(0x7bff), 65504.0);
        assert_eq!(f16_to_f32(0xbc00), -1.0);
    }
}
