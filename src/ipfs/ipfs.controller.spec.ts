import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { IpfsController } from './ipfs.controller';
import { IpfsService } from './ipfs.service';

const GW1 = 'https://gw1.test/ipfs';

const textEncoder = new TextEncoder();
const chunk = (text: string): Uint8Array => textEncoder.encode(text);

const gatewayResponse = (options: {
  contentType?: string | null;
  chunks: Uint8Array[];
}) => ({
  ok: true,
  headers: {
    get: (name: string) =>
      name.toLowerCase() === 'content-type'
        ? (options.contentType ?? null)
        : null,
  },
  body: {
    cancel: jest.fn().mockResolvedValue(undefined),
    getReader: () => {
      let index = 0;
      return {
        read: () =>
          index < options.chunks.length
            ? Promise.resolve({ done: false, value: options.chunks[index++] })
            : Promise.resolve({ done: true, value: undefined }),
        cancel: jest.fn().mockResolvedValue(undefined),
      };
    },
  },
});

describe('IpfsController', () => {
  let app: INestApplication;
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [IpfsController],
      providers: [
        IpfsService,
        {
          provide: ConfigService,
          useValue: new ConfigService({
            ipfs: {
              gateways: [GW1],
              timeoutMs: 250,
              maxBytes: 1024,
              memoryCacheMaxEntries: 10,
              negativeTtlMs: 60000,
            },
          }),
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('GET /ipfs/:cid — 200', () => {
    it('serves JSON payloads with the full hardened header set + attachment disposition', async () => {
      const cid = 'bafyjsonpayload';
      fetchMock.mockResolvedValue(
        gatewayResponse({
          contentType: 'application/json',
          chunks: [chunk('{"a":1}')],
        }),
      );

      const response = await request(app.getHttpServer())
        .get(`/ipfs/${cid}`)
        .expect(200);

      expect(response.headers['cache-control']).toBe(
        'public, max-age=2592000, immutable',
      );
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toBe('sandbox');
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['x-ipfs-gateway']).toBe('gw1.test');
      // Non-image types download instead of rendering.
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="${cid}"`,
      );
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.text).toBe('{"a":1}');
    });

    it('serves image payloads without a Content-Disposition', async () => {
      const cid = 'bafyimagepng';
      fetchMock.mockResolvedValue(
        gatewayResponse({
          contentType: 'image/png',
          chunks: [chunk('pngbytes')],
        }),
      );

      const response = await request(app.getHttpServer())
        .get(`/ipfs/${cid}`)
        .expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      expect(response.headers['content-disposition']).toBeUndefined();
      expect(response.headers['cache-control']).toBe(
        'public, max-age=2592000, immutable',
      );
      expect(response.headers['x-ipfs-gateway']).toBe('gw1.test');
    });

    it('reports the memory cache as the gateway on repeat requests', async () => {
      const cid = 'bafymemorycached';
      fetchMock.mockResolvedValue(
        gatewayResponse({
          contentType: 'application/json',
          chunks: [chunk('{}')],
        }),
      );

      await request(app.getHttpServer()).get(`/ipfs/${cid}`).expect(200);
      const second = await request(app.getHttpServer())
        .get(`/ipfs/${cid}`)
        .expect(200);

      expect(second.headers['x-ipfs-gateway']).toBe('memory-cache');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET /ipfs/:cid — errors', () => {
    it('answers 400 text/plain with short-lived cache headers for malformed cids', async () => {
      const response = await request(app.getHttpServer())
        .get('/ipfs/bad!cid')
        .expect(400);

      expect(response.text).toBe('Bad request');
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('answers 502 text/plain with short-lived cache headers when all gateways fail', async () => {
      fetchMock.mockResolvedValue({ ok: false, body: undefined });

      const response = await request(app.getHttpServer())
        .get('/ipfs/bafydeadgateway')
        .expect(502);

      expect(response.text).toBe('Upstream error');
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.headers['cache-control']).toBe('public, max-age=60');
      expect(response.headers['access-control-allow-origin']).toBe('*');
    });

    it('answers 413 text/plain for oversized payloads', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        headers: {
          get: (name: string) => (name === 'content-length' ? '9999' : null),
        },
        body: {
          cancel: jest.fn().mockResolvedValue(undefined),
          getReader: () => {
            throw new Error('should not be read: fails fast on content-length');
          },
        },
      });

      const response = await request(app.getHttpServer())
        .get('/ipfs/bafyhugepayload')
        .expect(413);

      expect(response.text).toBe('Payload too large');
      expect(response.headers['cache-control']).toBe('public, max-age=60');
    });
  });
});
