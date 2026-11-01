interface Bucket { tokens: number; updated: number }
export class RateLimit {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly perSecond: number, private readonly burst: number,
    private readonly capacity = 1024, private readonly now = Date.now) {}
  take(key: string): boolean {
    const now = this.now();
    for (const [id, bucket] of this.buckets) if (now - bucket.updated >= 60000) this.buckets.delete(id);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.capacity) return false;
      bucket = { tokens: this.burst, updated: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.burst, bucket.tokens + Math.max(0, now - bucket.updated) / 1000 * this.perSecond);
    bucket.updated = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens--;
    return true;
  }
}
