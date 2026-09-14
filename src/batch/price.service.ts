import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface UsdQuote {
  price?: number;
  volume_24h?: number;
  percent_change_24h?: number;
  [key: string]: unknown;
}

const REFRESH_MS = 60 * 60 * 1000; // 1 hour, like the legacy service

/**
 * CoinMarketCap ML price feed. The API key comes from the environment
 * (k8s Secret) — it is NEVER committed. When the key is missing the
 * service degrades: /price answers 503 and /account answers 500 with the
 * same `{ error }` body it would give for any upstream failure.
 */
@Injectable()
export class PriceService implements OnModuleInit {
  private readonly logger = new Logger(PriceService.name);
  private value?: UsdQuote;
  private expires = 0;
  private timer?: NodeJS.Timeout;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (!this.isConfigured()) {
      this.logger.warn('CMC_API_KEY not set — /price is disabled');
      return;
    }
    void this.refresh();
    this.timer = setInterval(() => {
      this.logger.log('Refreshing ML price');
      void this.refresh();
    }, REFRESH_MS);
  }

  isConfigured(): boolean {
    return Boolean(this.config.get<string>('cmc.apiKey'));
  }

  /** Current USD quote, or undefined before the first successful fetch. */
  get(): UsdQuote | undefined {
    return this.value;
  }

  isStale(): boolean {
    return this.expires < Date.now();
  }

  /** Fire-and-forget refresh (legacy semantics: never blocks, never throws). */
  refreshAsync(): void {
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    const apiKey = this.config.get<string>('cmc.apiKey');
    const coinId = this.config.get<string>('cmc.coinId', '14977');
    try {
      const response = await fetch(
        `https://pro-api.coinmarketcap.com/v2/cryptocurrency/quotes/latest?id=${coinId}&convert=USD`,
        { headers: { 'X-CMC_PRO_API_KEY': String(apiKey) } },
      );
      const json: any = await response.json();
      const quote = json?.data?.[coinId]?.quote?.USD;
      if (!quote) {
        throw new Error('Unexpected CMC response shape');
      }
      this.value = quote;
      this.expires = Date.now() + REFRESH_MS;
    } catch (error) {
      this.logger.error(`ML price refresh failed: ${(error as Error).message}`);
    }
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }
}
