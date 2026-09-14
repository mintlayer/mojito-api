import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpstreamService } from '../batch/upstream.service';

type BlockListener = (network: 'mainnet' | 'testnet', height: number) => void;

/**
 * Replaces the legacy pm2-log-tailing block detector. The old service
 * spawned `tail -f` on PM2 log files that do not exist inside k8s, so the
 * block-height feed (and the /ws broadcast + cache invalidation) had been
 * silently dead since the cluster migration. This polls both api-servers'
 * /chain/tip instead and, on a new connected block:
 *   - clears the shared upstream cache (legacy semantics), and
 *   - notifies listeners (the /ws gateway broadcasts to that network).
 */
@Injectable()
export class ChainTipService implements OnModuleInit {
  private readonly logger = new Logger(ChainTipService.name);
  private readonly listeners: BlockListener[] = [];
  private readonly heights: Record<'mainnet' | 'testnet', number> = {
    mainnet: 0,
    testnet: 0,
  };
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly config: ConfigService,
    private readonly upstream: UpstreamService,
  ) {}

  onModuleInit() {
    const interval = this.config.get<number>('chainTipPollMs', 10000);
    void this.poll();
    this.timer = setInterval(() => void this.poll(), interval);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  getMainnetHeight(): number {
    return this.heights.mainnet;
  }

  getTestnetHeight(): number {
    return this.heights.testnet;
  }

  getHeight(network: 'mainnet' | 'testnet'): number {
    return this.heights[network];
  }

  onNewBlock(listener: BlockListener): () => void {
    this.listeners.push(listener);
    return () => {
      const i = this.listeners.indexOf(listener);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private async poll() {
    for (const network of ['mainnet', 'testnet'] as const) {
      const base =
        network === 'mainnet'
          ? this.config.get<string>('mainnetApi')
          : this.config.get<string>('testnetApi');
      try {
        const response = await fetch(`${base}/chain/tip`);
        if (!response.ok) continue;
        const data: any = await response.json();
        const height = parseInt(data?.block_height, 10);
        if (!Number.isFinite(height)) continue;

        if (height > this.heights[network]) {
          this.logger.log(
            `${network} new connected block: ${this.heights[network]} -> ${height}`,
          );
          this.heights[network] = height;
          // Legacy behavior: one shared cache, cleared on any new block.
          this.upstream.clearAll();
          for (const listener of this.listeners) {
            try {
              listener(network, height);
            } catch {
              /* a broken listener must not kill the poll */
            }
          }
        }
      } catch (error) {
        this.logger.warn(
          `${network} chain/tip poll failed: ${(error as Error).message}`,
        );
      }
    }
  }
}
