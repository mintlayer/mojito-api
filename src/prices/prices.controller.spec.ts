import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { PricesController } from './prices.controller';
import { PricesService } from './prices.service';
import { PRICE_ID_BY_TICKER } from './ticker-map';

describe('PricesController', () => {
  let app: INestApplication;

  const getPricesMock = jest.fn();
  const coveredTickerCountMock = jest.fn();
  const isStaleMock = jest.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PricesController],
      providers: [
        {
          provide: PricesService,
          useValue: {
            getPrices: getPricesMock,
            coveredTickerCount: coveredTickerCountMock,
            isStale: isStaleMock,
          },
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
    getPricesMock.mockReset();
    coveredTickerCountMock.mockReset();
    isStaleMock.mockReset();
  });

  describe('GET /prices', () => {
    it('passes the full map through when no tickers filter is given', async () => {
      const prices = { ml: 0.05, wbtc: 60_000, waaplx: 228.4 };
      getPricesMock.mockResolvedValue(prices);

      const response = await request(app.getHttpServer())
        .get('/prices')
        .expect(200);

      expect(response.body).toEqual(prices);
      expect(getPricesMock).toHaveBeenCalledTimes(1);
      expect(getPricesMock).toHaveBeenCalledWith(undefined);
    });

    it('splits, trims and drops empty parts of ?tickers before delegating to the service', async () => {
      getPricesMock.mockResolvedValue({ wbtc: 60_000, ml: 0.05 });

      const response = await request(app.getHttpServer())
        .get(`/prices?tickers=${encodeURIComponent(' WBTC , ml , , ')}`)
        .expect(200);

      // Case is left intact here — lowercasing is the service's job.
      expect(getPricesMock).toHaveBeenCalledWith(['WBTC', 'ml']);
      expect(response.body).toEqual({ wbtc: 60_000, ml: 0.05 });
    });

    it('delegates an empty filter list when ?tickers is made only of blanks', async () => {
      getPricesMock.mockResolvedValue({});

      await request(app.getHttpServer())
        .get(`/prices?tickers=${encodeURIComponent(' ,  , ')}`)
        .expect(200);

      expect(getPricesMock).toHaveBeenCalledWith([]);
    });

    it('is CORS-open for the browser bridge', async () => {
      getPricesMock.mockResolvedValue({ ml: 0.05 });

      const response = await request(app.getHttpServer())
        .get('/prices')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('*');
    });
  });

  describe('GET /prices/coverage', () => {
    it('reports the covered count, staleness and the full ticker map', async () => {
      coveredTickerCountMock.mockReturnValue(36);
      isStaleMock.mockReturnValue(false);

      const response = await request(app.getHttpServer())
        .get('/prices/coverage')
        .expect(200);

      expect(response.body).toEqual({
        covered: 36,
        prices_stale: false,
        map: PRICE_ID_BY_TICKER,
      });
      expect(coveredTickerCountMock).toHaveBeenCalledTimes(1);
      expect(isStaleMock).toHaveBeenCalledTimes(1);
    });

    it('is CORS-open and forwards the staleness flag', async () => {
      coveredTickerCountMock.mockReturnValue(36);
      isStaleMock.mockReturnValue(true);

      const response = await request(app.getHttpServer())
        .get('/prices/coverage')
        .expect(200);

      expect(response.headers['access-control-allow-origin']).toBe('*');
      expect(response.body.prices_stale).toBe(true);
    });
  });
});
