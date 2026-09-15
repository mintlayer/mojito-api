import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { BatchController } from './batch/batch.controller';
import { MintiniController } from './batch/mintini.controller';
import { PriceService } from './batch/price.service';
import { UpstreamModule } from './batch/upstream.module';
import { ChainModule } from './chain/chain.module';
import { IpfsModule } from './ipfs/ipfs.module';
import { PricesModule } from './prices/prices.module';
import configuration, { configValidationSchema } from './config/configuration';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      validationSchema: configValidationSchema,
    }),
    // Global per-IP rate limit; the expensive fan-out routes
    // (/batch_data, /account, ...) tighten their own limit with
    // @Throttle overrides in their controllers.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 300 }]),
    UpstreamModule,
    ChainModule,
    IpfsModule,
    PricesModule,
  ],
  controllers: [BatchController, MintiniController],
  providers: [PriceService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
