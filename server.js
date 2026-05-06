const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "db.json");

const DEFAULT_SETTINGS = {
  bettingDurationMs: 7000,
  roundPauseMs: 3500,
  tickRateMs: 100,
  minBetCents: 100,
  maxBetCents: 100000,
  demoCreditCents: 100000,
  houseEdgeBps: 150,
  maxCrashMultiplier: 100,
  paused: false
};

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
let adminTokens = new Map();
let lastBroadcastAt = 0;

function nowIso() {
  return new Date().toISOString();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalizeDb(input) {
  const safe = input && typeof input === "object" ? input : {};
  return {
    settings: { ...DEFAULT_SETTINGS, ...(safe.settings || {}) },
    players: safe.players && typeof safe.players === "object" ? safe.players : {},
    rounds: Array.isArray(safe.rounds) ? safe.rounds : [],
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

function publicPlayer(player) {
  if (!player) return null;
  return {
    id: player.id,
    username: player.username,
    balance: centsToAmount(player.balanceCents),
    createdAt: player.createdAt
  };
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
    throw httpError(400, "用户名至少需要 2 个字符");
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
    throw httpError(404, "玩家不存在，请重新登录");
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

  const houseFactor = clamp(1 - settings.houseEdgeBps / 10000, 0.5, 1);
  const raw = houseFactor / (1 - random);
  const crash = Math.floor(raw * 100) / 100;

  return {
    multiplier: Number(clamp(crash, 1, settings.maxCrashMultiplier).toFixed(2)),
    hmac
  };
}

function multiplierAt(timestamp = Date.now()) {
  if (!currentRound || currentRound.phase !== "flying" || !currentRound.launchAt) {
    return 1;
  }
  const elapsed = Math.max(0, timestamp - currentRound.launchAt);
  const raw = Math.exp(elapsed / 6500);
  const capped = clamp(raw, 1, db.settings.maxCrashMultiplier);
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
    bets: []
  };
  saveDb();
  broadcastState(true);
}

function startFlying() {
  if (!currentRound || currentRound.phase !== "betting") return;
  currentRound.phase = "flying";
  currentRound.launchAt = Date.now();
  currentRound.currentMultiplier = 1;
  broadcastState(true);
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

  const totalBetCents = currentRound.bets.reduce((sum, bet) => sum + bet.amountCents, 0);
  const totalPayoutCents = currentRound.bets.reduce((sum, bet) => sum + (bet.payoutCents || 0), 0);

  db.rounds.unshift({
    id: currentRound.id,
    nonce: currentRound.nonce,
    seedHash: currentRound.seedHash,
    serverSeed: currentRound.serverSeed,
    hmac: currentRound.hmac,
    crashMultiplier: currentRound.crashMultiplier,
    forced: currentRound.forced,
    startedAt: new Date(currentRound.createdAt).toISOString(),
    crashedAt: new Date(crashedAt).toISOString(),
    totalBet: centsToAmount(totalBetCents),
    totalPayout: centsToAmount(totalPayoutCents),
    houseProfit: centsToAmount(totalBetCents - totalPayoutCents),
    bets: currentRound.bets.map(publicBet)
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
  broadcastState(true);
}

function processAutoCashouts(currentMultiplier) {
  if (!currentRound || currentRound.phase !== "flying") return false;
  let changed = false;
  for (const bet of currentRound.bets) {
    if (bet.status !== "open" || !bet.autoCashout) continue;
    if (bet.autoCashout < currentRound.crashMultiplier && currentMultiplier >= bet.autoCashout) {
      cashoutBet(bet, bet.autoCashout, "auto");
      changed = true;
    }
  }
  return changed;
}

function cashoutBet(bet, multiplier, mode) {
  const player = db.players[bet.playerId];
  if (!player || bet.status !== "open") return null;

  const safeMultiplier = Number(clamp(multiplier, 1, db.settings.maxCrashMultiplier).toFixed(2));
  const payoutCents = Math.floor((bet.amountCents * Math.round(safeMultiplier * 100)) / 100);

  bet.status = "cashed";
  bet.cashoutMode = mode;
  bet.cashoutMultiplier = safeMultiplier;
  bet.payoutCents = payoutCents;
  bet.settledAt = nowIso();

  player.balanceCents += payoutCents;
  player.updatedAt = nowIso();
  return bet;
}

function tick() {
  const timestamp = Date.now();

  if (!currentRound) {
    createRound();
    return;
  }

  if (currentRound.phase === "betting" && timestamp >= currentRound.bettingEndsAt) {
    startFlying();
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
        broadcastState(true);
      }
    }
  }

  if (currentRound.phase === "crashed" && timestamp >= currentRound.nextRoundAt) {
    currentRound = null;
    createRound();
  }

  if (timestamp - lastBroadcastAt >= db.settings.tickRateMs) {
    broadcastState();
    lastBroadcastAt = timestamp;
  }
}

function publicBet(bet) {
  return {
    id: bet.id,
    playerId: bet.playerId,
    username: bet.username,
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
    settings: {
      minBet: centsToAmount(db.settings.minBetCents),
      maxBet: centsToAmount(db.settings.maxBetCents),
      bettingDurationMs: db.settings.bettingDurationMs,
      roundPauseMs: db.settings.roundPauseMs,
      paused: db.settings.paused
    },
    player: playerId && db.players[playerId] ? publicPlayer(db.players[playerId]) : null,
    round: publicRound(),
    history: db.rounds.slice(0, 24)
  };
}

function adminSnapshot() {
  const totals = db.rounds.reduce(
    (acc, round) => {
      acc.totalBet += amountToCents(round.totalBet) || 0;
      acc.totalPayout += amountToCents(round.totalPayout) || 0;
      acc.houseProfit += amountToCents(round.houseProfit) || 0;
      return acc;
    },
    { totalBet: 0, totalPayout: 0, houseProfit: 0 }
  );
  const playerList = Object.values(db.players).sort((a, b) => b.balanceCents - a.balanceCents);
  const onlinePlayerIds = new Set([...clients].map((client) => client.playerId).filter(Boolean));

  return {
    now: Date.now(),
    settings: {
      ...db.settings,
      minBet: centsToAmount(db.settings.minBetCents),
      maxBet: centsToAmount(db.settings.maxBetCents),
      demoCredit: centsToAmount(db.settings.demoCreditCents)
    },
    metrics: {
      players: playerList.length,
      onlinePlayers: onlinePlayerIds.size,
      rounds: db.rounds.length,
      totalBet: centsToAmount(totals.totalBet),
      totalPayout: centsToAmount(totals.totalPayout),
      houseProfit: centsToAmount(totals.houseProfit),
      playerLiability: centsToAmount(playerList.reduce((sum, player) => sum + player.balanceCents, 0))
    },
    round: adminRound(),
    players: playerList.map(privateAdminPlayer),
    rounds: db.rounds.slice(0, 80),
    audit: db.audit.slice(0, 80)
  };
}

function sendEvent(client, event, data) {
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
}

function broadcastState(force = false) {
  if (!force && clients.size === 0) return;
  for (const client of clients) {
    sendEvent(client, "state", publicSnapshot(client.playerId));
  }
}

function handleEvents(req, res, url) {
  const playerId = url.searchParams.get("playerId") || "";
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  const client = { res, playerId };
  clients.add(client);
  sendEvent(client, "state", publicSnapshot(playerId));

  req.on("close", () => {
    clients.delete(client);
  });
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
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const session = adminTokens.get(token);
  if (!session || session.expiresAt < Date.now()) {
    throw httpError(401, "后台登录已失效");
  }
  session.lastSeenAt = Date.now();
  return session;
}

function cleanExpiredAdminTokens() {
  const timestamp = Date.now();
  for (const [token, session] of adminTokens.entries()) {
    if (session.expiresAt < timestamp) {
      adminTokens.delete(token);
    }
  }
}

async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;

  if (route === "GET /api/state") {
    return sendJson(res, 200, publicSnapshot(url.searchParams.get("playerId")));
  }

  if (route === "POST /api/player/login") {
    const body = await readJson(req);
    const player = getOrCreatePlayer(body.username);
    return sendJson(res, 200, { player: publicPlayer(player), state: publicSnapshot(player.id) });
  }

  if (route === "POST /api/bet") {
    const body = await readJson(req);
    const player = getPlayer(body.playerId);
    const amountCents = amountToCents(body.amount);
    const autoCashout = body.autoCashout ? Number(body.autoCashout) : null;

    if (!currentRound || currentRound.phase !== "betting") {
      throw httpError(409, "当前不在下注阶段");
    }
    if (!Number.isInteger(amountCents) || amountCents < db.settings.minBetCents) {
      throw httpError(400, `最小下注 ${centsToAmount(db.settings.minBetCents)}`);
    }
    if (amountCents > db.settings.maxBetCents) {
      throw httpError(400, `最大下注 ${centsToAmount(db.settings.maxBetCents)}`);
    }
    if (amountCents > player.balanceCents) {
      throw httpError(400, "余额不足");
    }
    if (currentRound.bets.some((bet) => bet.playerId === player.id)) {
      throw httpError(409, "本局已经下注");
    }
    if (autoCashout !== null && (!Number.isFinite(autoCashout) || autoCashout < 1.01 || autoCashout > db.settings.maxCrashMultiplier)) {
      throw httpError(400, "自动提现倍率无效");
    }

    player.balanceCents -= amountCents;
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
    audit("bet.placed", { playerId: player.id, roundId: currentRound.id, amountCents });
    saveDb();
    broadcastState(true);
    return sendJson(res, 200, { bet: publicBet(bet), player: publicPlayer(player), state: publicSnapshot(player.id) });
  }

  if (route === "POST /api/cashout") {
    const body = await readJson(req);
    const player = getPlayer(body.playerId);
    if (!currentRound || currentRound.phase !== "flying") {
      throw httpError(409, "当前不在飞行阶段");
    }
    const bet = currentRound.bets.find((item) => item.playerId === player.id && item.status === "open");
    if (!bet) {
      throw httpError(404, "没有可提现的下注");
    }
    const currentMultiplier = multiplierAt();
    if (currentMultiplier >= currentRound.crashMultiplier) {
      finishRound();
      throw httpError(409, "火箭已经爆炸");
    }
    cashoutBet(bet, currentMultiplier, "manual");
    audit("bet.cashout", {
      playerId: player.id,
      roundId: currentRound.id,
      multiplier: currentMultiplier,
      payoutCents: bet.payoutCents
    });
    saveDb();
    broadcastState(true);
    return sendJson(res, 200, { bet: publicBet(bet), player: publicPlayer(player), state: publicSnapshot(player.id) });
  }

  if (route === "POST /api/admin/login") {
    const body = await readJson(req);
    if (String(body.password || "") !== ADMIN_PASSWORD) {
      throw httpError(401, "后台密码错误");
    }
    cleanExpiredAdminTokens();
    const token = crypto.randomBytes(32).toString("hex");
    adminTokens.set(token, {
      token,
      createdAt: Date.now(),
      expiresAt: Date.now() + 12 * 60 * 60 * 1000,
      lastSeenAt: Date.now()
    });
    audit("admin.login");
    saveDb();
    return sendJson(res, 200, { token, admin: adminSnapshot() });
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
      maxCrashMultiplier: [2, 1000]
    };

    for (const [key, range] of Object.entries(numericFields)) {
      if (body[key] === undefined) continue;
      const value = Number(body[key]);
      if (!Number.isFinite(value)) {
        throw httpError(400, `${key} 无效`);
      }
      db.settings[key] = Math.round(clamp(value, range[0], range[1]));
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
    if (body.demoCredit !== undefined) {
      const cents = amountToCents(body.demoCredit);
      if (!Number.isInteger(cents) || cents < 0) throw httpError(400, "初始积分无效");
      db.settings.demoCreditCents = cents;
    }
    if (db.settings.minBetCents > db.settings.maxBetCents) {
      throw httpError(400, "最小下注不能大于最大下注");
    }
    if (body.paused !== undefined) {
      db.settings.paused = Boolean(body.paused);
    }

    audit("admin.settings", { previous, next: db.settings });
    saveDb();
    if (!currentRound && !db.settings.paused) createRound();
    broadcastState(true);
    return sendJson(res, 200, adminSnapshot());
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
    broadcastState(true);
    return sendJson(res, 200, adminSnapshot());
  }

  if (route === "POST /api/admin/force-crash") {
    const body = await readJson(req);
    if (!currentRound || currentRound.phase === "crashed") {
      throw httpError(409, "当前没有可控制的回合");
    }
    const requested = body.multiplier === undefined || body.multiplier === "" ? null : Number(body.multiplier);
    const currentMultiplier = currentRound.phase === "flying" ? multiplierAt() : 1;
    const nextCrash = requested
      ? clamp(Number(requested.toFixed(2)), currentMultiplier, db.settings.maxCrashMultiplier)
      : currentMultiplier;
    currentRound.crashMultiplier = Number(nextCrash.toFixed(2));
    currentRound.forced = true;
    audit("admin.force-crash", { roundId: currentRound.id, multiplier: currentRound.crashMultiplier });
    if (currentRound.phase === "betting") {
      startFlying();
    }
    finishRound();
    saveDb();
    broadcastState(true);
    return sendJson(res, 200, adminSnapshot());
  }

  if (route === "POST /api/admin/pause") {
    const body = await readJson(req);
    db.settings.paused = Boolean(body.paused);
    audit("admin.pause", { paused: db.settings.paused });
    saveDb();
    if (!currentRound && !db.settings.paused) createRound();
    broadcastState(true);
    return sendJson(res, 200, adminSnapshot());
  }

  throw httpError(404, "接口不存在");
}

function safeStaticPath(urlPathname) {
  let pathname = decodeURIComponent(urlPathname);
  if (pathname === "/") pathname = "/index.html";
  if (pathname === "/admin") pathname = "/admin.html";
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
  res.writeHead(200, {
    "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600"
  });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/events") {
      return handleEvents(req, res, url);
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

setInterval(tick, 50);
setInterval(cleanExpiredAdminTokens, 60_000);
createRound();

server.listen(PORT, () => {
  console.log(`Rocket Crash Platform running at http://localhost:${PORT}`);
  console.log(`Admin console: http://localhost:${PORT}/admin`);
  if (ADMIN_PASSWORD === "admin123") {
    console.log("Default admin password is admin123. Set ADMIN_PASSWORD before sharing the server.");
  }
});
