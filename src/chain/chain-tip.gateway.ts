import { Logger } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { OnModuleDestroy } from '@nestjs/common';
import { Server, WebSocket } from 'ws';
import { ChainTipService } from './chain-tip.service';

interface TrackedClient extends WebSocket {
  clientIP?: string;
  network?: 'mainnet' | 'testnet';
  pingInterval?: NodeJS.Timeout;
}

/**
 * Port of the legacy /ws blockHeight broadcast (Mintini mobile clients):
 * clients announce their network with `{ event: "setNetwork", network }`
 * and receive `{ event: "blockHeight", height }` immediately plus on every
 * new connected block of that network. The height source is now the live
 * api-server poller instead of the dead pm2-log tail.
 */
@WebSocketGateway({ path: '/ws' })
export class ChainTipGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  private readonly logger = new Logger(ChainTipGateway.name);

  @WebSocketServer()
  server: Server;

  private clients = new Set<TrackedClient>();
  private unsubscribe?: () => void;

  constructor(private readonly chainTip: ChainTipService) {
    // Reuse the recovered service's X-Forwarded-For client-IP extraction
    // for log attribution.
    this.unsubscribe = chainTip.onNewBlock((network, height) => {
      for (const client of this.clients) {
        if (
          client.readyState === WebSocket.OPEN &&
          client.network === network
        ) {
          client.send(JSON.stringify({ event: 'blockHeight', height }));
        }
      }
    });
  }

  handleConnection(client: TrackedClient, ...args: any[]) {
    const request = args[0] as
      | {
          headers?: Record<string, string | string[] | undefined>;
          socket?: { remoteAddress?: string };
        }
      | undefined;
    client.clientIP = this.extractIP(request);
    this.clients.add(client);

    client.on('message', (raw: Buffer) => {
      try {
        const data = JSON.parse(raw.toString());
        if (
          data?.event === 'setNetwork' &&
          (data.network === 'mainnet' || data.network === 'testnet')
        ) {
          const network: 'mainnet' | 'testnet' = data.network;
          client.network = network;
          const height = this.chainTip.getHeight(network);
          client.send(JSON.stringify({ event: 'blockHeight', height }));
        }
      } catch {
        /* non-JSON or unknown messages are ignored (legacy behavior) */
      }
    });

    // Legacy keepalive: ping every 5s, stop when the socket goes away.
    client.pingInterval = setInterval(() => {
      if (client.readyState === WebSocket.OPEN) {
        client.ping();
      } else {
        clearInterval(client.pingInterval);
      }
    }, 5000);

    this.logger.debug(`ws client connected | IP: ${client.clientIP}`);
  }

  handleDisconnect(client: TrackedClient) {
    if (client.pingInterval) clearInterval(client.pingInterval);
    this.clients.delete(client);
    this.logger.debug(`ws client disconnected | IP: ${client.clientIP}`);
  }

  onModuleDestroy() {
    for (const client of this.clients) {
      if (client.pingInterval) clearInterval(client.pingInterval);
      client.terminate();
    }
    this.clients.clear();
    this.unsubscribe?.();
  }

  private extractIP(request?: {
    headers?: Record<string, string | string[] | undefined>;
    socket?: { remoteAddress?: string };
  }): string {
    const forwardedFor = request?.headers?.['x-forwarded-for'];
    if (typeof forwardedFor === 'string') {
      return forwardedFor.split(',')[0].trim();
    }
    const realIP = request?.headers?.['x-real-ip'];
    if (typeof realIP === 'string') {
      return realIP.trim();
    }
    return request?.socket?.remoteAddress || 'unknown';
  }
}
