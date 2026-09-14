import { Module } from '@nestjs/common';
import { UpstreamService } from './upstream.service';

/**
 * Shared home for the stateful upstream fetcher so every consumer
 * (AppModule controllers and ChainModule's ChainTipService) gets the
 * SAME singleton — its cache is cleared by the chain-tip poller on new
 * blocks, which only works if there is exactly one instance.
 */
@Module({
  providers: [UpstreamService],
  exports: [UpstreamService],
})
export class UpstreamModule {}
