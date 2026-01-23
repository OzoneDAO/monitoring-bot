#!/usr/bin/env python3
"""
Morpho Vault Monitoring Bot for Telegram
Monitors total deposits in the sky.money USDS Risk Capital vault
"""

import asyncio
import logging
import os
from datetime import datetime
from decimal import Decimal

import httpx
from dotenv import load_dotenv
from telegram import Bot
from telegram.error import TelegramError
from telegram.request import HTTPXRequest
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

load_dotenv()

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)

VAULT_ADDRESS = "0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4"
MARKET_ID = "0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82"
MORPHO_API_URL = "https://blue-api.morpho.org/graphql"

COMBINED_QUERY = """
query GetAllData {
    vault: vaultV2ByAddress(address: "%s", chainId: 1) {
        address
        name
        symbol
        totalAssets
        totalAssetsUsd
        totalSupply
        avgApy
        avgNetApy
        rewards {
            supplyApr
            asset { symbol }
        }
    }
    market: marketByUniqueKey(uniqueKey: "%s", chainId: 1) {
        loanAsset { symbol }
        collateralAsset { symbol }
        state {
            utilization
            totalLiquidityUsd
            liquidityAssets
            avgBorrowApy
        }
    }
}
""" % (VAULT_ADDRESS, MARKET_ID)


class MorphoMonitor:
    def __init__(self):
        self.bot_token = os.getenv("TELEGRAM_BOT_TOKEN")
        self.chat_id = os.getenv("TELEGRAM_CHAT_ID", "@machilassab")
        self.interval = int(os.getenv("MONITORING_INTERVAL", "60"))

        if not self.bot_token:
            raise ValueError("TELEGRAM_BOT_TOKEN environment variable is required")

        request = HTTPXRequest(connect_timeout=30.0, read_timeout=30.0)
        self.bot = Bot(token=self.bot_token, request=request)
        self.http_client = httpx.AsyncClient(timeout=30.0)
        self.previous_total_usd = None

    async def fetch_data(self) -> dict | None:
        """Fetch vault and market data from Morpho GraphQL API"""
        try:
            response = await self.http_client.post(
                MORPHO_API_URL,
                json={"query": COMBINED_QUERY},
                headers={"Content-Type": "application/json"}
            )
            response.raise_for_status()
            data = response.json()

            if "errors" in data:
                logger.error(f"GraphQL errors: {data['errors']}")
                return None

            return data.get("data", {})
        except Exception as e:
            logger.error(f"Failed to fetch data: {e}")
            return None

    def format_number(self, value: float) -> str:
        """Format number with commas and 2 decimal places"""
        return f"{value:,.2f}"

    def format_change(self, current: float, previous: float | None) -> str:
        """Format the change since last update"""
        if previous is None:
            return ""

        change = current - previous
        pct_change = (change / previous) * 100 if previous != 0 else 0

        if change >= 0:
            return f"\n+${self.format_number(change)} (+{pct_change:.2f}%)"
        else:
            return f"\n-${self.format_number(abs(change))} ({pct_change:.2f}%)"

    def format_pct(self, value: float) -> str:
        """Format as percentage"""
        return f"{value * 100:.2f}%"

    async def send_update(self):
        """Fetch data and send update to Telegram"""
        data = await self.fetch_data()

        if not data:
            logger.warning("No data available, skipping update")
            return

        vault_data = data.get("vault")
        market_data = data.get("market")

        if not vault_data:
            logger.warning("No vault data available, skipping update")
            return

        # Vault metrics
        total_assets_raw = int(vault_data["totalAssets"])
        total_assets_usd = float(vault_data["totalAssetsUsd"])
        vault_name = vault_data["name"]
        native_apy = float(vault_data["avgApy"])
        net_apy = float(vault_data["avgNetApy"])
        # Get rewards APY from rewards array
        rewards_apy = sum(float(r["supplyApr"]) for r in vault_data.get("rewards", []))

        # USDS has 18 decimals
        total_assets_usds = total_assets_raw / (10 ** 18)

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # Build message
        message_parts = [
            f"*Morpho Vault Monitor*",
            f"",
            f"*{vault_name}*",
            f"",
            f"*Total Deposits:* {self.format_number(total_assets_usds)} USDS",
            f"",
            f"*APY Breakdown:*",
            f"  Native APY: {self.format_pct(native_apy)}",
            f"  Rewards APY: {self.format_pct(rewards_apy)}",
            f"  *Total APY: {self.format_pct(net_apy)}*",
        ]

        # Add market data if available
        if market_data and market_data.get("state"):
            state = market_data["state"]
            utilization = float(state["utilization"])
            liquidity_assets = int(state["liquidityAssets"]) / (10 ** 18)
            borrow_apy = float(state["avgBorrowApy"])

            message_parts.extend([
                f"",
                f"*stUSDS/USDS Market:*",
                f"  Utilization: {self.format_pct(utilization)}",
                f"  Liquidity: {self.format_number(liquidity_assets)} USDS",
                f"  Borrow Rate: {self.format_pct(borrow_apy)}",
            ])

        message_parts.extend([
            f"",
            f"_{timestamp}_",
        ])

        message = "\n".join(message_parts)

        try:
            await self.bot.send_message(
                chat_id=self.chat_id,
                text=message,
                parse_mode="Markdown"
            )
            logger.info(f"Update sent: ${self.format_number(total_assets_usd)}")
        except TelegramError as e:
            logger.error(f"Failed to send Telegram message: {e}")

    async def run(self):
        """Start the monitoring bot"""
        logger.info(f"Starting Morpho Vault Monitor")
        logger.info(f"Vault: {VAULT_ADDRESS}")
        logger.info(f"Chat ID: {self.chat_id}")
        logger.info(f"Interval: {self.interval} seconds")

        # Send initial update
        await self.send_update()

        # Schedule periodic updates
        scheduler = AsyncIOScheduler()
        scheduler.add_job(
            self.send_update,
            trigger=IntervalTrigger(seconds=self.interval),
            id="vault_monitor",
            name="Morpho Vault Monitor"
        )
        scheduler.start()

        logger.info("Scheduler started. Press Ctrl+C to stop.")

        try:
            while True:
                await asyncio.sleep(1)
        except (KeyboardInterrupt, SystemExit):
            logger.info("Shutting down...")
            scheduler.shutdown()
            await self.http_client.aclose()


async def main():
    monitor = MorphoMonitor()
    await monitor.run()


if __name__ == "__main__":
    asyncio.run(main())
