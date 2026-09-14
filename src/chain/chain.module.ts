import { Module } from '@nestjs/common';
import { UpstreamModule } from '../batch/upstream.module';
import { ChainTipService } from './chain-tip.service';
import { ChainTipGateway } from './chain-tip.gateway';

@Module({
  imports: [UpstreamModule],
  providers: [ChainTipService, ChainTipGateway],
  exports: [ChainTipService],
})
export class ChainModule {}
