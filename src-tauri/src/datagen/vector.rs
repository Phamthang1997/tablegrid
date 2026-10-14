//! The `vector` generator: random pgvector values, in the text form an INSERT casts from.
//!
//! Components are standard normal, then (by default) scaled to unit length. A normalized Gaussian
//! vector is uniform on the sphere, which is what real embeddings look like to an ANN index —
//! uniform components in [0, 1) would all sit in one orthant and make every cosine distance small.

use super::rng::Rng;

/// Upper bound on dimensions, matching pgvector's own limit for `vector` (16,000). A typo of an
/// extra zero must not make each row a megabyte.
pub(super) const MAX_DIMS: usize = 16_000;

/// `[a,b,c]`, or `{i:v,…}/dims` when `non_zero` is given (a sparsevec, indices 1-based).
pub(super) fn random_vector(
    rng: &mut Rng,
    dims: usize,
    non_zero: Option<usize>,
    normalize: bool,
) -> String {
    let dims = dims.clamp(1, MAX_DIMS);
    match non_zero {
        None => {
            let mut v: Vec<f64> = (0..dims).map(|_| rng.normal()).collect();
            if normalize {
                unit(&mut v);
            }
            let parts: Vec<String> = v.iter().map(|x| fmt(*x)).collect();
            format!("[{}]", parts.join(","))
        }
        Some(k) => {
            let k = k.clamp(1, dims);
            let idx = pick_distinct(rng, dims, k);
            let mut v: Vec<f64> = (0..k).map(|_| rng.normal()).collect();
            if normalize {
                unit(&mut v);
            }
            let parts: Vec<String> = idx
                .iter()
                .zip(&v)
                .map(|(i, x)| format!("{}:{}", i + 1, fmt(*x)))
                .collect();
            format!("{{{}}}/{}", parts.join(","), dims)
        }
    }
}

fn unit(v: &mut [f64]) {
    let n = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    // A zero draw has probability zero, but a zero vector has no cosine distance, so guard it.
    if n > 0.0 {
        v.iter_mut().for_each(|x| *x /= n);
    } else if let Some(first) = v.first_mut() {
        *first = 1.0;
    }
}

/// `k` distinct indices in `0..n`, ascending — Floyd's algorithm, so a 30,000-dim sparsevec with
/// 10 non-zeros costs 10 draws, not a shuffle of 30,000.
fn pick_distinct(rng: &mut Rng, n: usize, k: usize) -> Vec<usize> {
    let mut chosen = std::collections::BTreeSet::new();
    for j in (n - k)..n {
        let t = rng.below(j as u64 + 1) as usize;
        if !chosen.insert(t) {
            chosen.insert(j);
        }
    }
    chosen.into_iter().collect()
}

/// f32 precision is all a `vector` stores, so write the shortest f32 spelling.
fn fmt(x: f64) -> String {
    format!("{}", x as f32)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_dense(s: &str) -> Vec<f64> {
        s.trim_start_matches('[')
            .trim_end_matches(']')
            .split(',')
            .map(|x| x.parse().unwrap())
            .collect()
    }

    #[test]
    fn dense_has_the_dims_and_unit_length() {
        let mut r = Rng::new(1);
        let v = parse_dense(&random_vector(&mut r, 384, None, true));
        assert_eq!(v.len(), 384);
        let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        assert!((norm - 1.0).abs() < 1e-4, "{norm}");
        // Both signs: uniform on the sphere, not one orthant.
        assert!(v.iter().any(|x| *x < 0.0) && v.iter().any(|x| *x > 0.0));
    }

    #[test]
    fn unnormalized_is_not_scaled() {
        let mut r = Rng::new(2);
        let v = parse_dense(&random_vector(&mut r, 1000, None, false));
        let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
        // A standard normal in 1000 dims has norm ~sqrt(1000) ≈ 31.6.
        assert!(norm > 20.0, "{norm}");
    }

    #[test]
    fn sparse_uses_distinct_ascending_one_based_indices() {
        let mut r = Rng::new(3);
        for _ in 0..50 {
            let s = random_vector(&mut r, 30, Some(10), true);
            let (body, dims) = s.trim_start_matches('{').split_once("}/").unwrap();
            assert_eq!(dims, "30");
            let idx: Vec<usize> = body
                .split(',')
                .map(|p| p.split(':').next().unwrap().parse().unwrap())
                .collect();
            assert_eq!(idx.len(), 10);
            assert!(idx.windows(2).all(|w| w[0] < w[1]), "{s}");
            assert!(idx.iter().all(|i| (1..=30).contains(i)), "{s}");
        }
    }

    #[test]
    fn sparse_with_every_index_and_clamped_inputs() {
        let mut r = Rng::new(4);
        let s = random_vector(&mut r, 3, Some(99), true);
        assert!(
            s.starts_with("{1:") && s.contains(",2:") && s.contains(",3:") && s.ends_with("}/3"),
            "{s}"
        );
        assert_eq!(parse_dense(&random_vector(&mut r, 0, None, true)).len(), 1);
        assert_eq!(
            parse_dense(&random_vector(&mut r, 1_000_000, None, false)).len(),
            MAX_DIMS
        );
    }

    #[test]
    fn the_same_seed_replays() {
        assert_eq!(
            random_vector(&mut Rng::new(9), 16, None, true),
            random_vector(&mut Rng::new(9), 16, None, true)
        );
    }
}
