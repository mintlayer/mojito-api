import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface CacheEntry {
  body: Buffer;
  contentType: string;
}

/**
 * Hard cap on negative-cache entries. Expired entries were previously
 * only removed when the same CID was re-requested, so an attacker
 * requesting many unique failing CIDs grew the Map without bound.
 */
const MAX_NEGATIVE_ENTRIES = 5000;
/** How often expired negative entries are swept. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Hardened IPFS content cache — a port of the bridge's battle-tested
 * `/ipfs/<cid>` proxy (bridge-frontend functions/ipfs/[cid].js):
 *
 * - CID constrained to base32/base58 chars (regex gate)
 * - Public-gateway failover with per-gateway timeout
 * - Byte cap (content-length fast path + bounded stream read)
 * - Content-type allowlist: image/* + application/json keep their type,
 *   everything else is forced to application/octet-stream (and a
 *   Content-Disposition attachment, so attacker-pinned content can never
 *   execute in a browser context)
 * - In-memory LRU keyed by CID: CIDs are content-addressed, so entries
 *   never need invalidation and never expire
 * - Negative (failure) cache with a short TTL so a dead gateway walk
 *   cannot be repeated at request rate
 */
@Injectable()
export class IpfsService implements OnModuleDestroy {
  private readonly logger = new Logger(IpfsService.name);
  private readonly gateways: string[];
  private readonly timeoutMs: number;
  private readonly maxBytes: number;
  private readonly maxEntries: number;
  private readonly negativeTtlMs: number;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly negative = new Map<string, number>();
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.gateways = this.config.get<string[]>('ipfs.gateways', []);
    this.timeoutMs = this.config.get<number>('ipfs.timeoutMs', 12000);
    this.maxBytes = this.config.get<number>('ipfs.maxBytes', 5 * 1024 * 1024);
    this.maxEntries = this.config.get<number>(
      'ipfs.memoryCacheMaxEntries',
      5000,
    );
    this.negativeTtlMs = this.config.get<number>('ipfs.negativeTtlMs', 60000);
    this.sweeper = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    // Never keep the process (or a test run) alive just for the sweep.
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    this.cache.clear();
    this.negative.clear();
  }

  static isValidCid(cid: string): boolean {
    // Real CIDs are well under 128 chars; the cap bounds cache-key memory.
    return /^[a-zA-Z0-9]{1,128}$/.test(cid);
  }

  async resolve(
    cid: string,
  ): Promise<
    | { status: 200; body: Buffer; contentType: string; source: string }
    | { status: 400 | 413 | 502; error: string }
  > {
    if (!IpfsService.isValidCid(cid)) {
      return { status: 400, error: 'Bad request' };
    }

    // Positive LRU (Map preserves insertion order; delete+set refreshes LRU)
    const cached = this.cache.get(cid);
    if (cached) {
      this.cache.delete(cid);
      this.cache.set(cid, cached);
      return {
        status: 200,
        body: cached.body,
        contentType: cached.contentType,
        source: 'memory-cache',
      };
    }

    // Negative cache
    const failedAt = this.negative.get(cid);
    if (failedAt && failedAt > Date.now()) {
      return { status: 502, error: 'Upstream error' };
    }
    if (failedAt) this.negative.delete(cid);

    const walked = await this.fetchFromGateways(cid);
    if (walked === null) {
      if (this.negativeTtlMs > 0) {
        this.storeNegative(cid, Date.now() + this.negativeTtlMs);
      }
      return { status: 502, error: 'Upstream error' };
    }
    if ('tooLarge' in walked) {
      return { status: 413, error: 'Payload too large' };
    }

    const entry: CacheEntry = {
      body: walked.body,
      contentType: walked.contentType,
    };
    this.store(cid, entry);

    return {
      status: 200,
      body: walked.body,
      contentType: walked.contentType,
      source: walked.gateway,
    };
  }

  private store(cid: string, entry: CacheEntry) {
    if (this.maxEntries <= 0) return;
    while (this.cache.size >= this.maxEntries) {
      // evict oldest (first key in insertion order)
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(cid, entry);
  }

  /** Insert a negative entry with LRU eviction when full. */
  private storeNegative(cid: string, expires: number) {
    while (this.negative.size >= MAX_NEGATIVE_ENTRIES) {
      const oldest = this.negative.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.negative.delete(oldest);
    }
    this.negative.set(cid, expires);
  }

  private sweepExpired() {
    const now = Date.now();
    for (const [cid, failedAt] of this.negative) {
      if (failedAt <= now) this.negative.delete(cid);
    }
  }

  private async fetchFromGateways(
    cid: string,
  ): Promise<
    | { body: Buffer; contentType: string; gateway: string }
    | { tooLarge: true }
    | null
  > {
    for (const gateway of this.gateways) {
      let upstream: Response;
      try {
        upstream = await fetch(`${gateway}/${cid}`, {
          // Content-addressed data is served directly by IPFS gateways;
          // never follow 3xx (an open redirect could point the fetch at
          // internal targets and stream the response back to the client).
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        // Timeout / connection error — try the next gateway.
        continue;
      }
      // 404, 429, 5xx — this gateway doesn't have (or won't serve) it.
      if (!upstream.ok || !upstream.body) {
        void upstream.body?.cancel().catch(() => {});
        continue;
      }
      const contentLength = Number(upstream.headers.get('content-length') ?? 0);
      if (contentLength > this.maxBytes) {
        // Content-addressed: any other gateway would serve the same
        // bytes — fail fast instead of burning the fallback budget.
        void upstream.body?.cancel().catch(() => {});
        return { tooLarge: true };
      }
      try {
        // Bounded read: abort mid-stream at the cap even when the
        // content-length header is missing or lying.
        const reader = upstream.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > this.maxBytes) {
            await reader.cancel().catch(() => {});
            return { tooLarge: true };
          }
          chunks.push(value);
        }
        return {
          body: Buffer.concat(
            chunks.map((c) => Buffer.from(c)),
            total,
          ),
          contentType: safeContentType(upstream.headers.get('content-type')),
          gateway: new URL(gateway).host,
        };
      } catch {
        // Read interrupted mid-stream — treat like a gateway failure.
        continue;
      }
    }
    return null;
  }
}

/** Only script-free types keep their upstream type; the rest download. */
export function safeContentType(upstreamType: string | null): string {
  return upstreamType &&
    /^(image\/[\w.+-]+|application\/json)\b/i.test(upstreamType)
    ? upstreamType
    : 'application/octet-stream';
}
