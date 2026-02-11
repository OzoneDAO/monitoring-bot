/**
 * Single-shot script to fetch Morpho vault data and send Telegram update.
 * Designed for use with Railway cron jobs.
 */

const VAULT_ADDRESS = "0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4";
const MARKET_ID =
  "0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82";
const MORPHO_API_URL = "https://blue-api.morpho.org/graphql";

interface TimeseriesPoint {
  x: number;
  y: string | null;
}

interface VaultData {
  name: string;
  totalAssets: string;
  totalAssetsUsd: number;
  avgApy: number;
  avgNetApy: number;
  rewards: { supplyApr: number; asset: { symbol: string } }[];
  historicalState: {
    totalAssets_1h: TimeseriesPoint[];
    totalAssets_12h: TimeseriesPoint[];
    totalAssets_24h: TimeseriesPoint[];
    avgNetApy_1h: TimeseriesPoint[];
    avgNetApy_12h: TimeseriesPoint[];
    avgNetApy_24h: TimeseriesPoint[];
  };
}

interface MarketData {
  state: {
    utilization: number;
    totalLiquidityUsd: number;
    liquidityAssets: string;
    avgBorrowApy: number;
  };
  historicalState: {
    borrowApy_1h: TimeseriesPoint[];
    borrowApy_12h: TimeseriesPoint[];
    borrowApy_24h: TimeseriesPoint[];
  };
}

