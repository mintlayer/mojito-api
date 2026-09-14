import { ConfigService } from '@nestjs/config';
import { IpfsService, safeContentType } from './ipfs.service';

const GW1 = 'https://gw1.test/ipfs';
const GW2 = 'https://gw2.test/ipfs';
const CID = 'bafkreicq';

const textEncoder = new TextEncoder();
const chunk = (text: string): Uint8Array => textEncoder.encode(text);

interface GatewayResponseOptions {
  ok?: boolean;
  contentType?: string | null;
  contentLength?: string | null;
  chunks?: Uint8Array[];
  omitBody?: boolean;
}

/**
 * Minimal stand-in for an undici `Response` as consumed by IpfsService:
 * `.ok`, `.headers.get()`, `.body.getReader()` / `.body.cancel()`.
 */
const gatewayResponse = (options: GatewayResponseOptions = {}) => {
  const chunks = options.chunks ?? [];
  const cancel = jest.fn().mockResolvedValue(undefined);
  return {
    ok: options.ok ?? true,
    headers: {
      get: (name: string) => {
        const key = name.toLowerCase();
        if (key === 'content-type') {
          return options.contentType ?? null;
        }
        if (key === 'content-length') {
          return options.contentLength ?? null;
        }
        return null;
      },
    },
    body: options.omitBody
      ? undefined
      : {
          cancel,
          getReader: () => {
            let index = 0;
            return {
              read: () =>
                index < chunks.length
                  ? Promise.resolve({ done: false, value: chunks[index++] })
                  : Promise.resolve({ done: true, value: undefined }),
              cancel: jest.fn().mockResolvedValue(undefined),
            };
          },
        },
  };
};

const makeService = (overrides: Record<string, any> = {}) =>
  new IpfsService(
    new ConfigService({
      ipfs: {
        gateways: [GW1, GW2],
        timeoutMs: 250,
        maxBytes: 16,
        memoryCacheMaxEntries: 2,
        negativeTtlMs: 40,
        ...overrides,
      },
    }),
  );

const withFetch = async (fetchMock: jest.Mock, run: () => Promise<void>) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchMock;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
};

