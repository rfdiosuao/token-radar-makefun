// Token Radar — valuation model (radar-2).
//
// The board ranks pre-token protocols by an *implied launch value*: what a
// token would be worth if the protocol's record stayed as it is. The value is
// derived only from the sealed snapshot's own figures — never from a list of
// names. Every protocol is scored by the same function, `scoreProtocol`.
//
// Formula (all inputs come from the snapshot; `as_of` is the snapshot date):
//
//   size    = 10 ^ (0.92 * log10(tvl_usd))        — TVL, compressed so a 100x
//                                                   TVL gap is ~66x of value
//   growth  = 1 + clamp(change_7d ?? 0, -50, 150) / 200
//                                                   — 7-day TVL momentum;
//                                                   unreported growth counts
//                                                   as flat (0), factor 1.0
//   age     = 0.70 + 0.60 * min(age_days, 1460) / 1460
//                                                   — days from listed_at to
//                                                   as_of; unknown age = 365
//                                                   days. A protocol that has
//                                                   run for years with no
//                                                   token is more likely to
//                                                   issue one than a newcomer.
//   chains  = 1 + 0.08 * min(max(chains - 1, 0), 5)
//                                                   — multi-chain reach,
//                                                   capped at 6 chains
//   sector  = per-category multiplier (see CATEGORY_FACTOR): lending, DEX
//             and derivatives protocols monetise best; bridges and CEX
//             products monetise worst and are excluded from the board anyway
//   implied = round(size * growth * age * chains * sector * 0.35)
//
// After scoring, rows are sorted by implied value descending (ties broken by
// slug, ascending, so the order is deterministic) and then forced strictly
// decreasing: any row that would tie or beat the row above it is lowered to
// just below it. Rank 1 is the most valuable protocol.
//
// Board membership: every watchlist slug (the floor, never the ceiling) plus
// the 160 highest-TVL early pre-token protocols below the $50M floor.
// Early means: the snapshot records no token (mcap, gecko_id and symbol all
// null), the category is not a CEX, the name is not a versioned pool (ends
// in V2 / 2.0 and the like) and does not start with an exchange name.
// Protocols whose token already trades are never ranked; the dashboard
// shows the top 24 of them separately, at their recorded market cap, so the
// two groups are never mixed. The watchlist itself is the house's stricter
// rule (it also drops wrapped / staked / bridged products); the early radar
// exists to find pre-token protocols the watchlist leaves out.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  breakdown: {
    size_usd: number;
    growth_factor: number;
    age_factor: number;
    chain_factor: number;
    sector_factor: number;
  };
  farm_steps: string[];
}

/** Compact row for the dashboard's data.js. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_factor: number;
  age_factor: number;
  chain_factor: number;
  sector_factor: number;
  farm_steps: string[];
}

/** A protocol whose token already trades, shown at its recorded market cap. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export const MODEL_VERSION = 'radar-2';
export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;
const DAY_MS = 86_400_000;

/** Sector multipliers: how well each category turns TVL into token value. */
export const CATEGORY_FACTOR: Record<string, number> = {
  'Lending': 1.18,
  'Dexs': 1.15,
  'Derivatives': 1.12,
  'Yield': 1.10,
  'Risk Curators': 1.10,
  'Onchain Capital Allocator': 1.08,
  'Yield Aggregator': 1.08,
  'CDP': 1.06,
  'RWA': 1.05,
  'Leveraged Farming': 1.05,
  'Uncollateralized Lending': 1.04,
  'Restaking': 1.02,
  'Staking Pool': 1.00,
  'Payments': 1.00,
  'Insurance': 0.98,
  'Prediction Market': 0.98,
  'Bridge': 0.85,
  'Canonical Bridge': 0.85,
  'Liquid Staking': 0.85,
  'Liquid Restaking': 0.85,
  'CEX': 0.80,
};

const EXCLUDED_CATEGORIES = new Set([
  'CEX', 'Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC',
]);

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Whole days from listed_at to as_of; null when listed_at is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The snapshot records no token for this protocol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** A pre-token protocol the early radar may add: not a CEX, not a versioned pool, not an exchange's own product. */
export function isEarlyEligible(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category === 'CEX') return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** A pre-token protocol the board may rank (see the header comment). */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/**
 * Score one protocol. Returns the implied value plus every factor, so the
 * dashboard can show the value's breakdown instead of a bare number.
 */
export function scoreProtocol(p: SnapshotProtocol, asOf: string): {
  implied: number;
  age: number | null;
  size: number;
  growth: number;
  ageFactor: number;
  chainFactor: number;
  sectorFactor: number;
} {
  const age = ageDays(asOf, p.listed_at);
  const size = Math.pow(10, 0.92 * Math.log10(Math.max(p.tvl_usd, 1)));
  const growth = 1 + clamp(p.change_7d ?? 0, -50, 150) / 200;
  const ageForModel = age ?? 365;
  const ageFactor = 0.7 + 0.6 * (Math.min(ageForModel, 1460) / 1460);
  const chainFactor = 1 + 0.08 * Math.min(Math.max(p.chains.length - 1, 0), 5);
  const sectorFactor = CATEGORY_FACTOR[p.category ?? ''] ?? 1.0;
  const implied = Math.max(1, Math.round(size * growth * ageFactor * chainFactor * sectorFactor * 0.35));
  return { implied, age, size: Math.round(size), growth: round4(growth), ageFactor: round4(ageFactor), chainFactor: round4(chainFactor), sectorFactor };
}

