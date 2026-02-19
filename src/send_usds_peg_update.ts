/**
 * Single-shot script to fetch USDS prices from 4 DEX pools and send a Telegram peg monitor update.
 */

// --- Constants ---

const USDS_ADDRESS = "0xdc035d45d973e3ec169d2276ddab16f1e407384f";

const POOLS = [
  {
    name: "Curve PYUSD/USDS",
    address: "0xa632d59b9b804a956bfaa9b48af3a1b74808fc1f",
    isCurve: true,
  },
  {
    name: "Uni V4 USDC/USDS (0.01%)",
    address:
      "0xcecc13faad121d6e3ab33e137a746b512ab8ff1ace47da534aedb53e0b9fe9f8",
    isCurve: false,
  },
  {
    name: "Uni V4 USDT/USDS (0.01%)",
    address:
      "0xb54ece65cc2ddd3eaec0ad18657470fb043097220273d87368a062c7d4e59180",
    isCurve: false,
  },
  {
    name: "Uni V3 DAI/USDS (0.3%)",
    address: "0xe9f1e2ef814f5686c30ce6fb7103d0f780836c67",
    isCurve: false,
  },
] as const;

const CURVE_POOL_ADDRESS = POOLS[0].address;
const CURVE_POOL_API_URL = `https://prices.curve.finance/v1/pools/ethereum/${CURVE_POOL_ADDRESS}`;

const GECKO_BASE_URL = "https://api.geckoterminal.com/api/v2";

// --- Types ---

interface GeckoPoolAttributes {
  name: string;
  address: string;
  base_token_price_usd: string;
  quote_token_price_usd: string;
  reserve_in_usd: string;
  volume_usd: { h24: string };
}

interface GeckoPoolRelationships {
  base_token: { data: { id: string } };
  quote_token: { data: { id: string } };
}

interface GeckoPool {
  id: string;
  attributes: GeckoPoolAttributes;
  relationships: GeckoPoolRelationships;
}

interface GeckoResponse {
  data: GeckoPool[];
}

interface CurvePoolData {
  name: string;
  tvl_usd: number;
  balances: number[];
  coins: { symbol: string; decimals: number }[];
  virtual_price: number;
}

interface PoolPegData {
  name: string;
  usdsPrice: number;
  tvl: number;
  volume24h: number;
  deviationBps: number;
  curveBalances?: { symbol: string; pct: number }[];
}

// --- Helpers ---

