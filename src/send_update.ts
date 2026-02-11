/**
 * Single-shot script to fetch Morpho vault + Curve pool data and send Telegram updates.
 * Designed for use with Railway cron jobs.
 */

// --- Constants ---

const VAULT_ADDRESS = "0xf42bca228D9bd3e2F8EE65Fec3d21De1063882d4";
const MARKET_ID =
  "0x77e624dd9dd980810c2b804249e88f3598d9c7ec91f16aa5fbf6e3fdf6087f82";
const MORPHO_API_URL = "https://blue-api.morpho.org/graphql";

const CURVE_POOL_ADDRESS =
  "0x2c7c98a3b1582d83c43987202aeff638312478ae";
const CURVE_POOL_API_URL = `https://prices.curve.finance/v1/pools/ethereum/${CURVE_POOL_ADDRESS}`;
const CURVE_POOLS_API_URL =
  "https://api.curve.finance/v1/getPools/ethereum/factory-stable-ng";

// --- Morpho types ---

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

// --- Curve types ---

interface CurvePoolData {
  name: string;
  tvl_usd: number;
  balances: number[];
  trading_volume_24h: number;
  trading_fee_24h: number;
  base_daily_apr: number;
  base_weekly_apr: number;
  virtual_price: number;
  coins: { symbol: string; decimals: number }[];
}

interface CurveGaugeReward {
  symbol: string;
  apy: number;
}

interface CurvePoolsEntry {
  address: string;
  gaugeCrvApy: [number, number];
  gaugeRewards: CurveGaugeReward[];
}

// --- Shared helpers ---

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatPctRaw(value: number): string {
  return `${value.toFixed(2)}%`;
}

function formatDelta(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${Math.round(value).toLocaleString("en-US")}`;
}

function formatDeltaPct(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}%`;
}

function formatDepositDelta(delta: [number, number] | null): string {
  if (delta === null) return "N/A";
  const [absD, pctD] = delta;
  return `${formatDeltaPct(pctD)} (${formatDelta(absD)} USDS)`;
}