function buildQuery(): string {
  const now = Math.floor(Date.now() / 1000);
  // Use 2h window for "1h" to ensure we get at least one completed hourly data point
  // (the current hour always returns null as it's still being computed)
  const ts1h = now - 7200;
  const ts12h = now - 43200;
  const ts24h = now - 86400;

  return `
    query GetAllData {
      vault: vaultV2ByAddress(address: "${VAULT_ADDRESS}", chainId: 1) {
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
          totalAssets_1h: totalAssets(options: { startTimestamp: ${ts1h}, endTimestamp: ${now}, interval: HOUR }) { x y }
          totalAssets_12h: totalAssets(options: { startTimestamp: ${ts12h}, endTimestamp: ${now}, interval: HOUR }) { x y }
          totalAssets_24h: totalAssets(options: { startTimestamp: ${ts24h}, endTimestamp: ${now}, interval: HOUR }) { x y }
          avgNetApy_1h: avgNetApy(options: { startTimestamp: ${ts1h}, endTimestamp: ${now}, interval: HOUR }) { x y }
          avgNetApy_12h: avgNetApy(options: { startTimestamp: ${ts12h}, endTimestamp: ${now}, interval: HOUR }) { x y }
          avgNetApy_24h: avgNetApy(options: { startTimestamp: ${ts24h}, endTimestamp: ${now}, interval: HOUR }) { x y }
        }
      }
      market: marketByUniqueKey(uniqueKey: "${MARKET_ID}", chainId: 1) {
        state {
          utilization
          totalLiquidityUsd
          liquidityAssets
          avgBorrowApy
        }
        historicalState {
          borrowApy_1h: borrowApy(options: { startTimestamp: ${ts1h}, endTimestamp: ${now}, interval: HOUR }) { x y }
          borrowApy_12h: borrowApy(options: { startTimestamp: ${ts12h}, endTimestamp: ${now}, interval: HOUR }) { x y }
          borrowApy_24h: borrowApy(options: { startTimestamp: ${ts24h}, endTimestamp: ${now}, interval: HOUR }) { x y }
        }
      }
    }
  `;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatDelta(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${Math.round(value).toLocaleString("en-US")}`;
}

function formatDeltaPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function getTimeseriesValues(
  data: TimeseriesPoint[],
  decimals = 0
): number[] {
  return data
    .filter((p) => p.y !== null)
    .map((p) =>
      decimals > 0
        ? Number(BigInt(p.y!) * 10000n / BigInt(10 ** decimals)) / 10000
        : Number(p.y)
    );
}

function computeAverage(
  data: TimeseriesPoint[],
  decimals = 0
): number | null {
  const values = getTimeseriesValues(data, decimals);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function computeDelta(
  current: number,
  data: TimeseriesPoint[],
  decimals = 0
): [number, number] | null {
  const values = getTimeseriesValues(data, decimals);
  if (values.length === 0) return null;
  // Data is sorted descending (newest first), so last value is oldest
  const oldest = values[values.length - 1];
  if (oldest === 0) return null;
  const absDelta = current - oldest;
  const pctDelta = absDelta / oldest;
  return [absDelta, pctDelta];
}

function formatDepositDelta(delta: [number, number] | null): string {
  if (delta === null) return "N/A";
  const [absD, pctD] = delta;
  return `${formatDeltaPct(pctD)} (${formatDelta(absD)} USDS)`;
}

async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  text: string,
  topicId?: number
): Promise<void> {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
  };
  if (topicId !== undefined) {
    payload.message_thread_id = topicId;
  }

  const res = await fetch(
    `https://api.telegram.org/bot${botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Telegram API error ${res.status}: ${body}`);
  }
}

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.TELEGRAM_TOPIC_ID
    ? Number(process.env.TELEGRAM_TOPIC_ID)
    : undefined;

  if (!botToken || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
  }

  const res = await fetch(MORPHO_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: buildQuery() }),
  });

  if (!res.ok) {
    throw new Error(`Morpho API error: ${res.status}`);
  }

  const json = (await res.json()) as {
    data: { vault: VaultData; market: MarketData };
    errors?: unknown[];
  };

  if (json.errors) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  const { vault, market } = json.data;

  // Vault metrics
  const totalAssetsUsd = Number(vault.totalAssetsUsd);
  const totalAssetsRaw = Number(BigInt(vault.totalAssets) * 10000n / BigInt(10 ** 18)) / 10000;
  const nativeApy = Number(vault.avgApy);
  const netApy = Number(vault.avgNetApy);
  const rewardsApy = vault.rewards.reduce(
    (sum, r) => sum + Number(r.supplyApr),
    0
  );

  // Market metrics
  const { state } = market;
  const utilization = Number(state.utilization);
  const liquidityAssets =
    Number(BigInt(state.liquidityAssets) * 10000n / BigInt(10 ** 18)) / 10000;
  const borrowApy = Number(state.avgBorrowApy);

  // Historical vault data
  const vaultHist = vault.historicalState;
  const delta1h = computeDelta(totalAssetsRaw, vaultHist.totalAssets_1h, 18);
  const delta12h = computeDelta(totalAssetsRaw, vaultHist.totalAssets_12h, 18);
  const delta24h = computeDelta(totalAssetsRaw, vaultHist.totalAssets_24h, 18);

  const avgApy1h = computeAverage(vaultHist.avgNetApy_1h);
  const avgApy12h = computeAverage(vaultHist.avgNetApy_12h);
  const avgApy24h = computeAverage(vaultHist.avgNetApy_24h);

  // Historical market data
  const marketHist = market.historicalState;
  const avgBorrow1h = computeAverage(marketHist.borrowApy_1h);
  const avgBorrow12h = computeAverage(marketHist.borrowApy_12h);
  const avgBorrow24h = computeAverage(marketHist.borrowApy_24h);

  const timestamp = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  const message = `*Morpho Vault Monitor*

*${vault.name}*

*Total Deposits:* ${formatNumber(totalAssetsRaw)} USDS

*Deposit Changes:*
  1h:  ${formatDepositDelta(delta1h)}
  12h: ${formatDepositDelta(delta12h)}
  24h: ${formatDepositDelta(delta24h)}

*APY Breakdown:*
  Native APY: ${formatPct(nativeApy)}
  Rewards APY: ${formatPct(rewardsApy)}
  *Total APY: ${formatPct(netApy)}*

*Avg Total APY:*
  1h:  ${avgApy1h !== null ? formatPct(avgApy1h) : "N/A"}
  12h: ${avgApy12h !== null ? formatPct(avgApy12h) : "N/A"}
  24h: ${avgApy24h !== null ? formatPct(avgApy24h) : "N/A"}

*stUSDS/USDS Market:*
  Utilization: ${formatPct(utilization)}
  Liquidity: ${formatNumber(liquidityAssets)} USDS
  Borrow Rate: ${formatPct(borrowApy)}

*Avg Borrow Rate:*
  1h:  ${avgBorrow1h !== null ? formatPct(avgBorrow1h) : "N/A"}
  12h: ${avgBorrow12h !== null ? formatPct(avgBorrow12h) : "N/A"}
  24h: ${avgBorrow24h !== null ? formatPct(avgBorrow24h) : "N/A"}

_${timestamp}_`;

  await sendTelegramMessage(botToken, chatId, message, topicId);
  console.log(`Update sent: $${formatNumber(totalAssetsUsd)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
