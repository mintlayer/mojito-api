import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PricesService } from './prices.service';
import { BRIDGE_TICKERS, PRICE_ID_BY_TICKER } from './ticker-map';

const TTL_MS = 600_000;

interface CgPriceEntry {
  usd?: number;
}
type CgPayload = Record<string, CgPriceEntry>;
interface CgResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<CgPayload>;
}
interface FetchInit {
  headers: Record<string, string>;
  signal?: unknown;
}

const cgOk = (payload: CgPayload): CgResponse => ({
  ok: true,
  json: () => Promise.resolve(payload),
});

const cgError = (status: number): CgResponse => ({
  ok: false,
  status,
  json: () => Promise.resolve({}),
});

/** Every bridge id answers with a distinct positive usd value (ml = 1, wbtc = 6, …). */
const allPricesPayload = (): CgPayload =>
  Object.fromEntries(
    BRIDGE_TICKERS.map((ticker, index) => [
      PRICE_ID_BY_TICKER[ticker],
      { usd: index + 1 },
    ]),
  );

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

/** ConfigService stub per the ipfs spec convention: overrides win, else the default. */
const makeService = (overrides: Record<string, unknown> = {}) =>
  new PricesService({
    get: (key: string, defaultValue?: unknown) =>
      key in overrides ? overrides[key] : defaultValue,
  } as unknown as ConfigService);

const initOf = (call: unknown[]): FetchInit => call[1] as FetchInit;

/** Decodes the `ids=` param of a recorded fetch call after asserting the batch shape. */
const idsFromCall = (call: unknown[]): string[] => {
  const url = call[0] as string;
  expect(
    url.startsWith('https://api.coingecko.com/api/v3/simple/price?ids='),
  ).toBe(true);
  const rawIds = url.match(/ids=([^&]+)/)![1];
  // commas are percent-encoded — 35 separators + 1 = 36 ids in one batch
  expect((rawIds.match(/%2C/g) ?? []).length + 1).toBe(36);
  const params = new URL(url).searchParams;
  expect(params.get('vs_currencies')).toBe('usd');
  const ids = decodeURIComponent(rawIds).split(',');
  expect(ids).toHaveLength(36);
  expect(new Set(ids).size).toBe(36);
  return ids;
};

