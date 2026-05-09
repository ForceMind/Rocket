const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const HTTPS_KEY_PATH = process.env.HTTPS_KEY_PATH || process.env.SSL_KEY_PATH || process.env.TLS_KEY_PATH || "";
const HTTPS_CERT_PATH = process.env.HTTPS_CERT_PATH || process.env.SSL_CERT_PATH || process.env.TLS_CERT_PATH || "";
const HTTPS_CA_PATH = process.env.HTTPS_CA_PATH || process.env.SSL_CA_PATH || process.env.TLS_CA_PATH || "";
const ADMIN_PATH = normalizeAdminPath(process.env.ADMIN_PATH || "/manage");
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");
const CURVE_TARGET_MULTIPLIER = 20;

function normalizeAdminPath(value) {
  const raw = String(value || "/manage").trim();
  if (!raw || raw === "/") return "/manage";
  const withoutQuery = raw.split(/[?#]/)[0];
  const pathValue = withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  return pathValue.replace(/\/+$/, "") || "/manage";
}

const DEFAULT_SETTINGS = {
  bettingDurationMs: 7000,
  roundPauseMs: 3500,
  tickRateMs: 100,
  minBetCents: 100,
  maxBetCents: 100000,
  betTiersCents: [1000, 5000, 10000, 50000],
  demoCreditCents: 100000,
  prizePoolCents: 10000000,
  houseEdgeBps: 150,
  instantCrashBps: 150,
  maxCrashMultiplier: 100,
  curveEarlyTargetMs: 35000,
  curveEarlyPower: 2.4,
  curveLateSpeedMs: 12000,
  botsEnabled: true,
  botMinCount: 14,
  botMaxCount: 34,
  botBetIntervalMinMs: 100,
  botBetIntervalMaxMs: 230,
  botMinBetCents: 100,
  botMaxBetCents: 25000,
  botOnlyHighFlightBps: 800,
  botOnlyHighFlightMin: 100,
  botOnlyHighFlightMax: 500,
  paused: false
};

const BOT_NAMES = [
  "Astra", "Nova", "Orion", "Vega", "Luna", "Atlas", "Comet", "Cosmo",
  "Raptor", "Blaze", "Echo", "Pulse", "Zenith", "Orbit", "Meteor", "Ion",
  "Apollo", "Kepler", "Titan", "RocketX", "Stellar", "Ranger", "Drift", "Flux",
  "Vector", "Solar", "Nimbus", "Voyager", "Falcon", "Helix", "Astro", "Quasar"
];

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

let db = loadDb();
let currentRound = null;
let clients = new Set();

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function httpsOptionsFromEnv() {
  if (!HTTPS_KEY_PATH && !HTTPS_CERT_PATH) {
    return null;
  }
  if (!HTTPS_KEY_PATH || !HTTPS_CERT_PATH) {
    throw new Error("HTTPS requires both HTTPS_KEY_PATH and HTTPS_CERT_PATH");
  }
  if (!fs.existsSync(HTTPS_KEY_PATH)) {
    throw new Error(`HTTPS key file not found: ${HTTPS_KEY_PATH}`);
  }
  if (!fs.existsSync(HTTPS_CERT_PATH)) {
    throw new Error(`HTTPS certificate file not found: ${HTTPS_CERT_PATH}`);
  }

  const options = {
    key: fs.readFileSync(HTTPS_KEY_PATH),
    cert: fs.readFileSync(HTTPS_CERT_PATH)
  };
  if (HTTPS_CA_PATH) {
    if (!fs.existsSync(HTTPS_CA_PATH)) {
      throw new Error(`HTTPS CA file not found: ${HTTPS_CA_PATH}`);
    }
    options.ca = fs.readFileSync(HTTPS_CA_PATH);
  }
  return options;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeDb(input) {
  const safe = input && typeof input === "object" ? input : {};
  const metricOffsets = safe.metricOffsets && typeof safe.metricOffsets === "object" ? safe.metricOffsets : {};
  return {
    settings: { ...DEFAULT_SETTINGS, ...(safe.settings || {}) },
    players: safe.players && typeof safe.players === "object" ? safe.players : {},
    rounds: Array.isArray(safe.rounds) ? safe.rounds : [],
    metricOffsets: {
      totalBetCents: Number.isFinite(metricOffsets.totalBetCents) ? Math.trunc(metricOffsets.totalBetCents) : 0,
      totalPayoutCents: Number.isFinite(metricOffsets.totalPayoutCents) ? Math.trunc(metricOffsets.totalPayoutCents) : 0,
      houseProfitCents: Number.isFinite(metricOffsets.houseProfitCents) ? Math.trunc(metricOffsets.houseProfitCents) : 0
    },
    fair: {
      nonce: Number.isSafeInteger(safe.fair?.nonce) ? safe.fair.nonce : 1
    },
    audit: Array.isArray(safe.audit) ? safe.audit : []
  };
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    const initial = normalizeDb({});
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    return normalizeDb(parsed);
  } catch (error) {
    const backupPath = path.join(DATA_DIR, `db.corrupt.${Date.now()}.json`);
    fs.copyFileSync(DB_PATH, backupPath);
    const initial = normalizeDb({});
    fs.writeFileSync(DB_PATH, JSON.stringify(initial, null, 2));
    console.error(`Failed to read db.json. A backup was written to ${backupPath}`);
    console.error(error);
    return initial;
  }
}

function saveDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(db, null, 2));
  fs.renameSync(tmpPath, DB_PATH);
}

function audit(type, payload = {}) {
  db.audit.unshift({
    id: newId("audit"),
    type,
    payload,
    createdAt: nowIso()
  });
  db.audit = db.audit.slice(0, 300);
}

function centsToAmount(cents) {
  return Number((Number(cents || 0) / 100).toFixed(2));
}

function amountToCents(value) {
  if (typeof value === "string") {
    value = value.replace(/,/g, "").trim();
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return null;
  }
  return Math.round(number * 100);
}

function parseAmountList(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "")
      .split(/[,\s，]+/)
      .filter(Boolean);
  const cents = rawItems
    .map(amountToCents)
    .filter((item) => Number.isInteger(item) && item > 0);
  return [...new Set(cents)].sort((a, b) => a - b);
}

function publicPlayer(player) {
  if (!player) return null;
  return {
    id: player.id,
    username: player.username,
    balance: centsToAmount(player.balanceCents),
    createdAt: player.createdAt,
    tutorialCompleted: Boolean(player.tutorialCompletedAt),
    tutorialCompletedAt: player.tutorialCompletedAt || null
  };
}

