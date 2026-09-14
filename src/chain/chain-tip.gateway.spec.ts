import { EventEmitter } from 'node:events';
import { WebSocket } from 'ws';
import { ChainTipGateway } from './chain-tip.gateway';
import type { ChainTipService } from './chain-tip.service';

interface FakeClient extends EventEmitter {
  readyState: number;
  network?: 'mainnet' | 'testnet';
  clientIP?: string;
  pingInterval?: NodeJS.Timeout;
  send: jest.Mock;
  ping: jest.Mock;
  terminate: jest.Mock;
}

const makeClient = (readyState = WebSocket.OPEN): FakeClient => {
  const client = new EventEmitter() as FakeClient;
  client.readyState = readyState;
  client.send = jest.fn();
  client.ping = jest.fn();
  client.terminate = jest.fn();
  return client;
};

const receive = (client: FakeClient, payload: unknown) => {
  client.emit('message', Buffer.from(JSON.stringify(payload)));
};

describe('ChainTipGateway', () => {
  let onNewBlockCb: (network: 'mainnet' | 'testnet', height: number) => void;
  const unsubscribe = jest.fn();
  const chainTip = {
    onNewBlock: jest.fn((listener: any) => {
      onNewBlockCb = listener;
      return unsubscribe;
    }),
    getHeight: jest.fn((network: string) => (network === 'mainnet' ? 77 : 5)),
  };

  let gateway: ChainTipGateway;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    gateway = new ChainTipGateway(chainTip as unknown as ChainTipService);
  });

  afterEach(() => {
    gateway.onModuleDestroy();
    jest.useRealTimers();
  });

  it('subscribes to new-block notifications on construction', () => {
    expect(chainTip.onNewBlock).toHaveBeenCalledTimes(1);
    expect(typeof onNewBlockCb).toBe('function');
  });

  describe('handleConnection', () => {
    it('registers the client and extracts the IP from x-forwarded-for', () => {
      const client = makeClient();

      gateway.handleConnection(client, {
        headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      });

      expect(client.clientIP).toBe('1.2.3.4');
      expect(client.pingInterval).toBeDefined();
    });

    it('falls back to x-real-ip, socket address and unknown', () => {
      const realIP = makeClient();
      gateway.handleConnection(realIP, {
        headers: { 'x-real-ip': '9.9.9.9' },
      });
      expect(realIP.clientIP).toBe('9.9.9.9');

      const socket = makeClient();
      gateway.handleConnection(socket, {
        headers: {},
        socket: { remoteAddress: '10.0.0.1' },
      });
      expect(socket.clientIP).toBe('10.0.0.1');

      const none = makeClient();
      gateway.handleConnection(none, undefined);
      expect(none.clientIP).toBe('unknown');
    });

    it('answers setNetwork with the current block height', () => {
      const client = makeClient();
      gateway.handleConnection(client, { headers: {} });

      receive(client, { event: 'setNetwork', network: 'mainnet' });

      expect(chainTip.getHeight).toHaveBeenCalledWith('mainnet');
      expect(client.network).toBe('mainnet');
      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'blockHeight', height: 77 }),
      );
    });

    it('accepts testnet as a network too', () => {
      const client = makeClient();
      gateway.handleConnection(client, { headers: {} });

      receive(client, { event: 'setNetwork', network: 'testnet' });

      expect(client.network).toBe('testnet');
      expect(client.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'blockHeight', height: 5 }),
      );
    });

    it('ignores unknown networks and malformed messages', () => {
      const client = makeClient();
      gateway.handleConnection(client, { headers: {} });

      receive(client, { event: 'setNetwork', network: 'regtest' });
      receive(client, { event: 'somethingElse' });
      client.emit('message', Buffer.from('not json at all'));

      expect(client.network).toBeUndefined();
      expect(client.send).not.toHaveBeenCalled();
    });
  });

  describe('new-block broadcast', () => {
    it('sends the height only to open clients of the matching network', () => {
      const mainnetOpen = makeClient();
      mainnetOpen.network = 'mainnet';
      const testnetOpen = makeClient();
      testnetOpen.network = 'testnet';
      const mainnetClosed = makeClient(WebSocket.CLOSED);
      mainnetClosed.network = 'mainnet';

      gateway.handleConnection(mainnetOpen, { headers: {} });
      gateway.handleConnection(testnetOpen, { headers: {} });
      gateway.handleConnection(mainnetClosed, { headers: {} });

      // handleConnection answered setNetwork only for the two open ones;
      // mainnetClosed never sent setNetwork. Clear and broadcast.
      mainnetOpen.send.mockClear();
      testnetOpen.send.mockClear();

      onNewBlockCb('mainnet', 101);

      expect(mainnetOpen.send).toHaveBeenCalledWith(
        JSON.stringify({ event: 'blockHeight', height: 101 }),
      );
      expect(testnetOpen.send).not.toHaveBeenCalled();
      expect(mainnetClosed.send).not.toHaveBeenCalled();
    });

    it('stops broadcasting to disconnected clients', () => {
      const client = makeClient();
      gateway.handleConnection(client, { headers: {} });
      receive(client, { event: 'setNetwork', network: 'mainnet' });
      client.send.mockClear();

      gateway.handleDisconnect(client);
      onNewBlockCb('mainnet', 102);

      expect(client.send).not.toHaveBeenCalled();
    });
  });

  describe('keepalive pings', () => {
    it('pings open clients every 5 seconds', () => {
      const open = makeClient();
      const closed = makeClient(WebSocket.CLOSED);
      gateway.handleConnection(open, { headers: {} });
      gateway.handleConnection(closed, { headers: {} });

      jest.advanceTimersByTime(5000);

      expect(open.ping).toHaveBeenCalledTimes(1);
      expect(closed.ping).not.toHaveBeenCalled();
    });

    it('clears the ping interval on disconnect', () => {
      const client = makeClient();
      gateway.handleConnection(client, { headers: {} });
      const interval = client.pingInterval;

      gateway.handleDisconnect(client);
      jest.advanceTimersByTime(20000);

      expect(client.ping).not.toHaveBeenCalled();
      expect(interval).toBeDefined();
    });
  });

  describe('onModuleDestroy', () => {
    it('terminates every client and unsubscribes from the service', () => {
      const client = makeClient();
      gateway.handleConnection(client, { headers: {} });

      gateway.onModuleDestroy();

      expect(client.terminate).toHaveBeenCalledTimes(1);
      expect(unsubscribe).toHaveBeenCalledTimes(1);

      onNewBlockCb('mainnet', 103);
      expect(client.send).not.toHaveBeenCalled();
    });
  });
});
