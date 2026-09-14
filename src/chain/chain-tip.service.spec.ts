import { ConfigService } from '@nestjs/config';
import { ChainTipService } from './chain-tip.service';

const MAINNET_API = 'https://main.example/api';
const TESTNET_API = 'https://test.example/api';

const tipResponse = (blockHeight: number | string, ok = true) => ({
  ok,
  json: () => Promise.resolve({ block_height: String(blockHeight) }),
});

/** Typed accessor for the private poll loop. */
interface Pollable {
  poll(): Promise<void>;
}

const makeService = () => {
  const config = new ConfigService({
    mainnetApi: MAINNET_API,
    testnetApi: TESTNET_API,
    chainTipPollMs: 1000,
  });
  const upstream = { clearAll: jest.fn() };
  const service = new ChainTipService(config, upstream as any);
  const poll = (): Promise<void> => (service as unknown as Pollable).poll();
  return { service, poll, upstream };
};

/** The poller walks [mainnet, testnet] in order, one fetch each. */
const queuePoll = (
  fetchMock: jest.Mock,
  mainnet: number | string,
  testnet: number | string,
) => {
  fetchMock
    .mockResolvedValueOnce(tipResponse(mainnet))
    .mockResolvedValueOnce(tipResponse(testnet));
};

describe('ChainTipService', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('starts both heights at zero before the first poll', () => {
    const { service } = makeService();

    expect(service.getHeight('mainnet')).toBe(0);
    expect(service.getHeight('testnet')).toBe(0);
    expect(service.getMainnetHeight()).toBe(0);
    expect(service.getTestnetHeight()).toBe(0);
  });

  it('polls both networks via their api base urls', async () => {
    const { poll } = makeService();
    queuePoll(fetchMock, 100, 50);

    await poll();

    expect(fetchMock).toHaveBeenCalledWith(`${MAINNET_API}/chain/tip`);
    expect(fetchMock).toHaveBeenCalledWith(`${TESTNET_API}/chain/tip`);
  });

  it('records the first observation as a new block: clears the cache and notifies listeners', async () => {
    // The first observation (0 -> 100) IS a height increase, so the
    // initial sync legitimately clears the shared cache and notifies.
    const { service, poll, upstream } = makeService();
    queuePoll(fetchMock, 100, 50);
    const listener = jest.fn();
    service.onNewBlock(listener);

    await poll();

    expect(service.getMainnetHeight()).toBe(100);
    expect(service.getTestnetHeight()).toBe(50);
    expect(upstream.clearAll).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith('mainnet', 100);
    expect(listener).toHaveBeenCalledWith('testnet', 50);
  });

  it('clears the cache and notifies only for the network that advanced', async () => {
    const { service, poll, upstream } = makeService();
    queuePoll(fetchMock, 100, 50);
    await poll();

    const listener = jest.fn();
    service.onNewBlock(listener);
    upstream.clearAll.mockClear();
    fetchMock.mockClear();

    queuePoll(fetchMock, 101, 50);
    await poll();

    expect(service.getMainnetHeight()).toBe(101);
    expect(upstream.clearAll).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('mainnet', 101);
    expect(listener).not.toHaveBeenCalledWith('testnet', expect.anything());
  });

  it('does nothing when no height changed', async () => {
    const { service, poll, upstream } = makeService();
    queuePoll(fetchMock, 100, 50);
    await poll();
    upstream.clearAll.mockClear();

    const listener = jest.fn();
    service.onNewBlock(listener);

    queuePoll(fetchMock, 100, 50);
    await poll();

    expect(upstream.clearAll).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });

  it('handles a decreasing height as a no-op', async () => {
    const { service, poll, upstream } = makeService();
    queuePoll(fetchMock, 100, 50);
    await poll();
    upstream.clearAll.mockClear();

    queuePoll(fetchMock, 99, 40);
    await poll();

    expect(service.getMainnetHeight()).toBe(100);
    expect(upstream.clearAll).not.toHaveBeenCalled();
  });

  it('works for the testnet path alone', async () => {
    const { service, poll, upstream } = makeService();
    queuePoll(fetchMock, 100, 50);
    await poll();

    const listener = jest.fn();
    service.onNewBlock(listener);
    upstream.clearAll.mockClear();

    queuePoll(fetchMock, 100, 51);
    await poll();

    expect(service.getTestnetHeight()).toBe(51);
    expect(upstream.clearAll).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('testnet', 51);
  });

  it('swallows fetch failures without changing heights', async () => {
    const { service, poll, upstream } = makeService();
    queuePoll(fetchMock, 100, 50);
    await poll();
    upstream.clearAll.mockClear();

    fetchMock.mockRejectedValue(new Error('connection refused'));
    await expect(poll()).resolves.toBeUndefined();

    expect(service.getMainnetHeight()).toBe(100);
    expect(service.getTestnetHeight()).toBe(50);
    expect(upstream.clearAll).not.toHaveBeenCalled();
  });

  it('skips non-ok responses', async () => {
    const { service, poll, upstream } = makeService();

    fetchMock
      .mockResolvedValueOnce(tipResponse(100, false))
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await poll();

    expect(service.getMainnetHeight()).toBe(0);
    expect(service.getTestnetHeight()).toBe(0);
    expect(upstream.clearAll).not.toHaveBeenCalled();
  });

  it('skips heights that do not parse to a finite number', async () => {
    const { service, poll, upstream } = makeService();

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ block_height: 'abc' }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

    await poll();

    expect(service.getMainnetHeight()).toBe(0);
    expect(upstream.clearAll).not.toHaveBeenCalled();
  });

  it('a broken listener does not prevent other listeners from being notified', async () => {
    const { service, poll } = makeService();
    queuePoll(fetchMock, 100, 50);
    await poll();

    const throwing = jest.fn(() => {
      throw new Error('listener exploded');
    });
    const healthy = jest.fn();
    service.onNewBlock(throwing);
    service.onNewBlock(healthy);

    queuePoll(fetchMock, 101, 50);
    await expect(poll()).resolves.toBeUndefined();

    expect(healthy).toHaveBeenCalledWith('mainnet', 101);
  });

  it('supports unsubscribing from block notifications', async () => {
    const { service, poll } = makeService();
    queuePoll(fetchMock, 100, 50);
    await poll();

    const listener = jest.fn();
    const unsubscribe = service.onNewBlock(listener);
    unsubscribe();

    queuePoll(fetchMock, 102, 50);
    await poll();

    expect(listener).not.toHaveBeenCalled();
  });

  describe('interval lifecycle', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('polls on the configured interval and stops after onModuleDestroy', async () => {
      const { service } = makeService();
      fetchMock.mockResolvedValue(tipResponse(100));

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(0);
      expect(fetchMock).toHaveBeenCalledTimes(2); // initial poll, both networks

      await jest.advanceTimersByTimeAsync(1000);
      expect(fetchMock).toHaveBeenCalledTimes(4); // second poll

      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(5000);
      expect(fetchMock).toHaveBeenCalledTimes(4); // no further polls
    });
  });
});