function maskedName(name) {
  const source = Array.from(String(name || "Player").trim());
  const prefix = source.slice(0, 2).join("") || "P";
  return `${prefix}**`;
}

function privateAdminPlayer(player) {
  return {
    ...publicPlayer(player),
    balanceCents: player.balanceCents,
    updatedAt: player.updatedAt,
    lastSeenAt: player.lastSeenAt
  };
}

function sanitizeUsername(username) {
  return String(username || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 24);
}

function getOrCreatePlayer(username) {
  const cleanUsername = sanitizeUsername(username);
  if (cleanUsername.length < 2) {
    throw httpError(400, "Player name must be at least 2 characters");
  }

  const existing = Object.values(db.players).find(
    (player) => player.username.toLowerCase() === cleanUsername.toLowerCase()
  );
  if (existing) {
    existing.lastSeenAt = nowIso();
    saveDb();
    return existing;
  }

  const player = {
    id: newId("player"),
    username: cleanUsername,
    balanceCents: db.settings.demoCreditCents,
    tutorialCompletedAt: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    lastSeenAt: nowIso()
  };
  db.players[player.id] = player;
  audit("player.created", { playerId: player.id, username: player.username });
  saveDb();
  return player;
}

function getPlayer(playerId) {
  const player = db.players[String(playerId || "")];
  if (!player) {
    throw httpError(404, "Player not found. Please sign in again");
  }
  player.lastSeenAt = nowIso();
  return player;
}

function generateRoundSeed() {
  return crypto.randomBytes(32).toString("hex");
}

function crashPointFor(serverSeed, nonce, settings = db.settings) {
  const hmac = crypto.createHmac("sha256", serverSeed).update(String(nonce)).digest("hex");
  const sample = BigInt(`0x${hmac.slice(0, 13)}`);
  const denominator = 0x10000000000000n;
  let random = Number(sample) / Number(denominator);
  random = clamp(random, Number.EPSILON, 1 - Number.EPSILON);
  const instantCrashChance = clamp((settings.instantCrashBps || 0) / 10000, 0, 1);

  if (random < instantCrashChance) {
    return {
      multiplier: 1,
      hmac
    };
  }

  const adjustedRandom = instantCrashChance >= 1
    ? 0
    : (random - instantCrashChance) / (1 - instantCrashChance);

  const houseFactor = clamp(1 - settings.houseEdgeBps / 10000, 0.5, 1);
  const raw = houseFactor / (1 - adjustedRandom);
  const crash = Math.max(1.01, Math.floor(raw * 100) / 100);

  return {
    multiplier: Number(clamp(crash, 1.01, settings.maxCrashMultiplier).toFixed(2)),
    hmac
  };
}

function botBetAmountCents() {
  const min = Math.max(100, db.settings.botMinBetCents || db.settings.minBetCents);
  const max = Math.max(min, db.settings.botMaxBetCents || db.settings.maxBetCents);
  const tiers = db.settings.betTiersCents.filter((cents) => cents >= min && cents <= max);
  if (tiers.length > 0) {
    return randomChoice(tiers);
  }
  return randomChoice(db.settings.betTiersCents);
}

function botCashoutMultiplier() {
  const roll = Math.random();
  let value;
  if (roll < 0.58) {
    value = 1.15 + Math.random() * 1.35;
  } else if (roll < 0.88) {
    value = 2.5 + Math.random() * 3.5;
  } else {
    value = 6 + Math.random() * 14;
  }
  return Number(clamp(value, 1.01, db.settings.maxCrashMultiplier).toFixed(2));
}

function randomMultiplier(min, max) {
  const lower = Math.min(min, max);
  const upper = Math.max(min, max);
  return Number((randomInt(Math.round(lower * 100), Math.round(upper * 100)) / 100).toFixed(2));
}

function hasHumanBet(round) {
  return round.bets.some((bet) => !bet.isBot);
}

function humanOpenBetCents(round = currentRound) {
  if (!round) return 0;
  return round.bets.reduce((sum, bet) => {
    if (bet.isBot || bet.status !== "open") return sum;
    return sum + bet.amountCents;
  }, 0);
}

function prizePoolCapMultiplier(round = currentRound, prizePoolCents = db.settings.prizePoolCents) {
  const openBetCents = humanOpenBetCents(round);
  if (openBetCents <= 0) return db.settings.maxCrashMultiplier;
  const cap = Math.floor((prizePoolCents / openBetCents) * 100) / 100;
  return Number(clamp(cap, 1, db.settings.maxCrashMultiplier).toFixed(2));
}

function projectedPrizePoolCap(extraBetCents) {
  const projectedPool = db.settings.prizePoolCents + extraBetCents;
  const projectedOpenBets = humanOpenBetCents() + extraBetCents;
  if (projectedOpenBets <= 0) return db.settings.maxCrashMultiplier;
  return Math.floor((projectedPool / projectedOpenBets) * 100) / 100;
}

function applyPrizePoolCap(reason = "pool") {
  if (!currentRound || currentRound.phase !== "betting") return false;
  const cap = prizePoolCapMultiplier(currentRound);
  currentRound.poolCapMultiplier = cap;
  if (humanOpenBetCents(currentRound) <= 0 || currentRound.crashMultiplier <= cap) {
    return false;
  }
  currentRound.crashMultiplier = Number(cap.toFixed(2));
  currentRound.poolCapped = true;
  currentRound.poolCapReason = reason;
  return true;
}

function applyBotOnlyHighFlight() {
  if (!currentRound || currentRound.botOnlyHighFlightChecked) return false;
  currentRound.botOnlyHighFlightChecked = true;

  if (!db.settings.botsEnabled || currentRound.bets.length === 0 || hasHumanBet(currentRound)) {
    return false;
  }

  const chance = clamp((db.settings.botOnlyHighFlightBps || 0) / 10000, 0, 1);
  if (Math.random() >= chance) {
    return false;
  }

  const min = Number(db.settings.botOnlyHighFlightMin || 100);
  const max = Number(db.settings.botOnlyHighFlightMax || 500);
  currentRound.crashMultiplier = randomMultiplier(min, max);
  currentRound.botOnlyHighFlight = true;
  return true;
}

