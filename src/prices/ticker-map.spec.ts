import {
  BRIDGE_TICKERS,
  PRICE_ID_BY_TICKER,
  tickerToPriceId,
} from './ticker-map';

describe('ticker-map', () => {
  it('covers exactly 36 bridge tickers', () => {
    expect(BRIDGE_TICKERS).toHaveLength(36);
    expect(Object.keys(PRICE_ID_BY_TICKER)).toHaveLength(36);
    expect(BRIDGE_TICKERS).toEqual(Object.keys(PRICE_ID_BY_TICKER));
  });

  it('maps every ticker to a non-empty lowercase kebab-case CoinGecko id', () => {
    for (const [ticker, id] of Object.entries(PRICE_ID_BY_TICKER)) {
      expect(id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(ticker).toBe(ticker.toLowerCase());
    }
  });

  it('splits into 16 crypto entries and 20 xStock entries', () => {
    const xstocks = Object.entries(PRICE_ID_BY_TICKER).filter(([, id]) =>
      id.endsWith('-xstock'),
    );

    expect(xstocks).toHaveLength(20);
    expect(Object.keys(PRICE_ID_BY_TICKER).length - xstocks.length).toBe(16);
  });

  it('follows the <company>-xstock id convention for the tokenized equities', () => {
    expect(PRICE_ID_BY_TICKER['waaplx']).toBe('apple-xstock');
    expect(PRICE_ID_BY_TICKER['wtslax']).toBe('tesla-xstock');
    expect(PRICE_ID_BY_TICKER['wmcdx']).toBe('mcdonald-s-xstock');
    expect(PRICE_ID_BY_TICKER['wdisx']).toBe('the-walt-disney-xstock');
    expect(PRICE_ID_BY_TICKER['wiwmx']).toBe('russell-2000-xstock');
    expect(PRICE_ID_BY_TICKER['wjpmx']).toBe('jpmorgan-chase-xstock');
  });

  it('covers the crypto/DeFi core of the bridge', () => {
    expect(PRICE_ID_BY_TICKER['ml']).toBe('mintlayer');
    expect(PRICE_ID_BY_TICKER['wbtc']).toBe('wrapped-bitcoin');
    expect(PRICE_ID_BY_TICKER['usdc']).toBe('usd-coin');
    expect(PRICE_ID_BY_TICKER['link']).toBe('chainlink');
  });

  it('resolves tickers case-insensitively', () => {
    expect(tickerToPriceId('WBTC')).toBe('wrapped-bitcoin');
    expect(tickerToPriceId('wAaplX')).toBe('apple-xstock');
    expect(tickerToPriceId('ml')).toBe('mintlayer');
  });

  it('returns undefined for unknown tickers', () => {
    expect(tickerToPriceId('nope')).toBeUndefined();
    expect(tickerToPriceId('')).toBeUndefined();
    expect(tickerToPriceId('BTC')).toBeUndefined(); // bare BTC is not bridgeable
  });
});
