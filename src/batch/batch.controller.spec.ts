import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  INestApplication,
  ModuleMetadata,
  ValidationPipe,
} from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BatchController } from './batch.controller';
import { UpstreamService } from './upstream.service';
import { PriceService } from './price.service';
import { ChainTipService } from '../chain/chain-tip.service';

/**
 * Recorded responses from the live legacy service (test/fixtures/) —
 * used as parity references, compared structurally (never deep-equal on
 * volatile fields like balances).
 */
const loadFixture = (name: string): any =>
  JSON.parse(
    readFileSync(join(__dirname, '..', '..', 'test', 'fixtures', name), 'utf8'),
  );

const BATCH_FIXTURE = loadFixture('batch_data.json');
const DEX_FIXTURE = loadFixture('dex_tokens_testnet.json');
const DEX_MAINNET_FIXTURE = loadFixture('dex_tokens_mainnet.json');
const PRICE_FIXTURE = loadFixture('price.json');

const upstream = {
  makeBatchRequests: jest.fn(),
  networkApi: jest.fn(),
};
const price = {
  isConfigured: jest.fn(),
  isStale: jest.fn(),
  refreshAsync: jest.fn(),
  get: jest.fn(),
};
const chainTip = {
  getMainnetHeight: jest.fn(),
  getTestnetHeight: jest.fn(),
  getHeight: jest.fn(),
};

const moduleMetadata = (withValidationPipe: boolean): ModuleMetadata => ({
  controllers: [BatchController],
  providers: [
    { provide: UpstreamService, useValue: upstream },
    { provide: PriceService, useValue: price },
    { provide: ChainTipService, useValue: chainTip },
    ...(withValidationPipe
      ? [
          {
            // Same pipe wiring as production main.ts.
            provide: APP_PIPE,
            useValue: new ValidationPipe({
              whitelist: true,
              transform: true,
              transformOptions: { enableImplicitConversion: true },
              validationError: { target: false, value: false },
            }),
          },
        ]
      : []),
  ],
});