function curveConfig(settings = db.settings) {
  const earlyTargetMs = clamp(Number(settings.curveEarlyTargetMs ?? settings.earlyTargetMs ?? DEFAULT_SETTINGS.curveEarlyTargetMs), 10000, 120000);
  const earlyPower = clamp(Number(settings.curveEarlyPower ?? settings.earlyPower ?? DEFAULT_SETTINGS.curveEarlyPower), 1, 5);
  const lateSpeedMs = clamp(Number(settings.curveLateSpeedMs ?? settings.lateSpeedMs ?? DEFAULT_SETTINGS.curveLateSpeedMs), 3000, 60000);
  return {
    type: "piecewise-exp",
    targetMultiplier: CURVE_TARGET_MULTIPLIER,
    earlyTargetMs,
    earlyPower,
    lateSpeedMs
  };
}

function multiplierFromElapsed(elapsedMs, settings = db.settings) {
  const elapsed = Math.max(0, Number(elapsedMs || 0));
  const config = curveConfig(settings);
  let raw;
  if (elapsed <= config.earlyTargetMs) {
    const progress = elapsed / config.earlyTargetMs;
    raw = 1 + (config.targetMultiplier - 1) * Math.pow(progress, config.earlyPower);
  } else {
    raw = config.targetMultiplier * Math.exp((elapsed - config.earlyTargetMs) / config.lateSpeedMs);
  }
  return Number.isFinite(raw) ? raw : Number.MAX_SAFE_INTEGER;
}

function createBotPlan(createdAt) {
  if (!db.settings.botsEnabled) return [];
  const minCount = Math.max(0, Number(db.settings.botMinCount || 0));
  const maxCount = Math.max(minCount, Number(db.settings.botMaxCount || minCount));
  const count = randomInt(minCount, maxCount);
  const firstPlaceMs = 350;
  const latestPlaceMs = Math.max(firstPlaceMs, db.settings.bettingDurationMs - 1100);
  const intervalMinMs = clamp(Number(db.settings.botBetIntervalMinMs || 100), 50, 5000);
  const intervalMaxMs = Math.max(intervalMinMs, clamp(Number(db.settings.botBetIntervalMaxMs || 230), 50, 5000));
  const maxSchedulableCount = Math.floor((latestPlaceMs - firstPlaceMs) / intervalMinMs) + 1;
  const scheduledCount = Math.min(count, Math.max(0, maxSchedulableCount));
  const plan = [];
  let placeOffsetMs = firstPlaceMs;

  for (let index = 0; index < scheduledCount; index += 1) {
    const name = `${randomChoice(BOT_NAMES)}${randomInt(10, 99)}`;
    plan.push({
      id: newId("botplan"),
      name,
      placeAt: createdAt + placeOffsetMs,
      amountCents: botBetAmountCents(),
      autoCashout: botCashoutMultiplier(),
      placed: false,
      index
    });
    const remaining = scheduledCount - index - 1;
    const latestNextInterval = latestPlaceMs - placeOffsetMs - remaining * intervalMinMs;
    const maxNextInterval = Math.max(intervalMinMs, Math.min(intervalMaxMs, latestNextInterval));
    placeOffsetMs += randomInt(intervalMinMs, maxNextInterval);
  }

  return plan;
}

function placeDueBotBets(timestamp) {
  if (!currentRound || currentRound.phase !== "betting" || !currentRound.botPlan) return false;
  let changed = false;
  for (const bot of currentRound.botPlan) {
    if (bot.placed || timestamp < bot.placeAt) continue;
    bot.placed = true;
    currentRound.bets.push({
      id: newId("bet"),
      roundId: currentRound.id,
      playerId: `bot_${bot.id}`,
      username: bot.name,
      isBot: true,
      amountCents: bot.amountCents,
      autoCashout: bot.autoCashout,
      status: "open",
      cashoutMode: null,
      cashoutMultiplier: null,
      payoutCents: 0,
      placedAt: nowIso(),
      settledAt: null
    });
    broadcastEvent("bet_placed", {
      roundId: currentRound.id,
      round: publicRound(),
      bet: publicBet(currentRound.bets[currentRound.bets.length - 1])
    });
    changed = true;
  }
  return changed;
}

function multiplierAt(timestamp = Date.now()) {
  if (!currentRound || currentRound.phase !== "flying" || !currentRound.launchAt) {
    return 1;
  }
  const elapsed = Math.max(0, timestamp - currentRound.launchAt);
  const raw = multiplierFromElapsed(elapsed, currentRound.curve || db.settings);
  const cap = Math.max(db.settings.maxCrashMultiplier, currentRound.crashMultiplier || 1);
  const capped = clamp(raw, 1, cap);
  return Math.floor(capped * 100) / 100;
}

function createRound() {
  if (db.settings.paused || currentRound) {
    return;
  }

  const serverSeed = generateRoundSeed();
  const nonce = db.fair.nonce++;
  const crash = crashPointFor(serverSeed, nonce);
  const createdAt = Date.now();

  currentRound = {
    id: newId("round"),
    nonce,
    phase: "betting",
    seedHash: sha256(serverSeed),
    serverSeed,
    hmac: crash.hmac,
    crashMultiplier: crash.multiplier,
    currentMultiplier: 1,
    createdAt,
    bettingEndsAt: createdAt + db.settings.bettingDurationMs,
    launchAt: null,
    crashedAt: null,
    nextRoundAt: null,
    forced: false,
    botOnlyHighFlight: false,
    botOnlyHighFlightChecked: false,
    poolCapped: false,
    poolCapMultiplier: db.settings.maxCrashMultiplier,
    poolCapReason: null,
    bets: [],
    botPlan: createBotPlan(createdAt)
  };
  saveDb();
  broadcastEvent("round_start", { round: publicRound(), settings: publicSettings() });
}

function startFlying() {
  if (!currentRound || currentRound.phase !== "betting") return;
  applyBotOnlyHighFlight();
  currentRound.phase = "flying";
  currentRound.launchAt = Date.now();
  currentRound.currentMultiplier = 1;
  currentRound.curve = curveConfig();
  broadcastEvent("flight_start", {
    round: publicRound(),
    curve: currentRound.curve
  });
}

function settleOpenBetsAsLost() {
  for (const bet of currentRound.bets) {
    if (bet.status !== "open") continue;
    bet.status = "lost";
    bet.settledAt = nowIso();
    bet.cashoutMultiplier = null;
    bet.payoutCents = 0;
  }
}

