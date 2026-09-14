import { BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UpstreamService } from './upstream.service';

const MAINNET = 'https://main.example/api';
const TESTNET = 'https://test.example/api';

const makeService = (configOverrides: Record<string, unknown> = {}) =>
  new UpstreamService(
    new ConfigService({
      mainnetApi: MAINNET,
      testnetApi: TESTNET,
      upstreamTtlMs: 30000,
      ...configOverrides,
    }),
  );

const jsonResponse = (data: unknown) => ({
  json: () => Promise.resolve(data),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Every fetch now carries an abort-signal timeout. */
const WITH_TIMEOUT = expect.objectContaining({
  signal: expect.any(AbortSignal),
});

describe('UpstreamService', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('makeRequest', () => {
    it('fetches the url and parses the json body', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ hello: 'world' }));
      const service = makeService();

      await expect(
        service.makeRequest('https://up.example/x'),
      ).resolves.toEqual({ hello: 'world' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://up.example/x',
        WITH_TIMEOUT,
      );
    });

    it('serves repeat requests for the same url from the cache', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ n: 1 }));
      const service = makeService();

      await service.makeRequest('https://up.example/cached');
      await service.makeRequest('https://up.example/cached');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('caches different urls independently', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      await service.makeRequest('https://up.example/a');
      await service.makeRequest('https://up.example/b');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('refetches once the entry ttl has expired', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      await service.makeRequest('https://up.example/ttl', 5);
      await service.makeRequest('https://up.example/ttl', 5);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await sleep(30);
      await service.makeRequest('https://up.example/ttl', 5);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('uses the configured default ttl when none is passed', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      // 20ms default ttl from config, short enough to expire quickly.
      const service = makeService({ upstreamTtlMs: 20 });

      await service.makeRequest('https://up.example/def');
      await sleep(40);
      await service.makeRequest('https://up.example/def');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('clearAll wipes the cache so the next request refetches', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      await service.makeRequest('https://up.example/wipe');
      service.clearAll();
      await service.makeRequest('https://up.example/wipe');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('onModuleDestroy clears the cache', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      await service.makeRequest('https://up.example/destroy');
      service.onModuleDestroy();
      await service.makeRequest('https://up.example/destroy');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('never throws: fetch failures surface as `Error: <message>` strings', async () => {
      fetchMock.mockRejectedValueOnce(new Error('network down'));
      const service = makeService();

      await expect(
        service.makeRequest('https://up.example/fail'),
      ).resolves.toBe('Error: network down');
    });

    it('handles thrown non-Error values without throwing', async () => {
      fetchMock.mockRejectedValueOnce('plain string failure');
      const service = makeService();

      await expect(
        service.makeRequest('https://up.example/fail2'),
      ).resolves.toBe('Error: plain string failure');
    });

    it('returns upstream error payloads verbatim (no response.ok check)', async () => {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({ error: 'Invalid address' }),
      );
      const service = makeService();

      await expect(
        service.makeRequest('https://up.example/invalid'),
      ).resolves.toEqual({ error: 'Invalid address' });
    });

    it('aborted fetches (timeout) surface as Error: strings too', async () => {
      fetchMock.mockRejectedValueOnce(
        new DOMException('This operation was aborted', 'AbortError'),
      );
      const service = makeService();

      // Matches the legacy failure-string contract.
      await expect(
        service.makeRequest('https://up.example/abort'),
      ).resolves.toBe('Error: This operation was aborted');
    });

    it('cache is LRU-capped so unique urls cannot grow it without bound', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      // The cache is capped at 10,000 entries; each unique url is a miss.
      for (let i = 0; i < 10_001; i++) {
        await service.makeRequest(`https://up.example/u${i}`);
      }
      expect(fetchMock).toHaveBeenCalledTimes(10_001);

      // u0 was evicted as the oldest entry when u10000 was stored, so it
      // must be fetched again.
      await service.makeRequest('https://up.example/u0');
      expect(fetchMock).toHaveBeenCalledTimes(10_002);
    });
  });

  describe('makeBatchRequests', () => {
    it('routes to the mainnet api for network 0', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ balance: 1 }));
      const service = makeService();

      await service.makeBatchRequests('/address/:address', ['a1'], 0);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MAINNET}/address/a1`,
        WITH_TIMEOUT,
      );
    });

    it('routes to the testnet api for network 1', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ balance: 1 }));
      const service = makeService();

      await service.makeBatchRequests('/address/:address', ['a1'], 1);

      expect(fetchMock).toHaveBeenCalledWith(
        `${TESTNET}/address/a1`,
        WITH_TIMEOUT,
      );
    });

    it('defaults to mainnet when the network is omitted', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ balance: 1 }));
      const service = makeService();

      await service.makeBatchRequests('/address/:address', ['a1']);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MAINNET}/address/a1`,
        WITH_TIMEOUT,
      );
    });

    it('substitutes the id once per request across all known placeholders', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      await service.makeBatchRequests('/address/:address', ['id1']);
      await service.makeBatchRequests('/token?offset=:offset', ['42']);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MAINNET}/address/id1`,
        WITH_TIMEOUT,
      );
      expect(fetchMock).toHaveBeenCalledWith(
        `${MAINNET}/token?offset=42`,
        WITH_TIMEOUT,
      );
    });

    it('rejects endpoint templates outside the allowlist', async () => {
      const service = makeService();

      await expect(
        service.makeBatchRequests('/token/:token/tx/:txid/from/:address', [
          'id1',
        ]),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.makeBatchRequests('/token/:token/tx/:txid/from/:address', [
          'id1',
        ]),
      ).rejects.toThrow('Unknown type');
    });

    it('$-patterns in ids cannot splice the url', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      // With plain string replacement, `$&` in the id would be expanded to
      // the whole match (`:address`), producing /address/:address-.
      // Function-form replacement must keep the literal id.
      await service.makeBatchRequests('/address/:address', ['$&-']);

      expect(fetchMock).toHaveBeenCalledWith(
        `${MAINNET}/address/$&-`,
        WITH_TIMEOUT,
      );
    });

    it('makes one request per id and stamps result.id with the ids', async () => {
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(jsonResponse({ url })),
      );
      const service = makeService();

      const results = await service.makeBatchRequests('/address/:address', [
        'a1',
        'a2',
        'a3',
      ]);

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(results.map((r) => r.id)).toEqual(['a1', 'a2', 'a3']);
      expect(results[0].url).toBe(`${MAINNET}/address/a1`);
      expect(results[2].url).toBe(`${MAINNET}/address/a3`);
    });

    it('stamps .id on upstream error objects too (legacy parity shape)', async () => {
      // A dead address answers with `{ error }` json, not a fetch failure —
      // exactly what test/fixtures/batch_data.json records.
      fetchMock.mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ error: 'Invalid address', extra: true }),
        ),
      );
      const service = makeService();

      const results = await service.makeBatchRequests('/address/:address', [
        'good',
        'dead',
      ]);

      expect(results).toEqual([
        { error: 'Invalid address', extra: true, id: 'good' },
        { error: 'Invalid address', extra: true, id: 'dead' },
      ]);
    });

    it('reuses the cache across batch calls for identical urls', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ ok: true }));
      const service = makeService();

      // Duplicate ids in one batch race concurrently: both miss the cache
      // because the entry is stored only after the fetch resolves.
      await service.makeBatchRequests('/address/:address', ['a1', 'a1']);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // The next batch is served from the cache.
      await service.makeBatchRequests('/address/:address', ['a1']);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns an empty array for an empty id list', async () => {
      const service = makeService();

      await expect(
        service.makeBatchRequests('/address/:address', []),
      ).resolves.toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('networkApi', () => {
    it('returns the mainnet api for network 0 and the testnet api for 1', () => {
      const service = makeService();

      expect(service.networkApi(0)).toBe(MAINNET);
      expect(service.networkApi(1)).toBe(TESTNET);
    });
  });
});