describe('IpfsService', () => {
  describe('isValidCid', () => {
    it('accepts base32/base58-style CIDs', () => {
      expect(
        IpfsService.isValidCid(
          'QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco',
        ),
      ).toBe(true);
      expect(IpfsService.isValidCid('bafkreicq')).toBe(true);
    });

    it('rejects CIDs with separators or symbols', () => {
      expect(IpfsService.isValidCid('bad/cid')).toBe(false);
      expect(IpfsService.isValidCid('bad!cid')).toBe(false);
      expect(IpfsService.isValidCid('')).toBe(false);
    });
  });

  describe('resolve — validation', () => {
    it('answers 400 Bad request without touching any gateway', async () => {
      const fetchMock = jest.fn();
      await withFetch(fetchMock, async () => {
        const service = makeService();

        await expect(service.resolve('bad/cid')).resolves.toEqual({
          status: 400,
          error: 'Bad request',
        });
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });
  });

  describe('resolve — gateway failover', () => {
    it('walks gateways in order and reports the first success host as source', async () => {
      const fetchMock = jest.fn((url: string) => {
        if (url.startsWith(GW1)) {
          return Promise.resolve(gatewayResponse({ ok: false }));
        }
        return Promise.resolve(gatewayResponse({ chunks: [chunk('hello ')] }));
      });
      await withFetch(fetchMock, async () => {
        const service = makeService();

        const result = await service.resolve(CID);

        expect(result).toEqual({
          status: 200,
          body: Buffer.from('hello '),
          contentType: 'application/octet-stream',
          source: 'gw2.test',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock).toHaveBeenNthCalledWith(
          1,
          `${GW1}/${CID}`,
          expect.objectContaining({ redirect: 'error' }),
        );
      });
    });

    it('moves on when a gateway fetch rejects (timeout / network error)', async () => {
      const fetchMock = jest.fn((url: string) => {
        if (url.startsWith(GW1)) {
          return Promise.reject(new Error('gateway timeout'));
        }
        return Promise.resolve(gatewayResponse({ chunks: [chunk('ok')] }));
      });
      await withFetch(fetchMock, async () => {
        const service = makeService();

        const result = await service.resolve(CID);

        expect(result.status).toBe(200);
        expect((result as any).source).toBe('gw2.test');
      });
    });

    it('skips gateways without a body', async () => {
      const fetchMock = jest.fn((url: string) => {
        if (url.startsWith(GW1)) {
          return Promise.resolve(gatewayResponse({ omitBody: true }));
        }
        return Promise.resolve(gatewayResponse({ chunks: [chunk('ok')] }));
      });
      await withFetch(fetchMock, async () => {
        const service = makeService();

        const result = await service.resolve(CID);

        expect(result.status).toBe(200);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });

    it('answers 502 and stops when every gateway fails', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ ok: false })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService();

        await expect(service.resolve(CID)).resolves.toEqual({
          status: 502,
          error: 'Upstream error',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('resolve — byte cap', () => {
    it('fails fast with 413 when the content-length exceeds the cap', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(
          gatewayResponse({
            contentLength: String(17),
            chunks: [],
          }),
        ),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService();

        await expect(service.resolve(CID)).resolves.toEqual({
          status: 413,
          error: 'Payload too large',
        });
        // Fails fast: content-addressed bytes would be too large at every
        // gateway, so no fallback fetch is burned.
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it('aborts mid-stream with 413 when the declared length lies', async () => {
      const tooBig = chunk('x'.repeat(20));
      const fetchMock = jest.fn(() =>
        Promise.resolve(
          gatewayResponse({
            contentLength: '4',
            chunks: [chunk('abcd'), tooBig],
          }),
        ),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService();

        await expect(service.resolve(CID)).resolves.toEqual({
          status: 413,
          error: 'Payload too large',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it('accepts payloads exactly at the cap', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ chunks: [chunk('y'.repeat(16))] })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService();

        const result = await service.resolve(CID);

        expect(result.status).toBe(200);
        expect('body' in result && result.body.toString()).toHaveLength(16);
      });
    });
  });

  describe('resolve — content types', () => {
    it.each([
      ['image/png', 'image/png'],
      ['image/svg+xml', 'image/svg+xml'],
      ['application/json', 'application/json'],
      ['text/html', 'application/octet-stream'],
      ['application/javascript', 'application/octet-stream'],
      [null, 'application/octet-stream'],
    ])('upstream %s is served as %s', async (upstreamType, expected) => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(
          gatewayResponse({
            chunks: [chunk('data')],
            contentType: upstreamType,
          }),
        ),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService();

        const result = await service.resolve(CID);

        expect((result as any).contentType).toBe(expected);
      });
    });

    it('exposes the same allowlist through safeContentType', () => {
      expect(safeContentType('image/webp')).toBe('image/webp');
      expect(safeContentType('Application/JSON')).toBe('Application/JSON');
      expect(safeContentType('text/plain')).toBe('application/octet-stream');
      expect(safeContentType(null)).toBe('application/octet-stream');
    });
  });

  describe('resolve — memory LRU cache', () => {
    it('serves repeat resolves from the memory cache without new fetches', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ chunks: [chunk('cached')] })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService();

        const first = await service.resolve(CID);
        const second = await service.resolve(CID);

        expect(first.status).toBe(200);
        expect((first as any).source).toBe('gw1.test');
        expect(second).toEqual({
          status: 200,
          body: Buffer.from('cached'),
          contentType: 'application/octet-stream',
          source: 'memory-cache',
        });
        expect(fetchMock).toHaveBeenCalledTimes(1);
      });
    });

    it('evicts the oldest entry once maxEntries is reached', async () => {
      const fetchMock = jest.fn((url: string) =>
        Promise.resolve(
          gatewayResponse({
            chunks: [
              chunk(url.includes('a') ? 'A' : url.includes('b') ? 'B' : 'C'),
            ],
          }),
        ),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService(); // maxEntries = 2

        await service.resolve('aaaa'); // cached: [aaaa]
        await service.resolve('bbbb'); // cached: [aaaa, bbbb]
        await service.resolve('cccc'); // cached: [bbbb, cccc] — aaaa evicted

        const before = fetchMock.mock.calls.length;
        await service.resolve('bbbb');
        expect(fetchMock.mock.calls.length).toBe(before); // still cached

        await service.resolve('aaaa'); // evicted -> refetched
        expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
      });
    });

    it('refreshes recency on access, so recently-used entries survive', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ chunks: [chunk('x')] })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService(); // maxEntries = 2

        await service.resolve('aaaa'); // [aaaa]
        await service.resolve('bbbb'); // [aaaa, bbbb]
        await service.resolve('aaaa'); // [bbbb, aaaa] — aaaa refreshed
        await service.resolve('cccc'); // [aaaa, cccc] — bbbb evicted

        const before = fetchMock.mock.calls.length;
        await service.resolve('aaaa');
        expect(fetchMock.mock.calls.length).toBe(before);

        await service.resolve('bbbb'); // was evicted -> refetches
        expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
      });
    });

    it('does not cache when memoryCacheMaxEntries is 0', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ chunks: [chunk('x')] })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService({ memoryCacheMaxEntries: 0 });

        await service.resolve(CID);
        await service.resolve(CID);

        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe('resolve — negative cache', () => {
    it('caches failures briefly: no new fetches inside the TTL', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ ok: false })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService(); // negativeTtlMs = 40

        await expect(service.resolve(CID)).resolves.toEqual({
          status: 502,
          error: 'Upstream error',
        });
        await expect(service.resolve(CID)).resolves.toEqual({
          status: 502,
          error: 'Upstream error',
        });
        expect(fetchMock).toHaveBeenCalledTimes(2);
      });
    });

    it('retries the gateways after the negative TTL has passed', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ ok: false, chunks: [] })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService(); // negativeTtlMs = 40

        await service.resolve(CID);
        await new Promise((resolve) => setTimeout(resolve, 60));
        await service.resolve(CID);

        expect(fetchMock).toHaveBeenCalledTimes(4);
      });
    });

    it('does not negative-cache when negativeTtlMs is 0', async () => {
      const fetchMock = jest.fn(() =>
        Promise.resolve(gatewayResponse({ ok: false })),
      );
      await withFetch(fetchMock, async () => {
        const service = makeService({ negativeTtlMs: 0 });

        await service.resolve(CID);
        await service.resolve(CID);

        expect(fetchMock).toHaveBeenCalledTimes(4);
      });
    });

    it('a success clears nothing but overrides the negative entry for that cid', async () => {
      const fetchMock = jest.fn((url: string) => {
        if (url.startsWith(GW1)) {
          return Promise.resolve(gatewayResponse({ ok: false }));
        }
        return Promise.resolve(
          gatewayResponse({ chunks: [chunk('recovered')] }),
        );
      });
      await withFetch(fetchMock, async () => {
        const service = makeService();

        await service.resolve(CID); // succeeds via gw2
        const result = await service.resolve(CID); // memory-cached success

        expect((result as any).source).toBe('memory-cache');
      });
    });
  });
});
