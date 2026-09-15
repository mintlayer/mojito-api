import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiTags } from '@nestjs/swagger';
import { PricesService } from './prices.service';
import { PRICE_ID_BY_TICKER } from './ticker-map';

/**
 * USD prices for the full bridge asset set (crypto + 20 xStocks).
 * CORS-open: consumed by bridge.mintlayer.org in the browser.
 */
@ApiTags('Prices')
@Controller('prices')
export class PricesController {
  constructor(private readonly prices: PricesService) {}

  @Get()
  @ApiOperation({
    summary:
      'USD prices for bridge assets (CoinGecko, server-cached). Filter with ?tickers=wbtc,ml',
  })
  @ApiQuery({
    name: 'tickers',
    required: false,
    description: 'Comma-separated bridge tickers (default: all)',
    example: 'wbtc,ml,waaplx',
  })
  @Header('Access-Control-Allow-Origin', '*')
  async getPrices(@Query('tickers') tickersStr?: string) {
    const tickers = tickersStr
      ? tickersStr
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;
    return this.prices.getPrices(tickers);
  }

  @Get('coverage')
  @ApiOperation({
    summary: 'Ticker → CoinGecko id map for every bridgeable asset',
  })
  @Header('Access-Control-Allow-Origin', '*')
  coverage() {
    return {
      covered: this.prices.coveredTickerCount(),
      prices_stale: this.prices.isStale(),
      map: PRICE_ID_BY_TICKER,
    };
  }
}
