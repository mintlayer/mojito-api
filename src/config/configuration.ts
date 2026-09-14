import * as Joi from 'joi';

/**
 * Environment validation. Values are injected by the deployment (k8s env /
 * Secrets) — nothing secret is ever committed to this repository.
 */
export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production', 'test')
    .default('development'),

  PORT: Joi.number().port().default(3000),

  TESTNET_API: Joi.string()
    .uri()
    .default('https://api-server-lovelace.mintlayer.org/api/v2'),

  MAINNET_API: Joi.string()
    .uri()
    .default('https://api-server.mintlayer.org/api/v2'),

  // Optional by validation: /price degrades gracefully (503) when absent so
  // a missing key can never take the whole service down.
  CMC_API_KEY: Joi.string().allow('').default(''),
  CMC_COIN_ID: Joi.string().default('14977'),

  UPSTREAM_TTL_MS: Joi.number().min(0).default(30000),

  CHAIN_TIP_POLL_MS: Joi.number().min(1000).default(10000),

  IPFS_GATEWAYS: Joi.string().default(
    'https://gateway.pinata.cloud/ipfs,https://4everland.io/ipfs,https://ipfs.io/ipfs',
  ),
  IPFS_TIMEOUT_MS: Joi.number().min(1000).default(12000),
  IPFS_MAX_BYTES: Joi.number()
    .min(1)
    .default(5 * 1024 * 1024),
  IPFS_MEMORY_CACHE_MAX_ENTRIES: Joi.number().min(0).default(5000),
  IPFS_NEGATIVE_TTL_MS: Joi.number().min(0).default(60000),
});

export default () => ({
  nodeEnv: process.env.NODE_ENV,
  port: parseInt(process.env.PORT ?? '3000', 10),
  testnetApi: process.env.TESTNET_API,
  mainnetApi: process.env.MAINNET_API,
  cmc: {
    apiKey: process.env.CMC_API_KEY ?? '',
    coinId: process.env.CMC_COIN_ID ?? '14977',
  },
  upstreamTtlMs: parseInt(process.env.UPSTREAM_TTL_MS ?? '30000', 10),
  chainTipPollMs: parseInt(process.env.CHAIN_TIP_POLL_MS ?? '10000', 10),
  ipfs: {
    gateways: (process.env.IPFS_GATEWAYS ?? '').split(',').filter(Boolean),
    timeoutMs: parseInt(process.env.IPFS_TIMEOUT_MS ?? '12000', 10),
    maxBytes: parseInt(
      process.env.IPFS_MAX_BYTES ?? String(5 * 1024 * 1024),
      10,
    ),
    memoryCacheMaxEntries: parseInt(
      process.env.IPFS_MEMORY_CACHE_MAX_ENTRIES ?? '5000',
      10,
    ),
    negativeTtlMs: parseInt(process.env.IPFS_NEGATIVE_TTL_MS ?? '60000', 10),
  },
});