function getTimeseriesValues(
  data: TimeseriesPoint[],
  decimals = 0
): number[] {
  return data
    .filter((p) => p.y !== null)
    .map((p) =>
      decimals > 0
        ? Number((BigInt(p.y!) * 10000n) / BigInt(10 ** decimals)) / 10000
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
  const oldest = values[values.length - 1];
  if (oldest === 0) return null;
  const absDelta = current - oldest;
  const pctDelta = absDelta / oldest;
  return [absDelta, pctDelta];
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

// --- Morpho update ---

function buildMorphoQuery(): string {
  const now = Math.floor(Date.now() / 1000);
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

async function fetchAndSendMorphoUpdate(
  botToken: string,
  chatId: string,
  topicId?: number
): Promise<void> {
  const res = await fetch(MORPHO_API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: buildMorphoQuery() }),
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

  const totalAssetsUsd = Number(vault.totalAssetsUsd);
  const totalAssetsRaw =
    Number((BigInt(vault.totalAssets) * 10000n) / BigInt(10 ** 18)) / 10000;
  const nativeApy = Number(vault.avgApy);
  const netApy = Number(vault.avgNetApy);
  const rewardsApy = vault.rewards.reduce(
    (sum, r) => sum + Number(r.supplyApr),
    0
  );

  const { state } = market;
  const utilization = Number(state.utilization);
  const liquidityAssets =
    Number((BigInt(state.liquidityAssets) * 10000n) / BigInt(10 ** 18)) / 10000;
  const borrowApy = Number(state.avgBorrowApy);

  const vaultHist = vault.historicalState;
  const delta1h = computeDelta(totalAssetsRaw, vaultHist.totalAssets_1h, 18);
  const delta12h = computeDelta(totalAssetsRaw, vaultHist.totalAssets_12h, 18);
  const delta24h = computeDelta(totalAssetsRaw, vaultHist.totalAssets_24h, 18);

  const avgApy1h = computeAverage(vaultHist.avgNetApy_1h);
  const avgApy12h = computeAverage(vaultHist.avgNetApy_12h);
  const avgApy24h = computeAverage(vaultHist.avgNetApy_24h);

  const marketHist = market.historicalState;
  const avgBorrow1h = computeAverage(marketHist.borrowApy_1h);
  const avgBorrow12h = computeAverage(marketHist.borrowApy_12h);
  const avgBorrow24h = computeAverage(marketHist.borrowApy_24h);

  const timestamp =
    new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

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
  console.log(`[Morpho] Update sent: $${formatNumber(totalAssetsUsd)}`);
}

// --- Curve update ---

async function fetchAndSendCurveUpdate(
  botToken: string,
  chatId: string,
  topicId?: number
): Promise<void> {
  // Fetch pool data and gauge rewards in parallel
  const [poolRes, poolsRes] = await Promise.all([
    fetch(CURVE_POOL_API_URL),
    fetch(CURVE_POOLS_API_URL),
  ]);

  if (!poolRes.ok) {
    throw new Error(`Curve pool API error: ${poolRes.status}`);
  }
  if (!poolsRes.ok) {
    throw new Error(`Curve pools API error: ${poolsRes.status}`);
  }

  const pool = (await poolRes.json()) as { data: CurvePoolData };
  const poolsJson = (await poolsRes.json()) as {
    data: { poolData: CurvePoolsEntry[] };
  };

  const poolData = pool.data;
  const gaugeData = poolsJson.data.poolData.find(
    (p) => p.address.toLowerCase() === CURVE_POOL_ADDRESS
  );

  // Pool metrics
  const tvl = poolData.tvl_usd;
  const [balance0, balance1] = poolData.balances;
  const totalBalance = balance0 + balance1;
  const ratio0 = balance0 / totalBalance;
  const ratio1 = balance1 / totalBalance;
  const virtualPrice = poolData.virtual_price / 1e18;
  const volume24h = poolData.trading_volume_24h;
  const fees24h = poolData.trading_fee_24h;
  const feeAprDaily = poolData.base_daily_apr;
  const feeAprWeekly = poolData.base_weekly_apr;

  // Gauge metrics
  const crvApy = gaugeData ? gaugeData.gaugeCrvApy : [0, 0];
  const extraRewards = gaugeData?.gaugeRewards ?? [];
  const totalExtraApy = extraRewards.reduce((sum, r) => sum + r.apy, 0);
  const totalApy = feeAprDaily + crvApy[1] + totalExtraApy;

  const coin0 = poolData.coins[0]?.symbol ?? "Token0";
  const coin1 = poolData.coins[1]?.symbol ?? "Token1";

  const timestamp =
    new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  let rewardsSection = "";
  if (extraRewards.length > 0) {
    const rewardLines = extraRewards
      .map((r) => `  ${r.symbol}: ${formatPctRaw(r.apy)}`)
      .join("\n");
    rewardsSection = `\n*Gauge Rewards:*\n${rewardLines}`;
  }

  const message = `*Curve Pool Monitor*

*${poolData.name}*

*TVL:* $${formatNumber(tvl)}

*Pool Balances:*
  ${coin0}: ${formatNumber(balance0)} (${formatPctRaw(ratio0 * 100)})
  ${coin1}: ${formatNumber(balance1)} (${formatPctRaw(ratio1 * 100)})

*Virtual Price:* ${virtualPrice.toFixed(6)}

*24h Activity:*
  Volume: $${formatNumber(volume24h)}
  Fees: $${formatNumber(fees24h)}

*Fee APR:*
  Daily: ${formatPctRaw(feeAprDaily)}
  Weekly: ${formatPctRaw(feeAprWeekly)}

*CRV APY:* ${crvApy[1] > 0 ? `${formatPctRaw(crvApy[0])} - ${formatPctRaw(crvApy[1])}` : "None"}
${rewardsSection}
*Total APY:* ${formatPctRaw(totalApy)}

_${timestamp}_`;

  await sendTelegramMessage(botToken, chatId, message, topicId);
  console.log(`[Curve] Update sent: TVL $${formatNumber(tvl)}`);
}

// --- Main ---

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const morphoTopicId = process.env.TELEGRAM_TOPIC_ID_MORPHO
    ? Number(process.env.TELEGRAM_TOPIC_ID_MORPHO)
    : undefined;
  const curveTopicId = process.env.TELEGRAM_TOPIC_ID_CURVE
    ? Number(process.env.TELEGRAM_TOPIC_ID_CURVE)
    : undefined;

  if (!botToken || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
  }

  const results = await Promise.allSettled([
    fetchAndSendMorphoUpdate(botToken, chatId, morphoTopicId),
    fetchAndSendCurveUpdate(botToken, chatId, curveTopicId),
  ]);

  const errors: Error[] = [];
  for (const result of results) {
    if (result.status === "rejected") {
      console.error(result.reason);
      errors.push(result.reason as Error);
    }
  }

  if (errors.length === results.length) {
    throw new Error("All updates failed");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