describe('PricesService', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('refresh — happy path', () => {
    it('populates every bridge ticker from one batched fetch, dropping invalid entries', async () => {
      const payload = allPricesPayload();
      payload['pepe'] = { usd: 0 }; // zero → unusable
      payload['shiba-inu'] = { usd: -0.01 }; // negative → unusable
      payload['aave'] = {}; // usd missing → unusable
      delete payload['compound-governance-token']; // id absent from the response

      fetchMock.mockResolvedValue(cgOk(payload));
      const service = makeService();

      const prices = await service.getPrices();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Object.keys(prices)).toHaveLength(BRIDGE_TICKERS.length - 4);
      for (const dropped of ['pepe', 'shib', 'aave', 'comp']) {
        expect(prices[dropped]).toBeUndefined();
      }
      expect(prices['ml']).toBe(1);
      expect(prices['wbtc']).toBe(6);
      expect(prices['waaplx']).toBe(17);
      for (const value of Object.values(prices)) {
        expect(Number.isFinite(value)).toBe(true);
        expect(value).toBeGreaterThan(0);
      }
    });

    it('batches all 36 CoinGecko ids into a single simple/price URL', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService();

      await service.getPrices();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const ids = idsFromCall(fetchMock.mock.calls[0]);
      expect(ids).toContain('mintlayer');
      expect(ids).toContain('apple-xstock');
      expect(ids).toContain('wrapped-bitcoin');
      expect(initOf(fetchMock.mock.calls[0]).headers.accept).toBe(
        'application/json',
      );
      expect(initOf(fetchMock.mock.calls[0]).signal).toBeDefined();
    });
  });

  describe('getPrices — filtering', () => {
    it('filters case-insensitively with trimming and omits unknown tickers', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService();
      await service.getPrices();

      const filtered = await service.getPrices([
        'WBTC ',
        ' ml ',
        '   ',
        'nope',
        '',
      ]);

      expect(filtered).toEqual({ wbtc: 6, ml: 1 });
    });

    it('treats an empty filter list like no filter and returns everything', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService();

      const all = await service.getPrices([]);

      expect(Object.keys(all)).toHaveLength(36);
    });
  });

  describe('getPrices — result isolation', () => {
    it('returns a copy: mutating the result must not affect the cached map', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService();
      const first = await service.getPrices();
      first['ml'] = 999_999_999;
      delete first['wbtc'];

      const second = await service.getPrices();

      expect(second['ml']).toBe(1);
      expect(second['wbtc']).toBe(6);
      expect(Object.keys(second)).toHaveLength(36);
    });
  });

  describe('getPrices — TTL freshness', () => {
    it('re-fetches once the cached map is older than the TTL', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService();
      await service.getPrices();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(TTL_MS);
      expect(service.isStale()).toBe(false); // exactly TTL is still fresh (strict >)
      jest.advanceTimersByTime(1);
      expect(service.isStale()).toBe(true);

      const prices = await service.getPrices(['ml']);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(prices).toEqual({ ml: 1 });
      expect(service.isStale()).toBe(false);
    });

    it('does not refresh at all while the cache is fresh (TTL honored on the request path)', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService();
      await service.getPrices(); // refresh #1 → cache fresh

      jest.advanceTimersByTime(TTL_MS / 2); // still well within the TTL
      expect(service.isStale()).toBe(false);

      const first = service.getPrices(); // fresh → served from the cached map
      const second = service.getPrices(); // no refresh, same cached map
      const third = service.getPrices(['wbtc']);
      const [r1, r2, r3] = await Promise.all([first, second, third]);

      expect(fetchMock).toHaveBeenCalledTimes(1); // TTL honored: zero CG fetches while fresh
      expect(Object.keys(r1)).toHaveLength(36);
      expect(Object.keys(r2)).toHaveLength(36);
      expect(r3).toEqual({ wbtc: 6 });
    });

    it('honors a custom prices.ttlMs from config', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService({ 'prices.ttlMs': 5_000 });
      await service.getPrices();

      jest.advanceTimersByTime(4_999);
      expect(service.isStale()).toBe(false);
      jest.advanceTimersByTime(2);
      expect(service.isStale()).toBe(true);
    });
  });

  describe('stale-on-error', () => {
    it('keeps the previous map when a refresh fails, then replaces it after recovery', async () => {
      fetchMock.mockResolvedValueOnce(cgOk(allPricesPayload()));
      const service = makeService();
      const initial = await service.getPrices();
      expect(initial['ml']).toBe(1);

      jest.advanceTimersByTime(TTL_MS + 1);
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      const afterFailure = await service.getPrices();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(afterFailure).toEqual(initial); // stale map still served
      expect(service.isStale()).toBe(true); // fetchedAt untouched by the failure

      const recovered = {
        ...allPricesPayload(),
        mintlayer: { usd: 0.123 },
      };
      fetchMock.mockResolvedValueOnce(cgOk(recovered));
      const afterRecovery = await service.getPrices();

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(afterRecovery['ml']).toBe(0.123);
      expect(afterRecovery['wbtc']).toBe(6);
      expect(service.isStale()).toBe(false);
    });

    it('treats a CoinGecko error status as a failed refresh', async () => {
      fetchMock.mockResolvedValueOnce(cgOk(allPricesPayload()));
      const service = makeService();
      const initial = await service.getPrices();

      jest.advanceTimersByTime(TTL_MS + 1);
      fetchMock.mockResolvedValueOnce(cgError(500));

      await expect(service.getPrices()).resolves.toEqual(initial);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(service.isStale()).toBe(true);
    });

    it('keeps the stale map when CoinGecko answers with nothing usable', async () => {
      fetchMock.mockResolvedValueOnce(cgOk(allPricesPayload()));
      const service = makeService();
      const initial = await service.getPrices();

      jest.advanceTimersByTime(TTL_MS + 1);
      fetchMock.mockResolvedValueOnce(cgOk({})); // internal throw, caught
      const result = await service.getPrices();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual(initial);
      expect(service.isStale()).toBe(true);
    });

    it('resolves empty instead of rejecting when the very first fetch fails', async () => {
      fetchMock.mockRejectedValue(new Error('boom'));
      const service = makeService();

      await expect(service.getPrices()).resolves.toEqual({});
    });

    it('resolves empty instead of rejecting when the first response has nothing usable', async () => {
      fetchMock.mockResolvedValue(cgOk({ mintlayer: { usd: 0 } }));
      const service = makeService();

      await expect(service.getPrices()).resolves.toEqual({});
    });
  });

  describe('CoinGecko auth header', () => {
    it('sends x-cg-demo-api-key only when cg.apiKey is configured', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));

      const keyed = makeService({ 'cg.apiKey': 'CG-abc123' });
      await keyed.getPrices();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(initOf(fetchMock.mock.calls[0]).headers).toEqual({
        accept: 'application/json',
        'x-cg-demo-api-key': 'CG-abc123',
      });

      const anonymous = makeService();
      await anonymous.getPrices();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(initOf(fetchMock.mock.calls[1]).headers).toEqual({
        accept: 'application/json',
      });
    });
  });

  describe('concurrency', () => {
    it('dedupes concurrent getPrices calls into a single in-flight refresh', async () => {
      const gate = deferred<CgResponse>();
      fetchMock.mockImplementation(() => gate.promise);
      const service = makeService();

      const first = service.getPrices();
      const second = service.getPrices(['wbtc', 'ml']);
      const third = service.getPrices();
      gate.resolve(cgOk(allPricesPayload()));
      const [r1, r2, r3] = await Promise.all([first, second, third]);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Object.keys(r1)).toHaveLength(36);
      expect(r2).toEqual({ wbtc: 6, ml: 1 });
      expect(Object.keys(r3)).toHaveLength(36);
    });
  });

  describe('lifecycle', () => {
    it('reports the covered ticker count without any network activity', () => {
      const service = makeService();

      expect(service.coveredTickerCount()).toBe(36);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('refreshes on the TTL interval and stops after onModuleDestroy', async () => {
      fetchMock.mockResolvedValue(cgOk(allPricesPayload()));
      const service = makeService();
      service.onModuleInit();
      await service.getPrices(); // rides the boot refresh
      expect(fetchMock).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(TTL_MS); // interval tick → background refresh
      await service.getPrices();
      expect(fetchMock).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      const count = fetchMock.mock.calls.length;
      jest.advanceTimersByTime(TTL_MS * 10);
      expect(fetchMock.mock.calls.length).toBe(count); // timer cleared, no leak
      expect(() => service.onModuleDestroy()).not.toThrow(); // idempotent
    });
  });
});
