/**
 * USD price coverage for the FULL bridge asset set (bridge.mintlayer.org
 * `agents-config`, mainnet flavor): 16 crypto/DeFi tickers + 20 xStocks
 * tokenized equities.
 *
 * CoinGecko ids for the xStocks family follow the `<company>-xstock`
 * convention (e.g. `waaplx` wraps AAPLX → `apple-xstock`). Verified
 * against the live CG simple/price + search endpoints.
 */
export const PRICE_ID_BY_TICKER: Record<string, string> = {
  // crypto / DeFi
  ml: 'mintlayer',
  usdc: 'usd-coin',
  usdt: 'tether',
  dai: 'dai',
  weth: 'weth',
  wbtc: 'wrapped-bitcoin',
  wsteth: 'wrapped-steth',
  pepe: 'pepe',
  shib: 'shiba-inu',
  aave: 'aave',
  comp: 'compound-governance-token',
  crv: 'curve-dao-token',
  ldo: 'lido-dao',
  link: 'chainlink',
  ondo: 'ondo-finance',
  uni: 'uniswap',
  // xStocks (tokenized equities/ETFs)
  waaplx: 'apple-xstock',
  wamdx: 'amd-xstock',
  wamznx: 'amazon-xstock',
  wavgox: 'broadcom-xstock',
  wdisx: 'the-walt-disney-xstock',
  wgldx: 'gold-xstock',
  wgooglx: 'alphabet-xstock',
  wiwmx: 'russell-2000-xstock',
  wjpmx: 'jpmorgan-chase-xstock',
  wkox: 'coca-cola-xstock',
  wllyx: 'eli-lilly-xstock',
  wmcdx: 'mcdonald-s-xstock',
  wmetax: 'meta-xstock',
  wmsftx: 'microsoft-xstock',
  wnflxx: 'netflix-xstock',
  wnvdax: 'nvidia-xstock',
  wqqqx: 'nasdaq-xstock',
  wspyx: 'sp500-xstock',
  wtslax: 'tesla-xstock',
  wxomx: 'exxon-mobil-xstock',
};

export const BRIDGE_TICKERS = Object.keys(PRICE_ID_BY_TICKER);

export const tickerToPriceId = (ticker: string): string | undefined =>
  PRICE_ID_BY_TICKER[ticker.toLowerCase()];