function finishRound() {
  if (!currentRound || currentRound.phase === "crashed") return;
  settleOpenBetsAsLost();
  const crashedAt = Date.now();
  currentRound.phase = "crashed";
  currentRound.currentMultiplier = currentRound.crashMultiplier;
  currentRound.crashedAt = crashedAt;
  currentRound.nextRoundAt = crashedAt + db.settings.roundPauseMs;

  const humanBets = currentRound.bets.filter((bet) => !bet.isBot);
  const botBets = currentRound.bets.filter((bet) => bet.isBot);
  const totalBetCents = humanBets.reduce((sum, bet) => sum + bet.amountCents, 0);
  const totalPayoutCents = humanBets.reduce((sum, bet) => sum + (bet.payoutCents || 0), 0);

  db.rounds.unshift({
    id: currentRound.id,
    nonce: currentRound.nonce,
    seedHash: currentRound.seedHash,
    serverSeed: currentRound.serverSeed,
    hmac: currentRound.hmac,
    crashMultiplier: currentRound.crashMultiplier,
    forced: currentRound.forced,
    botOnlyHighFlight: currentRound.botOnlyHighFlight,
    poolCapped: currentRound.poolCapped,
    poolCapMultiplier: currentRound.poolCapMultiplier,
    startedAt: new Date(currentRound.createdAt).toISOString(),
    crashedAt: new Date(crashedAt).toISOString(),
    totalBet: centsToAmount(totalBetCents),
    totalPayout: centsToAmount(totalPayoutCents),
    houseProfit: centsToAmount(totalBetCents - totalPayoutCents),
    playerCount: currentRound.bets.length,
    humanCount: humanBets.length,
    botCount: botBets.length,
    bets: humanBets.map(publicBet)
  });
  db.rounds = db.rounds.slice(0, 200);
  audit("round.finished", {
    roundId: currentRound.id,
    crashMultiplier: currentRound.crashMultiplier,
    totalBetCents,
    totalPayoutCents,
    forced: currentRound.forced
  });
  saveDb();
  broadcastEvent("crash", {
    round: publicRound(),
    history: db.rounds.slice(0, 24),
    settings: publicSettings()
  });
  for (const client of clients) {
    if (client.playerId) {
      wsSend(client, "my_history", { myHistory: playerHistory(client.playerId) });
    }
  }
}

function processAutoCashouts(currentMultiplier) {
  if (!currentRound || currentRound.phase !== "flying") return false;
  let changed = false;
  for (const bet of currentRound.bets) {
    if (bet.status !== "open" || !bet.autoCashout) continue;
    if (bet.autoCashout < currentRound.crashMultiplier && currentMultiplier >= bet.autoCashout) {
      const settled = cashoutBet(bet, bet.autoCashout, "auto");
      if (settled) {
        emitCashout(settled);
        changed = true;
      }
    }
  }
  return changed;
}

function cashoutBet(bet, multiplier, mode) {
  const player = db.players[bet.playerId];
  if ((!player && !bet.isBot) || bet.status !== "open") return null;

  const safeMultiplier = Number(clamp(multiplier, 1, db.settings.maxCrashMultiplier).toFixed(2));
  const payoutCents = Math.floor((bet.amountCents * Math.round(safeMultiplier * 100)) / 100);

  if (player && payoutCents > db.settings.prizePoolCents) {
    return null;
  }

  bet.status = "cashed";
  bet.cashoutMode = mode;
  bet.cashoutMultiplier = safeMultiplier;
  bet.payoutCents = payoutCents;
  bet.settledAt = nowIso();

  if (player) {
    db.settings.prizePoolCents -= payoutCents;
    player.balanceCents += payoutCents;
    player.updatedAt = nowIso();
  }
  return bet;
}

function emitCashout(bet) {
  const player = db.players[bet.playerId];
  broadcastEvent("cashout", {
    roundId: bet.roundId,
    round: publicRound(),
    bet: publicBet(bet)
  });
  if (player) {
    sendPlayerEvent(player.id, "player_update", { player: publicPlayer(player) });
  }
}

function tick() {
  const timestamp = Date.now();

  if (!currentRound) {
    createRound();
    return;
  }

  if (currentRound.phase === "betting" && timestamp >= currentRound.bettingEndsAt) {
    startFlying();
  } else if (currentRound.phase === "betting") {
    const changed = placeDueBotBets(timestamp);
    if (changed) {
      saveDb();
    }
  }

  if (currentRound.phase === "flying") {
    const currentMultiplier = multiplierAt(timestamp);
    currentRound.currentMultiplier = currentMultiplier;
    if (currentMultiplier >= currentRound.crashMultiplier) {
      finishRound();
    } else {
      const changed = processAutoCashouts(currentMultiplier);
      if (changed) {
        saveDb();
      }
    }
  }

  if (currentRound.phase === "crashed" && timestamp >= currentRound.nextRoundAt) {
    currentRound = null;
    createRound();
  }
}

function publicBet(bet) {
  return {
    id: bet.id,
    playerId: bet.playerId,
    username: bet.username,
    displayName: maskedName(bet.username, bet.playerId || bet.id),
    isBot: Boolean(bet.isBot),
    amount: centsToAmount(bet.amountCents),
    autoCashout: bet.autoCashout,
    status: bet.status,
    cashoutMode: bet.cashoutMode || null,
    cashoutMultiplier: bet.cashoutMultiplier,
    payout: centsToAmount(bet.payoutCents || 0),
    placedAt: bet.placedAt,
    settledAt: bet.settledAt || null
  };
}

function publicRound(round = currentRound) {
  if (!round) return null;
  const base = {
    id: round.id,
    nonce: round.nonce,
    phase: round.phase,
    seedHash: round.seedHash,
    currentMultiplier: Number((round.currentMultiplier || 1).toFixed(2)),
    bettingEndsAt: round.bettingEndsAt,
    launchAt: round.launchAt,
    crashedAt: round.crashedAt,
    nextRoundAt: round.nextRoundAt,
    forced: round.forced,
    botOnlyHighFlight: round.botOnlyHighFlight,
    poolCapped: Boolean(round.poolCapped),
    poolCapMultiplier: round.poolCapMultiplier,
    curve: round.curve || curveConfig(),
    bets: round.bets.map(publicBet)
  };
  if (round.phase === "crashed") {
    base.crashMultiplier = round.crashMultiplier;
    base.serverSeed = round.serverSeed;
    base.hmac = round.hmac;
  }
  return base;
}

function adminRound(round = currentRound) {
  if (!round) return null;
  return {
    ...publicRound(round),
    crashMultiplier: round.crashMultiplier,
    hmac: round.hmac
  };
}

