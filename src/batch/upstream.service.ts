import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Endpoint templates this service is allowed to proxy upstream. Without
 * this gate, /batch_data's client-supplied `type` would turn the
 * endpoint into an arbitrary GET proxy for ANY api-server endpoint
 * (present and future).
 */
const ALLOWED_TYPES = new Set([
  '/address/:address',
  '/address/:address/spendable-utxos',
  '/address/:address/delegations',
  '/transaction/:txid',
  '/token/:token',
  '/token?offset=:offset',
  '/nft/:token',
]);

/**
 * Cached upstream fetcher — a faithful port of the legacy wallet-batch
 * `makeRequest`/`makeBatchRequests` pair:
 *
 * - A single Map keyed by full URL, 30s TTL entries (UPSTREAM_TTL_MS).
 * - Failures do NOT throw: they surface as the string `Error: <message>`
 *   inside results, exactly like the legacy service. Callers (and the
 *   contract tests) depend on this shape.
 * - `clearAll()` wipes the cache on every new connected block — matching
 *   the legacy behavior where either network's new block cleared the
 *   single shared cache.
 */
/**
 * Hard cap on cached URLs. Without it, an attacker spamming unique ids
 * (each upstream 404 body that parses as JSON is cached) could grow the
 * Map without bound. Map preserves insertion order, so delete+set gives
 * an LRU.
 */
const MAX_CACHE_ENTRIES = 10_000;
/** Abort hanging upstream fetches; failures degrade to `Error: ...`. */
const UPSTREAM_TIMEOUT_MS = 10_000;
/** How often expired entries are swept out of the cache. */
const SWEEP_INTERVAL_MS = 60_000;

@Injectable()
export class UpstreamService implements OnModuleDestroy {
  private readonly logger = new Logger(UpstreamService.name);
  private readonly cache = new Map<
    string,
    { value: unknown; expires: number }
  >();
  private readonly defaultTtlMs: number;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.defaultTtlMs = this.config.get<number>('upstreamTtlMs', 30000);
    this.sweeper = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    // Never keep the process (or a test run) alive just for the sweep.
    this.sweeper.unref?.();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
    this.cache.clear();
  }

  /** Wipe the whole cache. Called on every new connected block. */
  clearAll() {
    this.cache.clear();
  }

  async makeRequest(url: string, ttl = this.defaultTtlMs): Promise<unknown> {
    const entry = this.cache.get(url);
    if (entry) {
      if (!entry.expires || entry.expires > Date.now()) {
        // Refresh LRU position.
        this.cache.delete(url);
        this.cache.set(url, entry);
        return entry.value;
      }
      this.cache.delete(url); // Remove expired entry
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
      const data = await response.json();
      this.store(url, { value: data, expires: Date.now() + ttl });
      return data;
    } catch (error) {
      // Legacy contract: failures become `Error: <message>` strings in the
      // results array instead of throwing.
      return `Error: ${(error as Error)?.message ?? String(error)}`;
    }
  }

  /** Insert with LRU eviction of the oldest entry when full. */
  private store(url: string, entry: { value: unknown; expires: number }) {
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(url, entry);
  }

  private sweepExpired() {
    const now = Date.now();
    for (const [url, entry] of this.cache) {
      if (entry.expires && entry.expires <= now) {
        this.cache.delete(url);
      }
    }
  }

  /**
   * Batch-fetch `type` (an endpoint template containing `:address`,
   * `:txid`, `:token` or `:offset`) once per id. `network`: 0 = mainnet,
   * 1 = testnet.
   */
  async makeBatchRequests(
    type: string,
    ids: string[],
    network = 0,
  ): Promise<any[]> {
    if (!ALLOWED_TYPES.has(type)) {
      throw new BadRequestException('Unknown type');
    }

    const baseUrl = `${network === 1 ? this.config.get<string>('testnetApi') : this.config.get<string>('mainnetApi')}${type}`;

    const requests = ids.reduce<any[]>((acc, id) => {
      // Function-form replacement so `$`-patterns in ids ($&, $`, $')
      // can never splice unintended URL fragments.
      const url = baseUrl
        .replace(':address', () => id)
        .replace(':txid', () => id)
        .replace(':token', () => id)
        .replace(':offset', () => id);
      return acc.concat(this.makeRequest(url));
    }, []);

    const results = await Promise.all(requests);

    // Legacy sloppy-mode JS silently skipped the `.id` stamp on failure
    // strings (`Error: <message>`); strict-mode TS would throw on it, so
    // guard — string failures flow through without an id, exactly like
    // the legacy wire behavior.
    results.forEach((result: any, index: number) => {
      if (result && typeof result === 'object') {
        result.id = ids[index];
      }
    });

    return results;
  }

  networkApi(network: number): string | undefined {
    return network === 1
      ? this.config.get<string>('testnetApi')
      : this.config.get<string>('mainnetApi');
  }
}
