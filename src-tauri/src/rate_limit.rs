use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
struct Bucket {
    tokens: f64,
    updated: Instant,
}
pub struct RateLimit {
    per_second: f64,
    burst: f64,
    capacity: usize,
    buckets: HashMap<String, Bucket>,
}
impl RateLimit {
    pub fn new(per_second: f64, burst: u32, capacity: usize) -> Self {
        Self {
            per_second,
            burst: burst.into(),
            capacity,
            buckets: HashMap::new(),
        }
    }
    pub fn take(&mut self, key: &str) -> bool {
        self.take_at(key, Instant::now())
    }
    fn take_at(&mut self, key: &str, now: Instant) -> bool {
        self.buckets
            .retain(|_, b| now.saturating_duration_since(b.updated) < Duration::from_secs(60));
        if !self.buckets.contains_key(key) {
            if self.buckets.len() >= self.capacity {
                return false;
            }
            self.buckets.insert(
                key.into(),
                Bucket {
                    tokens: self.burst,
                    updated: now,
                },
            );
        }
        let bucket = self.buckets.get_mut(key).expect("bucket inserted");
        bucket.tokens = self.burst.min(
            bucket.tokens
                + now.saturating_duration_since(bucket.updated).as_secs_f64() * self.per_second,
        );
        bucket.updated = now;
        if bucket.tokens < 1.0 {
            return false;
        }
        bucket.tokens -= 1.0;
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn burst_refill_capacity_and_expiry_are_bounded() {
        let now = Instant::now();
        let mut limit = RateLimit::new(0.5, 2, 1);
        assert!(limit.take_at("one", now));
        assert!(limit.take_at("one", now));
        assert!(!limit.take_at("one", now));
        assert!(!limit.take_at("two", now));
        assert!(limit.take_at("one", now + Duration::from_secs(2)));
        assert!(limit.take_at("two", now + Duration::from_secs(62)));
        let mut slow = RateLimit::new(5.0 / 60.0, 3, 1);
        assert!(slow.take_at("one", now));
        assert!(slow.take_at("one", now));
        assert!(slow.take_at("one", now));
        assert!(!slow.take_at("one", now));
    }
}
