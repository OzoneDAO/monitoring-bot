# DeFi Monitoring Bot

A Telegram bot that monitors DeFi metrics across Morpho, Curve, and Uniswap pools, sending periodic updates to a Telegram group. Each monitor posts to its own topic thread. Deployed as a Railway cron job.

## Monitors

### Morpho Vault + Curve Pool (`send_update.ts`)

Tracks the [sky.money USDS Risk Capital](https://app.morpho.org/ethereum/vault/0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4) vault and its associated Curve pool.

**Morpho vault metrics:** total deposits, 1h/12h/24h deposit changes, APY breakdown (native + rewards), average APY trends, stUSDS/USDS market utilization, liquidity, and borrow rates.

**Curve pool metrics:** TVL, pool balances, virtual price, 24h volume & fees, fee APR, CRV APY, gauge rewards.

### USDS Peg Monitor (`send_usds_peg_update.ts`)

Tracks USDS price stability across 4 DEX pools:

| Pool | Type |
|------|------|
| Curve PYUSD/USDS | Curve |
| USDC/USDS 0.01% | Uniswap V4 |
| USDT/USDS 0.01% | Uniswap V4 |
| DAI/USDS 0.3% | Uniswap V3 |

**Metrics per pool:** USDS price, deviation from $1.00 (basis points), TVL, 24h volume, pool composition (Curve only).

**Aggregate:** volume-weighted average price (VWAP), total TVL.

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token

### 2. Get Your Chat ID and Topic IDs

- **Chat ID:** Add the bot to your group, then use the Telegram API to get the chat ID (supergroups are prefixed with `-100`)
- **Topic IDs:** From any message URL in a topic (`https://t.me/c/{chat_id}/{topic_id}/{message_id}`), the second number is the topic/thread ID

### 3. Configure Environment

```bash
cp .env.example .env
```

Fill in `.env`:

```
TELEGRAM_BOT_TOKEN=<your bot token>
TELEGRAM_CHAT_ID=<your chat id>
TELEGRAM_TOPIC_ID_MORPHO=<topic id>
TELEGRAM_TOPIC_ID_CURVE=<topic id>
TELEGRAM_TOPIC_ID_USDS_PEG=<topic id>
```

### 4. Local Testing

```bash
npm install

# Morpho + Curve update
source .env && export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_TOPIC_ID_MORPHO TELEGRAM_TOPIC_ID_CURVE && npx tsx src/send_update.ts

# USDS peg update
source .env && export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID TELEGRAM_TOPIC_ID_USDS_PEG && npx tsx src/send_usds_peg_update.ts
```

## Deployment

Deployed on [Railway](https://railway.app) as a cron job.

- **Config:** `railway.toml`
- **Schedule:** `0 */6 * * *` (every 6 hours)
- **Start command:** `npm start` → `tsx src/send_update.ts`

Environment variables are configured in the Railway service settings.

## Data Sources

| API | Used By | What It Provides |
|-----|---------|-----------------|
| [Morpho Blue GraphQL](https://blue-api.morpho.org/graphql) | Vault monitor | Vault deposits, APY, market state, historical timeseries |
| [Curve Prices API](https://prices.curve.finance) | Vault monitor, Peg monitor | Pool balances, TVL, virtual price |
| [Curve Pools API](https://api.curve.finance) | Vault monitor | Gauge rewards, CRV APY |
| [GeckoTerminal API](https://api.geckoterminal.com) | Peg monitor | Trade-derived token prices, TVL, 24h volume |

## Tech Stack

- **Runtime:** Node.js with native `fetch`
- **Language:** TypeScript (ES2022, strict)
- **Runner:** [tsx](https://github.com/privatenumber/tsx) (zero-config TS execution)
- **Dependencies:** `tsx` only — no other external packages

## License

MIT