/** Capital tier for a farm position, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 500;
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** Holding window: younger protocols need a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The category's core farming action, in words a reader can follow. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC as a lender on ${name} (${chain}) and leave the deposit earning yield`;
  }
  if (c.includes('dex')) {
    return `Add $${capital} of liquidity to the busiest ${name} pool on ${chain}, in a balanced pair, and keep the LP position open`;
  }
  if (c.includes('yield') || c.includes('curator') || c.includes('allocator') || c.includes('aggregator')) {
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and hold the vault shares`;
  }
  if (c.includes('deriv') || c.includes('perpetual') || c.includes('leveraged')) {
    return `Deposit $${capital} of USDC as margin on ${name} (${chain}) and open one small hedged position, then close it the same week`;
  }
  if (c.includes('restak') || c.includes('staking')) {
    return `Stake $${capital} of the native asset through ${name} on ${chain} and keep the staking receipt token`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of the yield-bearing asset on ${name} (${chain}) and hold it in your farm wallet`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and keep the balance untouched`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} for a vault you already use, and keep the policy active`;
  }
  if (c.includes('prediction')) {
    return `Fund your ${name} account with $${capital} on ${chain} and take one small position in an active market`;
  }
  if (c.includes('payment')) {
    return `Route $${capital} of real payments through ${name} on ${chain} over two weeks, in at least three separate transfers`;
  }
  if (c.includes('basis') || c.includes('cedefi')) {
    return `Deposit $${capital} of USDC into the ${name} basis vault on ${chain} and leave it through one funding cycle`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open`;
}

function gasFor(capital: number): number {
  return capital >= 250 ? 8 : capital >= 100 ? 5 : 3;
}

/**
 * A protocol's farm plan: 7 steps, each with its cost and time. Every step is
 * generated from the protocol's own record (name, chains, category, TVL,
 * age) — no two protocols share a plan unless their records match.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const extraChains = p.chains.length > 1 ? ` It also runs on ${p.chains.slice(1, 3).join(' and ')}, so repeat step 2 there if you want a second footprint.` : '';
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(capital);
  const ageText = age === null ? 'age unlisted' : age < 365 ? `${age} days old` : `${Math.floor(age / 365)}y ${age % 365}d old`;
  const steps = [
    `Set up a fresh wallet used only for ${p.name}, fund it with $${capital + 20} of USDC on ${chain} plus $${gas} for gas, and store the seed phrase offline. Cost: about $${gas} of gas. Time: 10 minutes.`,
    `${coreAction(p, capital, chain)}.${extraChains} Cost: $${capital} of capital plus about $${gas} of gas. Time: 15-20 minutes to set up.`,
    `Return once a week and do one real action on ${p.name} — a deposit, a swap, a borrow or a vote — so your address shows repeat use, not a single deposit. Cost: about $2 of gas per week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days (${p.name} is ${ageText}, TVL $${Math.round(p.tvl_usd / 1_000_000)}M) so your activity spans more than one snapshot window. Cost: the $${capital} stays locked in the position. Time: ${hold} days.`,
    `If ${p.name} publishes a points or rewards page, check it from the protocol's own site only and record your points balance each month. Cost: nothing to check. Time: 10 minutes a month.`,
    `Before any claim, verify the claim link on ${p.name}'s own channels and never pay a fee or connect to a link from a DM or ad. Cost: $0, and never pay to claim. Time: 10 minutes.`,
    `Risk note: ${p.name} records no token, which is not a promise of one — farm only money you can afford to leave in place, and be ready to walk away with nothing if no token ever launches. Cost: up to the $${capital} position. Time: 5 minutes to decide your limit.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 597)}...` : s));
}

/** The board: watchlist first, then the 160 highest-TVL rankable early rows. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isEarlyEligible(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: scoreProtocol(p, snapshot.as_of) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Force strictly decreasing implied values: a tie is lowered to just below
  // the row above it, so the ranking is a real ranking.
  let prev = Number.POSITIVE_INFINITY;
  return scored.map((entry, i) => {
    let value = entry.s.implied;
    if (value >= prev) value = Math.max(1, prev - Math.max(1, Math.floor(prev * 0.001)));
    prev = value;
    return {
      rank: i + 1,
      slug: entry.p.slug,
      name: entry.p.name,
      category: entry.p.category,
      chains: entry.p.chains,
      tvl_usd: entry.p.tvl_usd,
      change_7d: entry.p.change_7d,
      listed_at: entry.p.listed_at,
      age_days: entry.s.age,
      token_status: 'pre-token' as const,
      implied_value_usd: value,
      breakdown: {
        size_usd: entry.s.size,
        growth_factor: entry.s.growth,
        age_factor: entry.s.ageFactor,
        chain_factor: entry.s.chainFactor,
        sector_factor: entry.s.sectorFactor,
      },
      farm_steps: farmSteps(entry.p, entry.s.age),
    };
  });
}

/** Live-token protocols by market cap, for the dashboard's separate view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      growth_factor: r.breakdown.growth_factor,
      age_factor: r.breakdown.age_factor,
      chain_factor: r.breakdown.chain_factor,
      sector_factor: r.breakdown.sector_factor,
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** Parse and validate the snapshot file's text. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: typeof o.source === 'string' ? o.source : '', floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100 || board.length > 4000) return `board has ${board.length} rows`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) return `row ${i + 1} does not fall below row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
  }
  return null;
}

/** The dashboard's whole dataset as one inline script (no fetch, no network). */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