function publicSnapshot(playerId) {
  return {
    now: Date.now(),
    settings: publicSettings(),
    player: playerId && db.players[playerId] ? publicPlayer(db.players[playerId]) : null,
    round: publicRound(),
    history: db.rounds.slice(0, 24),
    myHistory: playerId ? playerHistory(playerId) : []
  };
}

function playerHistory(playerId) {
  const items = [];
  if (currentRound?.bets) {
    const liveBet = currentRound.bets.find((bet) => bet.playerId === playerId);
    if (liveBet) {
      items.push({
        roundId: currentRound.id,
        crashedAt: currentRound.crashedAt ? new Date(currentRound.crashedAt).toISOString() : null,
        crashMultiplier: currentRound.phase === "crashed" ? currentRound.crashMultiplier : null,
        bet: publicBet(liveBet)
      });
    }
  }
  for (const round of db.rounds) {
    const bet = Array.isArray(round.bets) ? round.bets.find((item) => item.playerId === playerId) : null;
    if (!bet) continue;
    items.push({
      roundId: round.id,
      crashedAt: round.crashedAt,
      crashMultiplier: round.crashMultiplier,
      bet
    });
    if (items.length >= 30) break;
  }
  return items;
}

function roundMoneyTotals(round) {
  const empty = {
    totalBet: 0,
    totalPayout: 0,
    houseProfit: 0,
    botCount: 0,
    humanCount: 0,
    humanBet: 0,
    humanPayout: 0
  };
  if (!round?.bets) return empty;
  return round.bets.reduce((acc, bet) => {
    if (bet.isBot) {
      acc.botCount += 1;
    } else {
      const payout = bet.payoutCents || 0;
      acc.humanCount += 1;
      acc.humanBet += bet.amountCents || 0;
      acc.humanPayout += payout;
      acc.totalBet += bet.amountCents || 0;
      acc.totalPayout += payout;
    }
    acc.houseProfit = acc.totalBet - acc.totalPayout;
    return acc;
  }, empty);
}

function persistedRoundMoneyTotals(round) {
  if (Array.isArray(round?.bets) && round.bets.length > 0) {
    const totals = round.bets.reduce(
      (acc, bet) => {
        if (bet.isBot) {
          acc.botCount += 1;
          return acc;
        }
        acc.humanCount += 1;
        acc.totalBet += amountToCents(bet.amount) || 0;
        acc.totalPayout += amountToCents(bet.payout) || 0;
        acc.houseProfit = acc.totalBet - acc.totalPayout;
        return acc;
      },
      { totalBet: 0, totalPayout: 0, houseProfit: 0, humanCount: 0, botCount: 0 }
    );
    if (totals.botCount === 0 && Number(round.botCount || 0) > 0) {
      totals.botCount = Number(round.botCount || 0);
    }
    return totals;
  }
  return {
    totalBet: amountToCents(round.totalBet) || 0,
    totalPayout: amountToCents(round.totalPayout) || 0,
    houseProfit: amountToCents(round.houseProfit) || 0,
    humanCount: Number(round.humanCount || 0),
    botCount: Number(round.botCount || 0)
  };
}

function adminHistoryRound(round) {
  const totals = persistedRoundMoneyTotals(round);
  return {
    ...round,
    totalBet: centsToAmount(totals.totalBet),
    totalPayout: centsToAmount(totals.totalPayout),
    houseProfit: centsToAmount(totals.houseProfit),
    humanCount: totals.humanCount,
    botCount: totals.botCount
  };
}

function adminSnapshot() {
  const totals = db.rounds.reduce(
    (acc, round) => {
      const roundTotals = persistedRoundMoneyTotals(round);
      acc.totalBet += roundTotals.totalBet;
      acc.totalPayout += roundTotals.totalPayout;
      acc.houseProfit += roundTotals.houseProfit;
      return acc;
    },
    { totalBet: 0, totalPayout: 0, houseProfit: 0 }
  );
  const liveTotals = roundMoneyTotals(currentRound);
  const metricOffsets = db.metricOffsets || {};
  const combinedTotals = {
    totalBet: totals.totalBet + liveTotals.totalBet + (metricOffsets.totalBetCents || 0),
    totalPayout: totals.totalPayout + liveTotals.totalPayout + (metricOffsets.totalPayoutCents || 0),
    houseProfit: totals.houseProfit + liveTotals.houseProfit + (metricOffsets.houseProfitCents || 0)
  };
  const playerList = Object.values(db.players).sort((a, b) => b.balanceCents - a.balanceCents);
  const onlinePlayerIds = new Set([...clients].map((client) => client.playerId).filter(Boolean));

  return {
    now: Date.now(),
    settings: {
      ...db.settings,
      minBet: centsToAmount(db.settings.minBetCents),
      maxBet: centsToAmount(db.settings.maxBetCents),
      betTiers: db.settings.betTiersCents.map(centsToAmount).join(", "),
      demoCredit: centsToAmount(db.settings.demoCreditCents),
      prizePool: centsToAmount(db.settings.prizePoolCents),
      botMinBet: centsToAmount(db.settings.botMinBetCents),
      botMaxBet: centsToAmount(db.settings.botMaxBetCents)
    },
    metrics: {
      players: playerList.length,
      onlinePlayers: onlinePlayerIds.size,
      rounds: db.rounds.length,
      totalBet: centsToAmount(combinedTotals.totalBet),
      totalPayout: centsToAmount(combinedTotals.totalPayout),
      houseProfit: centsToAmount(combinedTotals.houseProfit),
      currentBet: centsToAmount(liveTotals.totalBet),
      currentPayout: centsToAmount(liveTotals.totalPayout),
      currentHouseProfit: centsToAmount(liveTotals.houseProfit),
      currentBotCount: liveTotals.botCount,
      currentHumanCount: liveTotals.humanCount,
      currentHumanBet: centsToAmount(liveTotals.humanBet),
      prizePool: centsToAmount(db.settings.prizePoolCents),
      poolCapMultiplier: prizePoolCapMultiplier(currentRound),
      playerLiability: centsToAmount(playerList.reduce((sum, player) => sum + player.balanceCents, 0))
    },
    round: adminRound(),
    players: playerList.map(privateAdminPlayer),
    rounds: db.rounds.slice(0, 80).map(adminHistoryRound),
    audit: db.audit.slice(0, 80)
  };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function wsFrame(payload) {
  const data = Buffer.from(payload);
  if (data.length < 126) {
    return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  }
  if (data.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(data.length, 2);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(data.length), 2);
  return Buffer.concat([header, data]);
}

function readWsFrame(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) === 0x80;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    length = Number(bigLength);
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }

  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }
  return {
    opcode,
    text: opcode === 0x1 ? payload.toString("utf8") : ""
  };
}

