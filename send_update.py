#!/usr/bin/env python3
"""
Single-shot script to fetch Morpho vault data and send Telegram update.
Designed for use with GitHub Actions or other cron schedulers.
"""

import asyncio
import os
from datetime import datetime

import httpx
from telegram import Bot
from telegram.request import HTTPXRequest

VAULT_ADDRESS = "0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4"
MARKET_ID = "0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82"
MORPHO_API_URL = "https://blue-api.morpho.org/graphql"

COMBINED_QUERY = """
query GetAllData {
    vault: vaultV2ByAddress(address: "%s", chainId: 1) {
        address
        name
        totalAssets
        totalAssetsUsd
        avgApy
        avgNetApy
        rewards {
            supplyApr
            asset { symbol }
        }
    }
    market: marketByUniqueKey(uniqueKey: "%s", chainId: 1) {
        state {
            utilization
            totalLiquidityUsd
            liquidityAssets
            avgBorrowApy
        }
    }
}
""" % (VAULT_ADDRESS, MARKET_ID)


def format_number(value: float) -> str:
    return f"{value:,.2f}"


def format_pct(value: float) -> str:
    return f"{value * 100:.2f}%"


async def main():
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")

    if not bot_token or not chat_id:
        raise ValueError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set")

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            MORPHO_API_URL,
            json={"query": COMBINED_QUERY},
            headers={"Content-Type": "application/json"}
        )
        response.raise_for_status()
        data = response.json()

        if "errors" in data:
            raise Exception(f"GraphQL errors: {data['errors']}")

        vault = data["data"]["vault"]
        market = data["data"]["market"]

        # Vault metrics
        total_assets_usd = float(vault["totalAssetsUsd"])
        total_assets_raw = int(vault["totalAssets"]) / (10 ** 18)
        native_apy = float(vault["avgApy"])
        net_apy = float(vault["avgNetApy"])
        rewards_apy = sum(float(r["supplyApr"]) for r in vault.get("rewards", []))

        # Market metrics
        state = market["state"]
        utilization = float(state["utilization"])
        liquidity_usd = float(state["totalLiquidityUsd"])
        liquidity_assets = int(state["liquidityAssets"]) / (10 ** 18)
        borrow_apy = float(state["avgBorrowApy"])

        timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

        message = f"""*Morpho Vault Monitor*

*{vault["name"]}*

*Total Deposits:* {format_number(total_assets_raw)} USDS

*APY Breakdown:*
  Native APY: {format_pct(native_apy)}
  Rewards APY: {format_pct(rewards_apy)}
  *Total APY: {format_pct(net_apy)}*

*stUSDS/USDS Market:*
  Utilization: {format_pct(utilization)}
  Liquidity: {format_number(liquidity_assets)} USDS
  Borrow Rate: {format_pct(borrow_apy)}

_{timestamp}_"""

    request = HTTPXRequest(connect_timeout=30.0, read_timeout=30.0)
    bot = Bot(token=bot_token, request=request)
    await bot.send_message(chat_id=chat_id, text=message, parse_mode="Markdown")
    print(f"Update sent: ${format_number(total_assets_usd)}")


if __name__ == "__main__":
    asyncio.run(main())
