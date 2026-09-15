import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BRIDGE_TICKERS,
  PRICE_ID_BY_TICKER,
  tickerToPriceId,
} from './ticker-map';

const CG_SIMPLE_PRICE_URL = 'https://api.coingecko.com/api/v3/simple/price';
const DEFAULT_TTL_MS = 10 * 60_000; // one batched CG call per TTL, max

/**
 * Server-side USD prices for the full bridge asset set.
 *
 * Replaces the frontend's per-visitor CoinGecko calls (rate-limited for
 * everyone behind one demo key) with a single cached batch per TTL, and
 * adds the 20 xStocks tickers the frontend map never covered.
 *
 * Stale-on-error: a failed refresh keeps serving the previous map —
 * prices are display-only, and an outage should hide the $ line via
 * `stale`, not blank every ticker.
 */
@Injectable()
export class PricesService implements OnModuleDestroy {
  private readonly logger = new Logger(PricesService.name);
  private readonly ttlMs: number;
  private prices: Record<string, number> = {};
  private fetchedAt = 0;
  private inFlight?: Promise<void>;
  private timer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {
    this.ttlMs = this.config.get<number>('prices.ttlMs', DEFAULT_TTL_MS);
  }

  onModuleInit() {
    void this.refresh();
    // opportunistic refresh on an interval; requests only trigger on demand
    this.timer = setInterval(() => void this.refresh(), this.ttlMs);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  isStale(): boolean {
    return Date.now() - this.fetchedAt > this.ttlMs;
  }

  /**
   * USD prices keyed by bridge ticker. `tickers` filters the set
   * (case-insensitive; unknown tickers are absent). Empty result only
   * before the first successful fetch.
   */
  async getPrices(tickers?: string[]): Promise<Record<string, number>> {
    // refresh() dedupes concurrent callers; only staleness triggers a new
    // fetch so sequential traffic stays at one CG call per TTL.
    if (this.isStale()) {
      void this.refresh();
    }
    if (this.inFlight) await this.inFlight.catch(() => {});

    if (!tickers || tickers.length === 0) {
      return { ...this.prices };
    }
    const wanted = new Set(
      tickers.map((t) => t.toLowerCase().trim()).filter(Boolean),
    );
    const out: Record<string, number> = {};
    for (const ticker of wanted) {
      const price = this.prices[ticker];
      if (price != null) out[ticker] = price;
    }
    return out;
  }

  coveredTickerCount(): number {
    return BRIDGE_TICKERS.length;
  }

  private async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.doRefresh().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async doRefresh(): Promise<void> {
    const ids = BRIDGE_TICKERS.map((t) => PRICE_ID_BY_TICKER[t]);
    const apiKey = this.config.get<string>('cg.apiKey', '');
    const headers: Record<string, string> = { accept: 'application/json' };
    if (apiKey) headers['x-cg-demo-api-key'] = String(apiKey);

    try {
      const response = await fetch(
        `${CG_SIMPLE_PRICE_URL}?ids=${encodeURIComponent(ids.join(','))}&vs_currencies=usd`,
        { headers, signal: AbortSignal.timeout(15000) },
      );
      if (!response.ok) {
        throw new Error(`CoinGecko HTTP ${response.status}`);
      }
      const byId: Record<string, { usd?: number }> = await response.json();
      const next: Record<string, number> = {};
      for (const ticker of BRIDGE_TICKERS) {
        const id = tickerToPriceId(ticker)!;
        const usd = byId[id]?.usd;
        if (typeof usd === 'number' && Number.isFinite(usd) && usd > 0) {
          next[ticker] = usd;
        }
      }
      if (Object.keys(next).length === 0) {
        throw new Error('CoinGecko returned no usable prices');
      }
      this.prices = next;
      this.fetchedAt = Date.now();
      this.logger.debug(
        `refreshed ${Object.keys(next).length}/${BRIDGE_TICKERS.length} bridge prices`,
      );
    } catch (error) {
      // Stale-on-error: keep the previous map; next tick retries.
      this.logger.warn(
        `price refresh failed (serving ${Object.keys(this.prices).length} stale): ${(error as Error).message}`,
      );
    }
  }
}