function wsSend(client, type, data = {}) {
  if (!client || client.socket.destroyed) {
    clients.delete(client);
    return;
  }
  try {
    client.socket.write(wsFrame(JSON.stringify({ type, serverTime: Date.now(), data })));
  } catch {
    clients.delete(client);
  }
}

function broadcastEvent(type, data = {}) {
  for (const client of clients) {
    wsSend(client, type, data);
  }
}

function sendPlayerEvent(playerId, type, data = {}) {
  for (const client of clients) {
    if (client.playerId === playerId) {
      wsSend(client, type, data);
    }
  }
}

function publicSettings() {
  const maxDisplayMultiplier = Math.max(
    db.settings.maxCrashMultiplier || DEFAULT_SETTINGS.maxCrashMultiplier,
    db.settings.botOnlyHighFlightMin || DEFAULT_SETTINGS.botOnlyHighFlightMin,
    db.settings.botOnlyHighFlightMax || DEFAULT_SETTINGS.botOnlyHighFlightMax
  );
  return {
    minBet: centsToAmount(db.settings.minBetCents),
    maxBet: centsToAmount(db.settings.maxBetCents),
    betTiers: db.settings.betTiersCents.map(centsToAmount),
    bettingDurationMs: db.settings.bettingDurationMs,
    roundPauseMs: db.settings.roundPauseMs,
    paused: db.settings.paused,
    curve: curveConfig(),
    curveEarlyTargetMs: db.settings.curveEarlyTargetMs,
    curveEarlyPower: db.settings.curveEarlyPower,
    curveLateSpeedMs: db.settings.curveLateSpeedMs,
    maxDisplayMultiplier,
    publicWsUrl: ""
  };
}

function handleWsUpgrade(req, socket) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const client = {
    socket,
    playerId: url.searchParams.get("playerId") || ""
  };
  clients.add(client);
  wsSend(client, "snapshot", publicSnapshot(client.playerId));

  socket.on("data", (buffer) => {
    const frame = readWsFrame(buffer);
    if (!frame) return;
    if (frame.opcode === 0x8) {
      clients.delete(client);
      socket.end();
      return;
    }
    if (frame.opcode !== 0x1 || !frame.text) return;
    try {
      const message = JSON.parse(frame.text);
      if (message.type === "ping") {
        wsSend(client, "pong", { clientTime: message.clientTime || Date.now() });
      }
    } catch {
      // Ignore malformed client frames. The server only expects lightweight ping messages.
    }
  });
  socket.on("close", () => clients.delete(client));
  socket.on("error", () => clients.delete(client));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(httpError(413, "请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(httpError(400, "JSON 格式无效"));
      }
    });
    req.on("error", reject);
  });
}

function requireAdmin(req) {
  return { localDev: true };
}

