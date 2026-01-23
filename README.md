# Morpho Vault Monitoring Bot

A Telegram bot that monitors the [sky.money USDS Risk Capital](https://app.morpho.org/ethereum/vault/0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4/skymoney-usds-risk-capital) vault on Morpho and sends hourly updates.

## Features

- Reports total deposits in USDS
- APY breakdown (Native + Rewards)
- stUSDS/USDS market metrics (utilization, liquidity, borrow rate)
- Runs hourly via GitHub Actions (free)

## Sample Message

```
Morpho Vault Monitor

sky.money USDS Risk Capital

Total Deposits: 3,987,844.23 USDS

APY Breakdown:
  Native APY: 5.41%
  Rewards APY: 10.00%
  Total APY: 15.41%

stUSDS/USDS Market:
  Utilization: 100.00%
  Liquidity: 0.00 USDS
  Borrow Rate: 6.30%

2026-01-23 11:00 UTC
```

## Setup

### 1. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Send `/newbot` and follow the prompts
3. Save the bot token

### 2. Get Your Chat ID

1. Message your new bot (send `/start`)
2. Run the helper script:
   ```bash
   pip install -r requirements.txt
   TELEGRAM_BOT_TOKEN=your_token python get_chat_id.py
   ```

### 3. Deploy to GitHub Actions

1. Fork/push this repo to GitHub
2. Go to Settings → Secrets and variables → Actions
3. Add secrets:
   - `TELEGRAM_BOT_TOKEN` - Your bot token
   - `TELEGRAM_CHAT_ID` - Your chat ID
4. The bot will run automatically every hour

### Local Testing

```bash
# Install dependencies
pip install -r requirements.txt

# Create .env file
cp .env.example .env
# Edit .env with your credentials

# Run single update
source .env && export TELEGRAM_BOT_TOKEN TELEGRAM_CHAT_ID && python send_update.py

# Or run continuous bot
python bot.py
```

## Data Sources

- **Morpho GraphQL API:** https://blue-api.morpho.org/graphql
- **Vault:** [sky.money USDS Risk Capital](https://app.morpho.org/ethereum/vault/0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4)
- **Market:** [stUSDS/USDS](https://app.morpho.org/ethereum/market/0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82)

## License

MIT
