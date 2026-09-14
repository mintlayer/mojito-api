# mojito-api

[![CI](https://github.com/mintlayer/mojito-api/actions/workflows/ci.yml/badge.svg)](https://github.com/mintlayer/mojito-api/actions/workflows/ci.yml)

Mojito API gateway: the Mintlayer **batch/aggregation service** behind
`mojito-api.mintlayer.org` and `api.mintini.app`, plus a hardened
**IPFS content cache**.

This service is the consolidated successor of the legacy `wallet-batch`
container (the Mintini backend whose source previously lived only inside a
Docker image) — rebuilt as a NestJS application with tests, CI and no
committed secrets.

## Endpoints

Legacy-compatible paths (the Traefik ingress rules must keep working
unchanged):

| Endpoint | Consumer | Notes |
|---|---|---|
| `POST /batch_data` | Extension via `/mintlayer/{net}/batch` (rewrite) | Batch-fetch an endpoint template for many ids, cached 30s |
| `GET /dex_tokens?network=` | Extension via `/batch/dex_tokens` (strip `/batch`) | All tradable tokens |
| `GET /chain_tip` | Legacy clients | **Quirk (preserved): always returns the MAINNET height** |
| `GET /price` | Mintini app | ML USD quote from CoinMarketCap (key via `CMC_API_KEY` env) |
| `POST /account` | Mintini app | Aggregated tokens / utxos / delegations view |
| `POST /tokens` | Mintini app | Token view (hardcoded 0.1035 ML rate — legacy quirk) |
| `POST /utxos` | Mintini app | Flattened spendable UTXOs |
| `POST /activity` | Mintini app | Classified activity (send / receive / swap / delegation) |
| `POST /transaction?network=` | Mintini app | Broadcast proxy (raw text body) |
| `WS /ws` | Mintini app | `setNetwork` → `blockHeight` broadcasts |
| `GET /ipfs/:cid` | Wallets + web | Hardened IPFS metadata/icon cache (`ACAO: *`) |

## Fixes over the legacy service

- **`/ws` and block-height works again.** The legacy service tailed PM2
  log files that don't exist inside k8s, so heights were silently stuck at
  0 since the cluster migration. This service polls both api-servers'
  `/chain/tip` instead.
- **No secrets in code.** The legacy service hardcoded a CoinMarketCap API
  key (since rotated). `CMC_API_KEY` is injected by the deployment.
- Validation, structured error surface, rate limiting, helmet, Docker
  healthcheck, non-root container.

## Known preserved quirks

- `GET /chain_tip` always returns the **mainnet** height (legacy clients
  may depend on it). Fixing requires a coordinated release with consumers.
- `POST /tokens` uses a hardcoded `0.1035` ML price for its `value` field.
- One shared upstream cache: a new block on **either** network clears it.
- Upstream fetch failures surface as `"Error: <message>"` **strings**
  inside `results` instead of errors — clients depend on this shape.

## Development

```bash
npm ci
cp .env.example .env      # fill CMC_API_KEY locally if you need /price
npm run start:dev
npm test
npm run lint:check
```

Swagger: http://localhost:3000/api/docs

## Deployment

Docker image builds via CI to `rg.nl-ams.scw.cloud/mintlayer/mojito-api`.
The k8s manifests live in the `infra` repository
(`apps/common/mojito-api/`). Secrets are **never** committed anywhere:
inject `CMC_API_KEY` as a cluster Secret at deploy time.