function currentMoneyMetrics() {
  const historyTotals = db.rounds.reduce(
    (acc, round) => {
      const totals = persistedRoundMoneyTotals(round);
      acc.totalBet += totals.totalBet;
      acc.totalPayout += totals.totalPayout;
      acc.houseProfit += totals.houseProfit;
      return acc;
    },
    { totalBet: 0, totalPayout: 0, houseProfit: 0 }
  );
  const liveTotals = roundMoneyTotals(currentRound);
  const offsets = db.metricOffsets || {};
  return {
    totalBet: historyTotals.totalBet + liveTotals.totalBet + (offsets.totalBetCents || 0),
    totalPayout: historyTotals.totalPayout + liveTotals.totalPayout + (offsets.totalPayoutCents || 0),
    houseProfit: historyTotals.houseProfit + liveTotals.houseProfit + (offsets.houseProfitCents || 0)
  };
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/state") {
    return sendJson(res, 200, publicSnapshot(url.searchParams.get("playerId")));
  }

  if (route === "GET /api/ping") {
    return sendJson(res, 200, { now: Date.now() });
  }

  if (route === "POST /api/player/login") {
    const body = await readJson(req);
    const player = getOrCreatePlayer(body.username);
    return sendJson(res, 200, { player: publicPlayer(player), state: publicSnapshot(player.id) });
  }

  if (route === "POST /api/player/tutorial") {
    const body = await readJson(req);
    const player = getPlayer(body.playerId);
    if (body.completed !== true) {
      throw httpError(400, "completed must be true");
    }
    if (!player.tutorialCompletedAt) {
      player.tutorialCompletedAt = nowIso();
      audit("player.tutorial.completed", { playerId: player.id });
    }
    player.updatedAt = nowIso();
    saveDb();
    sendPlayerEvent(player.id, "player_update", { player: publicPlayer(player) });
    return sendJson(res, 200, { player: publicPlayer(player), state: publicSnapshot(player.id) });
  }

  if (route === "POST /api/bet") {
    const body = await readJson(req);
    const player = getPlayer(body.playerId);
    const amountCents = amountToCents(body.amount);
    const autoCashout = body.autoCashout ? Number(body.autoCashout) : null;

    if (!currentRound || currentRound.phase !== "betting") {
      throw httpError(409, "Betting is closed for this round");
    }
    if (!Number.isInteger(amountCents) || amountCents < db.settings.minBetCents) {
      throw httpError(400, `Minimum bet is ${centsToAmount(db.settings.minBetCents)}`);
    }
    if (amountCents > db.settings.maxBetCents) {
      throw httpError(400, `Maximum bet is ${centsToAmount(db.settings.maxBetCents)}`);
    }
    if (!db.settings.betTiersCents.includes(amountCents)) {
      throw httpError(400, "Bet amount must match one of the chip tiers");
    }
    if (amountCents > player.balanceCents) {
      throw httpError(400, "Insufficient balance");
    }
    const projectedCap = projectedPrizePoolCap(amountCents);
    if (projectedCap < 1.01) {
      throw httpError(400, "Prize pool cannot cover the minimum payout for this bet");
    }
    if (currentRound.bets.some((bet) => bet.playerId === player.id)) {
      throw httpError(409, "You already placed a bet this round");
    }
    if (autoCashout !== null && (!Number.isFinite(autoCashout) || autoCashout < 1.01 || autoCashout > db.settings.maxCrashMultiplier)) {
      throw httpError(400, "Auto cashout multiplier is invalid");
    }

    player.balanceCents -= amountCents;
    db.settings.prizePoolCents += amountCents;
    player.updatedAt = nowIso();
    const bet = {
      id: newId("bet"),
      roundId: currentRound.id,
      playerId: player.id,
      username: player.username,
      amountCents,
      autoCashout: autoCashout ? Number(autoCashout.toFixed(2)) : null,
      status: "open",
      cashoutMode: null,
      cashoutMultiplier: null,
      payoutCents: 0,
      placedAt: nowIso(),
      settledAt: null
    };
    currentRound.bets.push(bet);
    applyPrizePoolCap("human-bet");
    audit("bet.placed", { playerId: player.id, roundId: currentRound.id, amountCents });
    saveDb();
    broadcastEvent("bet_placed", { roundId: currentRound.id, round: publicRound(), bet: publicBet(bet) });
    sendPlayerEvent(player.id, "player_update", { player: publicPlayer(player) });
    return sendJson(res, 200, { bet: publicBet(bet), player: publicPlayer(player), state: publicSnapshot(player.id) });
  }

  if (route === "POST /api/cashout") {
    const body = await readJson(req);
    const player = getPlayer(body.playerId);
    if (!currentRound || currentRound.phase !== "flying") {
      throw httpError(409, "The rocket is not flying yet");
    }
    const bet = currentRound.bets.find((item) => item.playerId === player.id && item.status === "open");
    if (!bet) {
      throw httpError(404, "No open bet to cash out");
    }
    const currentMultiplier = multiplierAt();
    if (currentMultiplier >= currentRound.crashMultiplier) {
      finishRound();
      throw httpError(409, "The rocket has already crashed");
    }
    const settled = cashoutBet(bet, currentMultiplier, "manual");
    if (!settled) {
      throw httpError(409, "Prize pool cannot cover this payout");
    }
    audit("bet.cashout", {
      playerId: player.id,
      roundId: currentRound.id,
      multiplier: currentMultiplier,
      payoutCents: bet.payoutCents
    });
    saveDb();
    emitCashout(settled);
    return sendJson(res, 200, { bet: publicBet(bet), player: publicPlayer(player), state: publicSnapshot(player.id) });
  }

  if (route === "POST /api/admin/login") {
    return sendJson(res, 200, { token: "local-dev", admin: adminSnapshot() });
  }

  if (url.pathname.startsWith("/api/admin/")) {
    requireAdmin(req);
  }

  if (route === "GET /api/admin/overview") {
    return sendJson(res, 200, adminSnapshot());
  }

  if (route === "POST /api/admin/settings") {
    const body = await readJson(req);
    const previous = { ...db.settings };
    const numericFields = {
      bettingDurationMs: [3000, 30000],
      roundPauseMs: [1000, 15000],
      tickRateMs: [50, 1000],
      houseEdgeBps: [0, 2500],
      instantCrashBps: [0, 10000],
      maxCrashMultiplier: [2, 1000],
      curveEarlyTargetMs: [10000, 120000],
      curveLateSpeedMs: [3000, 60000],
      botMinCount: [0, 80],
      botMaxCount: [0, 120],
      botBetIntervalMinMs: [50, 5000],
      botBetIntervalMaxMs: [50, 5000],
      botOnlyHighFlightBps: [0, 10000],
      botOnlyHighFlightMin: [2, 1000],
      botOnlyHighFlightMax: [2, 1000]
    };

    for (const [key, range] of Object.entries(numericFields)) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      if (!Number.isFinite(value)) {
        throw httpError(400, `${key} 无效`);
      }
      db.settings[key] = Math.round(clamp(value, range[0], range[1]));
    }

    if (body.curveEarlyPower !== undefined) {
      const value = Number(body.curveEarlyPower);
      if (!Number.isFinite(value)) {
        throw httpError(400, "curveEarlyPower 无效");
      }
      db.settings.curveEarlyPower = Number(clamp(value, 1, 5).toFixed(2));
    }

    if (body.minBet !== undefined) {
      const cents = amountToCents(body.minBet);
      if (!Number.isInteger(cents) || cents < 1) throw httpError(400, "最小下注无效");
      db.settings.minBetCents = cents;
    }
    if (body.maxBet !== undefined) {
      const cents = amountToCents(body.maxBet);
      if (!Number.isInteger(cents) || cents < db.settings.minBetCents) throw httpError(400, "最大下注无效");
      db.settings.maxBetCents = cents;
    }
    if (body.betTiers !== undefined) {
      const tiers = parseAmountList(body.betTiers).filter((cents) => cents <= db.settings.maxBetCents);
      if (tiers.length === 0) throw httpError(400, "下注档位无效");
      db.settings.betTiersCents = tiers;
    }
    if (body.demoCredit !== undefined) {
      const cents = amountToCents(body.demoCredit);
      if (!Number.isInteger(cents) || cents < 0) throw httpError(400, "初始积分无效");
      db.settings.demoCreditCents = cents;
    }
    if (body.prizePool !== undefined) {
      const cents = amountToCents(body.prizePool);
      if (!Number.isInteger(cents) || cents < 0) throw httpError(400, "奖池余额无效");
      db.settings.prizePoolCents = cents;
      applyPrizePoolCap("admin-prize-pool");
    }
    if (body.botMinBet !== undefined) {
      const cents = amountToCents(body.botMinBet);
      if (!Number.isInteger(cents) || cents < 0) throw httpError(400, "机器人最小下注无效");
      db.settings.botMinBetCents = cents;
    }
    if (body.botMaxBet !== undefined) {
      const cents = amountToCents(body.botMaxBet);
      if (!Number.isInteger(cents) || cents < db.settings.botMinBetCents) throw httpError(400, "机器人最大下注无效");
      db.settings.botMaxBetCents = cents;
    }
    if (db.settings.botMinCount > db.settings.botMaxCount) {
      throw httpError(400, "机器人最小数量不能大于最大数量");
    }
    if (db.settings.botBetIntervalMinMs > db.settings.botBetIntervalMaxMs) {
      throw httpError(400, "机器人下注最小间隔不能大于最大间隔");
    }
    if (db.settings.botOnlyHighFlightMin > db.settings.botOnlyHighFlightMax) {
      throw httpError(400, "纯机器人高飞最小倍率不能大于最大倍率");
    }
    if (db.settings.minBetCents > db.settings.maxBetCents) {
      throw httpError(400, "最小下注不能大于最大下注");
    }
    db.settings.betTiersCents = (db.settings.betTiersCents || [])
      .filter((cents) => Number.isInteger(cents) && cents >= db.settings.minBetCents && cents <= db.settings.maxBetCents)
      .sort((a, b) => a - b);
    if (db.settings.betTiersCents.length === 0) {
      db.settings.betTiersCents = [db.settings.minBetCents, db.settings.maxBetCents];
    }
    if (body.paused !== undefined) {
      db.settings.paused = Boolean(body.paused);
    }

    audit("admin.settings", { previous, next: db.settings });
    saveDb();
    if (!currentRound && !db.settings.paused) createRound();
    broadcastEvent("settings_updated", { settings: publicSettings() });
    return sendJson(res, 200, adminSnapshot());
  }

  if (route === "POST /api/admin/maintenance") {
    const body = await readJson(req);
    const action = String(body.action || "");

    if (action === "clear_metrics") {
      const current = currentMoneyMetrics();
      db.metricOffsets = {
        totalBetCents: (db.metricOffsets?.totalBetCents || 0) - current.totalBet,
        totalPayoutCents: (db.metricOffsets?.totalPayoutCents || 0) - current.totalPayout,
        houseProfitCents: (db.metricOffsets?.houseProfitCents || 0) - current.houseProfit
      };
      audit("admin.clear-metrics", { cleared: current, offsets: db.metricOffsets });
      saveDb();
      return sendJson(res, 200, adminSnapshot());
    }

    if (action === "clear_rounds") {
      const removed = db.rounds.length;
      db.rounds = [];
      db.metricOffsets = { totalBetCents: 0, totalPayoutCents: 0, houseProfitCents: 0 };
      audit("admin.clear-rounds", { removed });
      saveDb();
      return sendJson(res, 200, adminSnapshot());
    }

    throw httpError(400, "维护操作无效");
  }

  if (route === "POST /api/admin/player-credit") {
    const body = await readJson(req);
    const player = getPlayer(body.playerId);
    const deltaCents = amountToCents(body.delta);
    if (!Number.isInteger(deltaCents) || deltaCents === 0) {
      throw httpError(400, "调整金额无效");
    }
    const nextBalance = player.balanceCents + deltaCents;
    if (nextBalance < 0) {
      throw httpError(400, "调整后余额不能为负数");
    }
    player.balanceCents = nextBalance;
    player.updatedAt = nowIso();
    audit("admin.player-credit", { playerId: player.id, deltaCents, nextBalance });
    saveDb();
    sendPlayerEvent(player.id, "player_update", { player: publicPlayer(player) });
    return sendJson(res, 200, adminSnapshot());
  }

  if (route === "POST /api/admin/force-crash") {
    const body = await readJson(req);
    if (!currentRound || currentRound.phase === "crashed") {
      throw httpError(409, "当前没有可控制的回合");
    }
    const requested = body.multiplier === undefined || body.multiplier === "" ? null : Number(body.multiplier);
    const currentMultiplier = currentRound.phase === "flying" ? multiplierAt() : 1;
    const maxAllowed = humanOpenBetCents(currentRound) > 0
      ? Math.min(db.settings.maxCrashMultiplier, prizePoolCapMultiplier(currentRound))
      : db.settings.maxCrashMultiplier;
    const nextCrash = requested
      ? clamp(Number(requested.toFixed(2)), currentMultiplier, maxAllowed)
      : currentMultiplier;
    currentRound.crashMultiplier = Number(nextCrash.toFixed(2));
    currentRound.forced = true;
    audit("admin.force-crash", { roundId: currentRound.id, multiplier: currentRound.crashMultiplier });
    if (currentRound.phase === "betting") {
      startFlying();
    }
    finishRound();
    saveDb();
    return sendJson(res, 200, adminSnapshot());
  }

  if (route === "POST /api/admin/pause") {
    const body = await readJson(req);
    db.settings.paused = Boolean(body.paused);
    audit("admin.pause", { paused: db.settings.paused });
    saveDb();
    if (!currentRound && !db.settings.paused) createRound();
    broadcastEvent("settings_updated", { settings: publicSettings() });
    return sendJson(res, 200, adminSnapshot());
  }

  throw httpError(404, "接口不存在");
}