describe('BatchController', () => {
  // Controller-logic app: no global pipe, so endpoint behavior can be
  // exercised independently of DTO validation.
  let app: INestApplication;
  // Validation app: same pipe wiring as production main.ts.
  let validatedApp: INestApplication;
  // Parity app: REAL UpstreamService with a stubbed global fetch — the
  // full controller + cache + id-stamping pipeline, compared against the
  // recorded legacy-service fixtures.
  let parityApp: INestApplication;

  const UPSTREAM_BASE = 'https://upstream.test/api';

  beforeAll(async () => {
    app = (
      await Test.createTestingModule(moduleMetadata(false)).compile()
    ).createNestApplication();
    validatedApp = (
      await Test.createTestingModule(moduleMetadata(true)).compile()
    ).createNestApplication();
    parityApp = (
      await Test.createTestingModule({
        controllers: [BatchController],
        providers: [
          UpstreamService,
          {
            provide: ConfigService,
            useValue: new ConfigService({
              mainnetApi: UPSTREAM_BASE,
              testnetApi: UPSTREAM_BASE,
              upstreamTtlMs: 30000,
            }),
          },
          { provide: PriceService, useValue: price },
          { provide: ChainTipService, useValue: chainTip },
        ],
      }).compile()
    ).createNestApplication();
    await app.init();
    await validatedApp.init();
    await parityApp.init();
  });

  afterAll(async () => {
    await app.close();
    await validatedApp.close();
    await parityApp.close();
  });

  beforeEach(() => {
    // mockReset (not clearAllMocks): queued mockResolvedValueOnce values
    // from a request that never reached the controller must not leak.
    upstream.makeBatchRequests.mockReset();
    upstream.networkApi.mockReset();
    price.isConfigured.mockReset().mockReturnValue(false);
    price.isStale.mockReset().mockReturnValue(false);
    price.refreshAsync.mockReset();
    price.get.mockReset().mockReturnValue(undefined);
    chainTip.getMainnetHeight.mockReset().mockReturnValue(424242);
    chainTip.getTestnetHeight.mockReset().mockReturnValue(1);
    chainTip.getHeight.mockReset().mockReturnValue(1);
  });

  describe('POST /batch_data', () => {
    it('reproduces the recorded batch_data fixture through the real pipeline', async () => {
      // Stub global fetch to answer per-address like the live api-server:
      // a healthy account document, and an `{ error }` for a dead address —
      // entries WITHOUT ids, exactly like the recorded upstream responses.
      const fetchMock = jest.fn((url: string) => {
        const address = url.split('/address/')[1];
        const batchResults: any[] = BATCH_FIXTURE.results;
        const entry = batchResults.find((r: any) => !r.error);
        if (address === entry.id) {
          const rest = { ...entry };
          delete rest.id;
          return Promise.resolve({ json: () => Promise.resolve(rest) });
        }
        return Promise.resolve({
          json: () => Promise.resolve({ error: 'Invalid address' }),
        });
      });
      const originalFetch = globalThis.fetch;
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      try {
        const response = await request(parityApp.getHttpServer())
          .post('/batch_data')
          .send({
            type: '/address/:address',
            ids: [
              'tpmt1qgqq9nfy6ehe2gkru4ds7nev99u9kn85sd30zues5s2n4za8hk8l9vt4as5yed',
              'tpmt1qzbogaddressnotfound00000000000000000000000000',
            ],
            network: 1,
          })
          .expect(200);

        // Byte-shape parity with the recorded legacy response.
        expect(response.body).toEqual({ results: BATCH_FIXTURE.results });
        expect(Object.keys(response.body.results[0]).sort()).toEqual(
          Object.keys(BATCH_FIXTURE.results[0]).sort(),
        );
        expect(response.body.results[0]).toEqual(
          expect.objectContaining({
            id: 'tpmt1qgqq9nfy6ehe2gkru4ds7nev99u9kn85sd30zues5s2n4za8hk8l9vt4as5yed',
            coin_balance: expect.objectContaining({
              atoms: expect.any(String),
              decimal: expect.any(String),
            }),
          }),
        );
        expect(response.body.results[1]).toEqual({
          error: 'Invalid address',
          id: 'tpmt1qzbogaddressnotfound00000000000000000000000000',
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('maps upstream rejections to 500 { error }', async () => {
      upstream.makeBatchRequests.mockRejectedValueOnce(new Error('boom'));

      const response = await request(app.getHttpServer())
        .post('/batch_data')
        .send({ type: '/address/:address', ids: ['a1'] })
        .expect(500);

      expect(response.body).toEqual({ error: 'boom' });
    });

    // NOTE (flagged production bug, do not "fix" the test): the production
    // pipe currently rejects EVERY non-empty ids array, because
    // class-validator 0.15's @Length() type-guards on string and the DTO
    // applies it to the array itself. These tests only assert rejections
    // that remain correct after that bug is fixed (@ArrayMinSize instead).
    describe('validation (production pipe wiring)', () => {
      it('answers 400 when ids is an empty array', async () => {
        await request(validatedApp.getHttpServer())
          .post('/batch_data')
          .send({ type: '/address/:address', ids: [] })
          .expect(400);

        expect(upstream.makeBatchRequests).not.toHaveBeenCalled();
      });

      it('answers 400 when the type is missing', async () => {
        await request(validatedApp.getHttpServer())
          .post('/batch_data')
          .send({ ids: ['a1'] })
          .expect(400);
      });

      it('answers 400 when network is not 0 or 1', async () => {
        await request(validatedApp.getHttpServer())
          .post('/batch_data')
          .send({ type: '/address/:address', ids: ['a1'], network: 5 })
          .expect(400);
      });
    });
  });

  describe('GET /dex_tokens', () => {
    it('walks the offset pages, unique-ifies and fetches details', async () => {
      const [t0, t1, t2, t3] = DEX_FIXTURE;

      upstream.makeBatchRequests.mockImplementation(
        (type: string, ids: string[]) => {
          if (type === '/token?offset=:offset') {
            // 10 fixed offsets 0..90; include a duplicate across pages
            // (t2 appears on both page 0 and page 10).
            return ids.map((offset: string) => {
              if (offset === '0') {
                return [t0.token_id, t1.token_id, t2.token_id];
              }
              if (offset === '10') return [t2.token_id, t3.token_id];
              return [];
            });
          }
          if (type === '/token/:token') {
            return ids.map((tokenId: string) => {
              if (tokenId === t0.token_id) {
                return { error: 'token not found' };
              }
              const entry = [t1, t2, t3].find((t) => t.token_id === tokenId);
              return {
                token_ticker: { string: entry.symbol },
                number_of_decimals: entry.number_of_decimals,
              };
            });
          }
          throw new Error(`unexpected type ${type}`);
        },
      );

      const response = await request(app.getHttpServer())
        .get('/dex_tokens?network=1')
        .expect(200);

      // The errored detail entry (t0) is skipped, duplicates removed,
      // order preserved — the remaining entries match the fixture exactly.
      expect(response.body).toEqual([t1, t2, t3]);

      expect(upstream.makeBatchRequests).toHaveBeenNthCalledWith(
        1,
        '/token?offset=:offset',
        ['0', '10', '20', '30', '40', '50', '60', '70', '80', '90'],
        1,
      );
      expect(upstream.makeBatchRequests).toHaveBeenNthCalledWith(
        2,
        '/token/:token',
        // All unique tokens are detailed; t0's error is only discovered
        // here, so it IS part of this call.
        [t0.token_id, t1.token_id, t2.token_id, t3.token_id],
        1,
      );
    });

    it('produces the same entry shape recorded in both network fixtures', () => {
      // Structural check: exactly the three keys the consumers depend on.
      for (const fixture of [DEX_FIXTURE, DEX_MAINNET_FIXTURE]) {
        expect(fixture.length).toBeGreaterThan(0);
        for (const entry of fixture) {
          expect(Object.keys(entry).sort()).toEqual(
            ['number_of_decimals', 'symbol', 'token_id'].sort(),
          );
          expect(typeof entry.token_id).toBe('string');
          expect(typeof entry.symbol).toBe('string');
          expect(Number.isInteger(entry.number_of_decimals)).toBe(true);
        }
      }
    });

    it('answers 500 { error } when the upstream walk fails', async () => {
      upstream.makeBatchRequests.mockRejectedValueOnce(
        new Error('walk blew up'),
      );

      const response = await request(app.getHttpServer())
        .get('/dex_tokens')
        .expect(500);

      expect(response.body).toEqual({ error: 'walk blew up' });
    });
  });

  describe('GET /chain_tip', () => {
    it('returns the mainnet height regardless of the network parameter', async () => {
      const response = await request(app.getHttpServer())
        .get('/chain_tip?network=1')
        .expect(200);

      expect(response.body).toEqual({ tip: 424242 });
      expect(chainTip.getMainnetHeight).toHaveBeenCalledTimes(1);
      expect(chainTip.getTestnetHeight).not.toHaveBeenCalled();
    });
  });

  describe('GET /price', () => {
    it('answers 503 { error } when the CMC key is not configured', async () => {
      const response = await request(app.getHttpServer())
        .get('/price')
        .expect(503);

      expect(response.body).toEqual({ error: 'Price feed not configured' });
    });

    it('returns the recorded USD quote shape when configured', async () => {
      price.isConfigured.mockReturnValue(true);
      price.get.mockReturnValue(PRICE_FIXTURE);

      const response = await request(app.getHttpServer())
        .get('/price')
        .expect(200);

      expect(response.body).toEqual(PRICE_FIXTURE);
      expect(response.body).toEqual(
        expect.objectContaining({
          price: expect.any(Number),
          volume_24h: expect.any(Number),
          percent_change_24h: expect.any(Number),
          last_updated: expect.any(String),
        }),
      );
    });

    it('returns {} before the first successful fetch', async () => {
      price.isConfigured.mockReturnValue(true);
      price.get.mockReturnValue(undefined);

      const response = await request(app.getHttpServer())
        .get('/price')
        .expect(200);

      expect(response.body).toEqual({});
    });

    it('triggers a fire-and-forget refresh when the quote is stale', async () => {
      price.isConfigured.mockReturnValue(true);
      price.isStale.mockReturnValue(true);

      await request(app.getHttpServer()).get('/price').expect(200);

      expect(price.refreshAsync).toHaveBeenCalledTimes(1);
    });

    it('does not refresh while the quote is fresh', async () => {
      price.isConfigured.mockReturnValue(true);
      price.isStale.mockReturnValue(false);

      await request(app.getHttpServer()).get('/price').expect(200);

      expect(price.refreshAsync).not.toHaveBeenCalled();
    });
  });
});
