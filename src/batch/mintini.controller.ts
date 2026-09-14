import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Logger,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { UpstreamService } from './upstream.service';
import { PriceService } from './price.service';
import { analysisTransaction } from './activity.util';
import { AddressesDto } from './dto';

/**
 * Fan-out routes amplify a single request into hundreds of upstream
 * fetches (500 addresses → several sequential 500-wide waves) — they
 * get a much tighter per-IP budget than the global default.
 */
const FANOUT_THROTTLE = { default: { ttl: 60_000, limit: 30 } };

function getRealIP(req: any): string {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string') {
    return forwardedFor.split(',')[0].trim();
  }
  const realIP = req.headers['x-real-ip'];
  if (typeof realIP === 'string') {
    return realIP.trim();
  }
  return req.socket?.remoteAddress || 'unknown';
}

/**
 * Mintini mobile-app backend endpoints (also routed from
 * api.mintini.app → this service). Faithful port of the legacy handlers.
 */
@ApiTags('Mintini')
@Controller()
export class MintiniController {
  private readonly logger = new Logger(MintiniController.name);

  constructor(
    private readonly upstream: UpstreamService,
    private readonly price: PriceService,
  ) {}

  @Post('account')
  @HttpCode(HttpStatus.OK)
  @Throttle(FANOUT_THROTTLE)
  @ApiOperation({
    summary: 'Aggregated account view (tokens, utxos, delegations)',
  })
  async account(@Body() body: AddressesDto, @Req() req: any) {
    const clientIP = getRealIP(req);
    const { addresses, network } = body;
    this.logger.log(
      `[/account] IP: ${clientIP} | Addresses count: ${addresses.length} | Network: ${network}`,
    );

    try {
      const results = await this.upstream.makeBatchRequests(
        '/address/:address',
        addresses,
        network,
      );

      const coins: Record<string, number> = {};

      coins['ML'] = results.reduce((acc: number, result: any) => {
        if (result.coin_balance) {
          const balance = Number(result.coin_balance.atoms);
          if (balance) {
            acc += balance;
          }
        }
        return acc;
      }, 0);

      // Legacy semantics: with no CMC data yet `value` is undefined and
      // the property access throws → endpoint answers 500 { error }.
      // Once a quote exists, a missing `price` multiplies as NaN, exactly
      // like the legacy JS.
      const rate = Number(this.price.get()?.price);

      const tokens: any[] = [
        {
          symbol: 'ML',
          balance: coins['ML'] / 1e11,
          value: (coins['ML'] / 1e11) * rate,
          value_change_percent: this.price.get()?.percent_change_24h || 0,
          type: 'Coin',
          token_details: {
            number_of_decimals: 11,
          },
        },
      ];

      const available_addresses = results
        .filter((result: any) => result.coin_balance)
        .map((result: any) => result.id);

      const utxo_spendable = await this.upstream.makeBatchRequests(
        '/address/:address/spendable-utxos',
        available_addresses,
        network,
      );

      const utxos: any[] = [];
      utxo_spendable.forEach((result: any) => {
        if (result.length > 0) {
          result.forEach((utxo: any) => {
            utxos.push(utxo);
          });
        }
      });

      const tokensV1 = utxos.reduce((result: any, item: any) => {
        if (!item?.utxo?.value?.token_id) {
          return result;
        }
        const tokenId = item.utxo.value.token_id;
        const amount = parseInt(item.utxo.value.amount.atoms);

        if (!result[tokenId]) {
          result[tokenId] = { amount: 0 };
        }

        result[tokenId].amount += amount;

        return result;
      }, {});

      const tokens_details = await this.upstream.makeBatchRequests(
        '/token/:token',
        Object.keys(tokensV1),
        network,
      );

      Object.keys(tokensV1).forEach((token, index) => {
        if (tokens_details[index] && tokens_details[index].token_ticker) {
          tokens.push({
            symbol: tokens_details[index].token_ticker.string,
            balance:
              tokensV1[token].amount /
              Math.pow(10, tokens_details[index].number_of_decimals),
            value: '-',
            type: 'TokenV1',
            token_id: token,
            token_details: {
              number_of_decimals: tokens_details[index].number_of_decimals,
            },
          });
        }
      });

      const tokens_nft_details = await this.upstream.makeBatchRequests(
        '/nft/:token',
        Object.keys(tokensV1),
        network,
      );

      Object.keys(tokensV1).forEach((token, index) => {
        if (tokens_nft_details[index] && tokens_nft_details[index].ticker) {
          tokens.push({
            symbol: tokens_nft_details[index].ticker.string,
            balance: 1,
            value: '-',
            type: 'TokenV1',
            token_id: token,
            token_details: {
              number_of_decimals: 0,
            },
          });
        }
      });

      const delegations: any[] = [];
      const delegations_res = await this.upstream.makeBatchRequests(
        '/address/:address/delegations',
        available_addresses,
        network,
      );

      delegations_res.forEach((result: any) => {
        if (result.length > 0) {
          delegations.push(...result);
        }
      });

      return { tokens, utxos, delegations };
    } catch (error) {
      throw new HttpException(
        { error: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('tokens')
  @HttpCode(HttpStatus.OK)
  @Throttle(FANOUT_THROTTLE)
  @ApiOperation({
    summary:
      'Token view for addresses. LEGACY QUIRK: the ML `value` uses a hardcoded 0.1035 rate.',
  })
  async tokens(@Body() body: AddressesDto) {
    const { addresses, network } = body;

    try {
      const results = await this.upstream.makeBatchRequests(
        '/address/:address',
        addresses,
        network,
      );

      const coins: Record<string, number> = {};

      coins['ML'] = results.reduce((acc: number, result: any) => {
        if (result.coin_balance) {
          const balance = Number(result.coin_balance.atoms);
          if (balance) {
            acc += balance;
          }
        }
        return acc;
      }, 0);

      const tokens: any[] = [
        {
          symbol: 'ML',
          balance: coins['ML'] / 1e11,
          // LEGACY QUIRK: hardcoded rate, preserved from the legacy service.
          value: (coins['ML'] / 1e11) * 0.1035,
          type: 'Coin',
        },
      ];

      const available_addresses = results
        .filter((result: any) => result.coin_balance)
        .map((result: any) => result.id);

      const utxo_spendable = await this.upstream.makeBatchRequests(
        '/address/:address/spendable-utxos',
        available_addresses,
        network,
      );

      const utxos: any[] = [];
      utxo_spendable.forEach((result: any) => {
        if (result.length > 0) {
          result.forEach((utxo: any) => {
            utxos.push(utxo);
          });
        }
      });

      const tokensV1 = utxos.reduce((result: any, item: any) => {
        if (!item?.utxo?.value?.token_id) {
          return result;
        }
        const tokenId = item.utxo.value.token_id;
        const amount = parseFloat(item.utxo.value.amount.decimal);

        if (!result[tokenId]) {
          result[tokenId] = { amount: 0 };
        }

        result[tokenId].amount += amount;

        return result;
      }, {});

      const tokens_details = await this.upstream.makeBatchRequests(
        '/token/:token',
        Object.keys(tokensV1),
        network,
      );

      Object.keys(tokensV1).forEach((token, index) => {
        tokens.push({
          symbol: tokens_details[index].token_ticker.string,
          balance: tokensV1[token].amount,
          value: '-',
          type: 'TokenV1',
          token_id: token,
        });
      });

      return tokens;
    } catch (error) {
      throw new HttpException(
        { error: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('utxos')
  @HttpCode(HttpStatus.OK)
  @Throttle(FANOUT_THROTTLE)
  @ApiOperation({ summary: 'Flattened spendable UTXOs for addresses' })
  async utxos(@Body() body: AddressesDto) {
    const { addresses, network } = body;

    try {
      const results = await this.upstream.makeBatchRequests(
        '/address/:address/spendable-utxos',
        addresses,
        network,
      );

      const utxos: any[] = [];
      results.forEach((result: any) => {
        if (result.length > 0) {
          result.forEach((utxo: any) => {
            utxos.push(utxo);
          });
        }
      });

      return utxos;
    } catch (error) {
      throw new HttpException(
        { error: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Post('activity')
  @HttpCode(HttpStatus.OK)
  @Throttle(FANOUT_THROTTLE)
  @ApiOperation({ summary: 'Classified transaction activity for addresses' })
  async activity(@Body() body: AddressesDto) {
    const { addresses, network } = body;

    try {
      const results = await this.upstream.makeBatchRequests(
        '/address/:address',
        addresses,
        network,
      );

      const transactions: any[] = [];
      results.forEach((result: any) => {
        if (
          result.transaction_history &&
          result.transaction_history.length > 0
        ) {
          transactions.push(...result.transaction_history);
        }
      });

      const transactions_details = await this.upstream.makeBatchRequests(
        '/transaction/:txid',
        transactions,
        network,
      );

      const activities: any[] = [];

      transactions_details.forEach((tx: any) => {
        const activity = analysisTransaction({ tx, addresses });
        activities.push(activity);
      });

      // before returning the activities, sort them by timestamp desc
      activities.sort((a: any, b: any) => {
        return b.timestamp - a.timestamp;
      });

      return activities;
    } catch (error) {
      throw new HttpException(
        { error: (error as Error).message },
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Broadcast proxy. NOTE: this route is served by an express.text()
   * body parser registered in main.ts — the body arrives as a string
   * (or, for JSON content-type clients, as the parsed object exactly
   * like the legacy service did).
   */
  @Post('transaction')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Broadcast a transaction to a Mintlayer network' })
  async transaction(@Req() req: any, @Query('network') networkStr?: string) {
    const clientIP = getRealIP(req);
    const body = req.body;
    const network = parseInt(networkStr ?? '0', 10) || 0;

    const url = `${this.upstream.networkApi(network)}/transaction`;
    this.logger.log(`[/transaction] IP: ${clientIP} | Network: ${network}`);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
      },
      body,
    });
    const data = await response.json();
    if (data.tx_id) {
      this.logger.log(
        `Broadcast Transaction Success: ${data.tx_id} | IP: ${clientIP}`,
      );
      return data;
    }
    this.logger.warn(`Broadcast Transaction Error | IP: ${clientIP}`);
    throw new HttpException(
      data ?? { error: 'Broadcast failed' },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
