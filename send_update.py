#!/usr/bin/env python3
"""
Single-shot script to fetch Morpho vault data and send Telegram update.
Designed for use with GitHub Actions or other cron schedulers.
"""

import asyncio
import os
import time
from datetime import datetime

import httpx
from telegram import Bot
from telegram.request import HTTPXRequest

VAULT_ADDRESS = "0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4"
MARKET_ID = "0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82"
MORPHO_API_URL = "https://blue-api.morpho.org/graphql"


def build_query():
    """Build GraphQL query with historical data for 1h, 12h, 24h periods."""
    now = int(time.time())
    # Use 2h window for "1h" to ensure we get at least one completed hourly data point
    # (the current hour always returns null as it's still being computed)
    ts_1h = now - 7200
    ts_12h = now - 43200
    ts_24h = now - 86400

    return """
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
            historicalState {
                totalAssets_1h: totalAssets(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
                totalAssets_12h: totalAssets(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
                totalAssets_24h: totalAssets(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
                avgNetApy_1h: avgNetApy(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
                avgNetApy_12h: avgNetApy(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
                avgNetApy_24h: avgNetApy(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
            }
        }
        market: marketByUniqueKey(uniqueKey: "%s", chainId: 1) {
            state {
                utilization
                totalLiquidityUsd
                liquidityAssets
                avgBorrowApy
            }
            historicalState {
                borrowApy_1h: borrowApy(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
                borrowApy_12h: borrowApy(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
                borrowApy_24h: borrowApy(options: { startTimestamp: %d, endTimestamp: %d, interval: HOUR }) { x y }
            }
        }
    }
    """ % (
        VAULT_ADDRESS,
        ts_1h, now, ts_12h, now, ts_24h, now,  # totalAssets
        ts_1h, now, ts_12h, now, ts_24h, now,  # avgNetApy
        MARKET_ID,
        ts_1h, now, ts_12h, now, ts_24h, now,  # borrowApy
    )


def format_number(value: float) -> str:
    return f"{value:,.2f}"


def format_pct(value: float) -> str:
    return f"{value * 100:.2f}%"


def format_delta(value: float) -> str:
    """Format delta with +/- sign."""
    sign = "+" if value >= 0 else ""
    return f"{sign}{value:,.0f}"


def format_delta_pct(value: float) -> str:
    """Format percentage delta with +/- sign."""
    sign = "+" if value >= 0 else ""
    return f"{sign}{value * 100:.2f}%"


def get_timeseries_values(data: list, decimals: int = 0) -> list:
    """
    Extract non-null y values from timeseries data.
    If decimals > 0, treat y as BigInt string and divide by 10^decimals.
    """
    values = []
    for point in data:
        y = point.get("y")
        if y is None:
            continue
        if decimals > 0:
            values.append(int(y) / (10 ** decimals))
        else:
            values.append(float(y))
    return values


def compute_average(data: list, decimals: int = 0) -> float | None:
    """Compute average from timeseries data, ignoring nulls."""
    values = get_timeseries_values(data, decimals)
    return sum(values) / len(values) if values else None


def compute_delta(current: float, data: list, decimals: int = 0) -> tuple[float, float] | None:
    """
    Compute delta between current value and oldest value in timeseries.
    Returns (absolute_delta, percent_delta) or None if no historical data.
    """
    values = get_timeseries_values(data, decimals)
    if not values:
        return None
    # Data is sorted descending (newest first), so last value is oldest
    oldest = values[-1]
    if oldest == 0:
        return None
    abs_delta = current - oldest
    pct_delta = abs_delta / oldest
    return (abs_delta, pct_delta)


async def main():
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")

    if not bot_token or not chat_id:
        raise ValueError("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set")

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            MORPHO_API_URL,
            json={"query": build_query()},
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

        # Historical vault data
        vault_hist = vault["historicalState"]

        # Deposit deltas (totalAssets is BigInt with 18 decimals)
        delta_1h = compute_delta(total_assets_raw, vault_hist["totalAssets_1h"], decimals=18)
        delta_12h = compute_delta(total_assets_raw, vault_hist["totalAssets_12h"], decimals=18)
        delta_24h = compute_delta(total_assets_raw, vault_hist["totalAssets_24h"], decimals=18)

        # Average APYs
        avg_apy_1h = compute_average(vault_hist["avgNetApy_1h"])
        avg_apy_12h = compute_average(vault_hist["avgNetApy_12h"])
        avg_apy_24h = compute_average(vault_hist["avgNetApy_24h"])

        # Historical market data
        market_hist = market["historicalState"]

        # Average borrow rates
        avg_borrow_1h = compute_average(market_hist["borrowApy_1h"])
        avg_borrow_12h = compute_average(market_hist["borrowApy_12h"])
        avg_borrow_24h = compute_average(market_hist["borrowApy_24h"])

        timestamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC")

        # Format deposit changes
        def format_deposit_delta(delta):
            if delta is None:
                return "N/A"
            abs_d, pct_d = delta
            return f"{format_delta_pct(pct_d)} ({format_delta(abs_d)} USDS)"

        message = f"""*Morpho Vault Monitor*

*{vault["name"]}*

*Total Deposits:* {format_number(total_assets_raw)} USDS

*Deposit Changes:*
  1h:  {format_deposit_delta(delta_1h)}
  12h: {format_deposit_delta(delta_12h)}
  24h: {format_deposit_delta(delta_24h)}

*APY Breakdown:*
  Native APY: {format_pct(native_apy)}
  Rewards APY: {format_pct(rewards_apy)}
  *Total APY: {format_pct(net_apy)}*

*Avg Total APY:*
  1h:  {format_pct(avg_apy_1h) if avg_apy_1h else "N/A"}
  12h: {format_pct(avg_apy_12h) if avg_apy_12h else "N/A"}
  24h: {format_pct(avg_apy_24h) if avg_apy_24h else "N/A"}

*stUSDS/USDS Market:*
  Utilization: {format_pct(utilization)}
  Liquidity: {format_number(liquidity_assets)} USDS
  Borrow Rate: {format_pct(borrow_apy)}

*Avg Borrow Rate:*
  1h:  {format_pct(avg_borrow_1h) if avg_borrow_1h else "N/A"}
  12h: {format_pct(avg_borrow_12h) if avg_borrow_12h else "N/A"}
  24h: {format_pct(avg_borrow_24h) if avg_borrow_24h else "N/A"}

_{timestamp}_"""

    request = HTTPXRequest(connect_timeout=30.0, read_timeout=30.0)
    bot = Bot(token=bot_token, request=request)
    await bot.send_message(chat_id=chat_id, text=message, parse_mode="Markdown")
    print(f"Update sent: ${format_number(total_assets_usd)}")


if __name__ == "__main__":
    asyncio.run(main())