function safeStaticPath(urlPathname) {
  let pathname = decodeURIComponent(urlPathname);
  if (pathname === "/") pathname = "/index.html";
  const isAdminPage = pathname === ADMIN_PATH;
  if (isAdminPage) pathname = "/admin.html";
  if (!isAdminPage && (pathname === "/admin" || pathname === "/admin.html")) return null;
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  const relative = path.relative(PUBLIC_DIR, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return resolved;
}

function serveStatic(req, res, url) {
  const filePath = safeStaticPath(url.pathname);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  const cacheControl = [".html", ".js", ".css"].includes(ext)
    ? "no-store"
    : "public, max-age=3600";
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": cacheControl
  });
  fs.createReadStream(filePath).pipe(res);
}

const httpsOptions = httpsOptionsFromEnv();
const protocol = httpsOptions ? "https" : "http";
const wsProtocol = httpsOptions ? "wss" : "ws";

const server = (httpsOptions ? https.createServer(httpsOptions) : http.createServer());

server.on("request", async (req, res) => {
  const url = new URL(req.url, `${protocol}://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/events") {
      return sendJson(res, 410, { error: "SSE is disabled. Use /ws WebSocket events." });
    }
    if (req.method === "GET" && url.pathname === "/favicon.ico") {
      res.writeHead(302, { Location: "/favicon.svg" });
      res.end();
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      return await handleApi(req, res, url);
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      throw httpError(405, "Method not allowed");
    }
    return serveStatic(req, res, url);
  } catch (error) {
    const statusCode = error.statusCode || 500;
    if (statusCode >= 500) {
      console.error(error);
    }
    return sendJson(res, statusCode, { error: error.message || "服务器错误" });
  }
});

server.on("upgrade", handleWsUpgrade);

setInterval(tick, 50);
createRound();

server.listen(PORT, () => {
  console.log(`Rocket Crash Platform running at ${protocol}://localhost:${PORT}`);
  console.log(`Admin console: ${protocol}://localhost:${PORT}${ADMIN_PATH}`);
  console.log(`WebSocket endpoint: ${wsProtocol}://localhost:${PORT}/ws`);
  console.log("Admin authentication is disabled for MVP/local operation.");
});
