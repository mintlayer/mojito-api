import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UpstreamService } from './upstream.service';
import { PriceService } from './price.service';
import { BatchDataDto } from './dto';
import { ChainTipService } from '../chain/chain-tip.service';

/**
 * Fan-out routes amplify a single request into hundreds of upstream
 * fetches (up to 500 ids per call) — they get a much tighter per-IP
 * budget than the global default.
 */
const FANOUT_THROTTLE = { default: { ttl: 60_000, limit: 30 } };

/**
 * Batch + price endpoints consumed by the Mojito browser extension
 * (through the Traefik rewrites: /mintlayer/{net}/batch → /batch_data and
 * /batch/* → /*). Controller paths MUST stay exactly as the legacy
 * wallet-batch service for the ingress rules to keep working.
 */
@ApiTags('Batch')
@Controller()
export class BatchController {
  private readonly logger = new Logger(BatchController.name);

  constructor(
    private readonly upstream: UpstreamService,
    private readonly price: PriceService,
    private readonly chainTip: ChainTipService,
  ) {}

  @Post('batch_data')
  @HttpCode(HttpStatus.OK)
  @Throttle(FANOUT_THROTTLE)
  @ApiOperation({ summary: 'Batch-fetch an endpoint template for many ids' })
  async batchData(@Body() body: BatchDataDto) {
    const { type, ids, network } = body;
    try {
      const results = await this.upstream.makeBatchRequests(type, ids, network);
      return { results };
    } catch (error) {
      // BadRequestException from the type whitelist keeps its 400 status.
      if (error instanceof HttpException) throw error;
      throw new HttpException(
        { error: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('dex_tokens')
  @Throttle(FANOUT_THROTTLE)
  @ApiOperation({ summary: 'All tradable tokens for a network' })
  async dexTokens(@Query('network') networkStr?: string) {
    const network = parseInt(networkStr ?? '0', 10) || 0;
    try {
      const type = '/token?offset=:offset';
      const ids = ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90'];
      const results = await this.upstream.makeBatchRequests(type, ids, network);

      const tokens_all: string[] = [];
      results.forEach((result: any) => {
        if (result.length > 0) {
          result.forEach((token: string) => {
            tokens_all.push(token);
          });
        }
      });

      // make tokens unique
      const tokens = tokens_all.filter(
        (value, index, array) => array.indexOf(value) === index,
      );

      const token_details = await this.upstream.makeBatchRequests(
        '/token/:token',
        tokens,
        network,
      );

      const tokens_list: any[] = [];
      token_details.forEach((token: any, index: number) => {
        if (!token.error) {
          tokens_list.push({
            token_id: tokens[index],
            symbol: token.token_ticker.string,
            number_of_decimals: token.number_of_decimals,
          });
        }
      });

      return tokens_list;
    } catch (error) {
      throw new HttpException(
        { error: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * LEGACY QUIRK, preserved on purpose: this endpoint always answers with
   * the MAINNET height regardless of the network query parameter, and the
   * value comes from the in-memory poller (zero until the first block
   * lands). See README — fixing it is a separate, announced release.
   */
  @Get('chain_tip')
  @ApiOperation({
    summary: 'Legacy chain-tip endpoint (always returns the mainnet height)',
  })
  getChainTip(@Query('network') _network?: string) {
    return { tip: this.chainTip.getMainnetHeight() };
  }

  @Get('price')
  @ApiOperation({ summary: 'ML price (USD) from CoinMarketCap' })
  getPrice() {
    if (!this.price.isConfigured()) {
      throw new HttpException(
        { error: 'Price feed not configured' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    if (this.price.isStale()) {
      this.price.refreshAsync();
    }
    return this.price.get() ?? {};
  }
}