function formatNumber(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatPrice(value: number): string {
  return `$${value.toFixed(4)}`;
}

function formatBps(bps: number): string {
  const sign = bps >= 0 ? "+" : "";
  return `${sign}${bps.toFixed(1)} bps`;
}

// --- Telegram ---

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

// --- Fetch functions ---

async function fetchGeckoPoolData(): Promise<Map<string, GeckoPool>> {
  const addresses = POOLS.map((p) => p.address).join(",");
  const url = `${GECKO_BASE_URL}/networks/eth/pools/multi/${addresses}`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GeckoTerminal API error: ${res.status}`);
  }

  const json = (await res.json()) as GeckoResponse;
  const map = new Map<string, GeckoPool>();

  for (const pool of json.data) {
    // GeckoTerminal pool IDs are formatted as "eth_{address}"
    const addr = pool.id.replace(/^eth_/, "").toLowerCase();
    map.set(addr, pool);
  }

  return map;
}

async function fetchCurvePoolData(): Promise<CurvePoolData> {
  const res = await fetch(CURVE_POOL_API_URL);
  if (!res.ok) {
    throw new Error(`Curve API error: ${res.status}`);
  }
  return (await res.json()) as CurvePoolData;
}

// --- Processing ---

function extractUsdsPrice(pool: GeckoPool): number {
  const baseTokenId = pool.relationships.base_token.data.id.toLowerCase();
  // GeckoTerminal token IDs are "eth_{address}"
  const isBaseUsds = baseTokenId.includes(USDS_ADDRESS);

  if (isBaseUsds) {
    return parseFloat(pool.attributes.base_token_price_usd);
  }
  return parseFloat(pool.attributes.quote_token_price_usd);
}

function buildPoolPegData(
  geckoMap: Map<string, GeckoPool>,
  curveData: CurvePoolData | null
): PoolPegData[] {
  const results: PoolPegData[] = [];

  for (const poolConfig of POOLS) {
    const addr = poolConfig.address.toLowerCase();
    const geckoPool = geckoMap.get(addr);

    if (!geckoPool) {
      console.warn(`[warn] Pool ${poolConfig.name} not found in GeckoTerminal response, skipping`);
      continue;
    }

    const usdsPrice = extractUsdsPrice(geckoPool);
    const tvl = parseFloat(geckoPool.attributes.reserve_in_usd);
    const volume24h = parseFloat(geckoPool.attributes.volume_usd.h24);
    const deviationBps = (usdsPrice - 1) * 10000;

    const data: PoolPegData = {
      name: poolConfig.name,
      usdsPrice,
      tvl,
      volume24h,
      deviationBps,
    };

    // Add Curve balance breakdown if available
    if (poolConfig.isCurve && curveData) {
      const totalBalance = curveData.balances.reduce((a, b) => a + b, 0);
      if (totalBalance > 0) {
        data.curveBalances = curveData.coins.map((coin, i) => ({
          symbol: coin.symbol,
          pct: (curveData.balances[i] / totalBalance) * 100,
        }));
      }
    }

    results.push(data);
  }

  return results;
}

// --- Formatting ---

function formatMessage(pools: PoolPegData[]): string {
  const timestamp =
    new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";

  let msg = "*USDS Peg Monitor*\n";

  for (const pool of pools) {
    msg += `\n*${pool.name}*\n`;
    msg += `  USDS: ${formatPrice(pool.usdsPrice)} (${formatBps(pool.deviationBps)})\n`;
    msg += `  TVL: $${formatNumber(pool.tvl)}\n`;
    msg += `  24h Vol: $${formatNumber(pool.volume24h)}`;

    if (pool.curveBalances) {
      const balanceStr = pool.curveBalances
        .map((b) => `${b.pct.toFixed(1)}% ${b.symbol}`)
        .join(" / ");
      msg += `\n  Pool: ${balanceStr}`;
    }

    msg += "\n";
  }

  // Aggregate VWAP
  const totalVolume = pools.reduce((sum, p) => sum + p.volume24h, 0);
  const vwap =
    totalVolume > 0
      ? pools.reduce((sum, p) => sum + p.usdsPrice * p.volume24h, 0) /
        totalVolume
      : pools.reduce((sum, p) => sum + p.usdsPrice, 0) / pools.length;
  const vwapBps = (vwap - 1) * 10000;
  const totalTvl = pools.reduce((sum, p) => sum + p.tvl, 0);

  msg += `\n*Aggregate*\n`;
  msg += `  VWAP: ${formatPrice(vwap)} (${formatBps(vwapBps)})\n`;
  msg += `  Total TVL: $${formatNumber(totalTvl)}\n`;

  msg += `\n_${timestamp}_`;

  return msg;
}

// --- Main ---

async function main() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  const topicId = process.env.TELEGRAM_TOPIC_ID_USDS_PEG
    ? Number(process.env.TELEGRAM_TOPIC_ID_USDS_PEG)
    : undefined;

  if (!botToken || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set");
  }

  const [geckoResult, curveResult] = await Promise.allSettled([
    fetchGeckoPoolData(),
    fetchCurvePoolData(),
  ]);

  // GeckoTerminal is required
  if (geckoResult.status === "rejected") {
    throw new Error(
      `GeckoTerminal fetch failed: ${geckoResult.reason}`
    );
  }

  // Curve is optional
  let curveData: CurvePoolData | null = null;
  if (curveResult.status === "fulfilled") {
    curveData = curveResult.value;
  } else {
    console.warn(
      `[warn] Curve API failed, proceeding without pool balances: ${curveResult.reason}`
    );
  }

  const pools = buildPoolPegData(geckoResult.value, curveData);

  if (pools.length === 0) {
    throw new Error("No pools available from GeckoTerminal");
  }

  const message = formatMessage(pools);
  await sendTelegramMessage(botToken, chatId, message, topicId);
  console.log("[USDS Peg] Update sent");
}

// --- Entry ---

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
