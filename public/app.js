const $ = (selector) => document.querySelector(selector);

const ui = {
  overlay: $("#loginOverlay"),
  loginForm: $("#loginForm"),
  loginError: $("#loginError"),
  usernameInput: $("#usernameInput"),
  connectionStatus: $("#connectionStatus"),
  playerName: $("#playerName"),
  balance: $("#balance"),
  phaseLabel: $("#phaseLabel"),
  roundId: $("#roundId"),
  clockLabel: $("#clockLabel"),
  multiplier: $("#multiplier"),
  resultLabel: $("#resultLabel"),
  cashoutEffects: $("#cashoutEffects"),
  historyButton: $("#historyButton"),
  historyPopover: $("#historyPopover"),
  historyClose: $("#historyClose"),
  rulesButton: $("#rulesButton"),
  rulesPopover: $("#rulesPopover"),
  rulesClose: $("#rulesClose"),
  rulesTutorialButton: $("#rulesTutorialButton"),
  seedHash: $("#seedHash"),
  crashHistory: $("#crashHistory"),
  myHistory: $("#myHistory"),
  betForm: $("#betForm"),
  amountInput: $("#amountInput"),
  chipRow: $("#chipRow"),
  autoToggle: $("#autoToggle"),
  autoInput: $("#autoInput"),
  placeBetButton: $("#placeBetButton"),
  myBetStatus: $("#myBetStatus"),
  myBetDetail: $("#myBetDetail"),
  message: $("#message"),
  betCount: $("#betCount"),
  betsBody: $("#betsBody"),
  canvas: $("#rocketCanvas"),
  tutorialOverlay: $("#tutorialOverlay"),
  tutorialSkip: $("#tutorialSkip"),
  tutorialReplay: $("#tutorialReplay"),
  tutorialDone: $("#tutorialDone"),
  tutorialProgress: $("#tutorialProgress"),
  tutorialTitle: $("#tutorialTitle"),
  tutorialText: $("#tutorialText")
};

const runtimeConfig = window.ROCKET_CONFIG || {};
const CURVE_TARGET_MULTIPLIER = 20;
const CURVE_EARLY_LINEAR_WEIGHT = 0.02;
const DEFAULT_CURVE_EARLY_TARGET_MS = 35000;
const DEFAULT_CURVE_EARLY_POWER = 2.4;
const DEFAULT_CURVE_LATE_SPEED_MS = 12000;
const DEFAULT_MAX_DISPLAY_MULTIPLIER = 1000;
const DISPLAY_LAG_MS = 1000;
const HIGH_LATENCY_THRESHOLD_MS = 1000;
const STALE_FLIGHT_GRACE_MS = 10000;
const STATE_REFRESH_INTERVAL_MS = 5000;

let session = null;
let snapshot = null;
let source = null;
let reconnectTimer = null;
let messageTimer = null;
let lastDrawAt = 0;
let explosionRoundId = null;
let explosionStartedAt = 0;
let trackedRoundId = null;
let betStatusById = new Map();
let renderedChipSignature = "";
let serverClockSynced = false;
let serverClockTime = 0;
let serverClockPerf = 0;
let currentLatencyMs = null;
let latencyTimer = null;
let latencyInFlight = false;
let latencyTimeout = null;
let cashoutEffectIds = new Set();
let tutorialTimers = [];
let tutorialAnimationFrame = null;
let tutorialCompleteInFlight = false;
let tutorialState = null;
let preferenceTimer = null;
let stateRefreshInFlight = false;
let lastStateRefreshAt = 0;
let readoutRoundId = null;
let readoutMultiplier = null;

function formatMoney(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatLatency(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-- ms";
  return `${Math.max(0, Math.round(number))} ms`;
}

function formatMultiplier(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${Math.max(1, number).toFixed(2)}x`;
}

function formatInputMultiplier(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(1.01, number).toFixed(2) : "2.00";
}

function formatChip(value) {
  const number = Number(value || 0);
  if (number >= 1000 && number % 1000 === 0) return `${number / 1000}K`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return formatMoney(number).replace(".00", "");
}

function projectedPayout(amount, multiplier) {
  const amountCents = Math.round(Number(amount || 0) * 100);
  const safeMultiplier = Math.max(1, Number(multiplier || 1));
  if (!Number.isFinite(amountCents) || !Number.isFinite(safeMultiplier) || amountCents <= 0) return 0;
  const multiplierCents = Math.round(safeMultiplier * 100);
  return Math.floor((amountCents * multiplierCents) / 100) / 100;
}

function serverNow() {
  if (!serverClockSynced) return Date.now();
  return serverClockTime + Math.max(0, performance.now() - serverClockPerf);
}

function syncServerClock(serverTime, transitMs = 0, receivedAt = performance.now()) {
  const numericServerTime = Number(serverTime);
  const numericTransit = Number(transitMs);
  const numericReceivedAt = Number(receivedAt);
  if (!Number.isFinite(numericServerTime)) return;
  serverClockTime = numericServerTime + Math.max(0, Number.isFinite(numericTransit) ? numericTransit : 0);
  serverClockPerf = Number.isFinite(numericReceivedAt) ? numericReceivedAt : performance.now();
  serverClockSynced = true;
}

function maxDisplayMultiplier() {
  const configured = Number(snapshot?.settings?.maxDisplayMultiplier || DEFAULT_MAX_DISPLAY_MULTIPLIER);
  if (!Number.isFinite(configured) || configured < 2) return DEFAULT_MAX_DISPLAY_MULTIPLIER;
  return clamp(configured, 2, 10000);
}

function safeRoundMultiplier(value, fallback = 1) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 ? number : fallback;
}

function curveConfig(round = snapshot?.round) {
  const source = round?.curve || snapshot?.settings?.curve || {};
  const earlyTargetMs = Number(source.earlyTargetMs || snapshot?.settings?.curveEarlyTargetMs || DEFAULT_CURVE_EARLY_TARGET_MS);
  const earlyPower = Number(source.earlyPower || snapshot?.settings?.curveEarlyPower || DEFAULT_CURVE_EARLY_POWER);
  const lateSpeedMs = Number(source.lateSpeedMs || snapshot?.settings?.curveLateSpeedMs || DEFAULT_CURVE_LATE_SPEED_MS);
  const targetMultiplier = Number(source.targetMultiplier || CURVE_TARGET_MULTIPLIER);
  const earlyLinearWeight = Number(source.earlyLinearWeight || CURVE_EARLY_LINEAR_WEIGHT);
  return {
    earlyTargetMs: Number.isFinite(earlyTargetMs) && earlyTargetMs > 0 ? earlyTargetMs : DEFAULT_CURVE_EARLY_TARGET_MS,
    earlyPower: Number.isFinite(earlyPower) && earlyPower > 0 ? earlyPower : DEFAULT_CURVE_EARLY_POWER,
    lateSpeedMs: Number.isFinite(lateSpeedMs) && lateSpeedMs > 0 ? lateSpeedMs : DEFAULT_CURVE_LATE_SPEED_MS,
    targetMultiplier: Number.isFinite(targetMultiplier) && targetMultiplier > 1 ? targetMultiplier : CURVE_TARGET_MULTIPLIER,
    earlyLinearWeight: Number.isFinite(earlyLinearWeight) && earlyLinearWeight >= 0 && earlyLinearWeight <= 1
      ? earlyLinearWeight
      : CURVE_EARLY_LINEAR_WEIGHT
  };
}

function multiplierFromElapsed(elapsedMs, round = snapshot?.round) {
  const elapsed = Math.max(0, Number(elapsedMs || 0));
  const config = curveConfig(round);
  let raw;
  if (elapsed <= config.earlyTargetMs) {
    const progress = elapsed / config.earlyTargetMs;
    const easedProgress = (config.earlyLinearWeight * progress)
      + ((1 - config.earlyLinearWeight) * Math.pow(progress, config.earlyPower));
    raw = 1 + (config.targetMultiplier - 1) * easedProgress;
  } else {
    raw = config.targetMultiplier * Math.exp((elapsed - config.earlyTargetMs) / config.lateSpeedMs);
  }
  return Number.isFinite(raw) ? raw : maxDisplayMultiplier();
}

function elapsedForMultiplier(multiplier, round = snapshot?.round) {
  const value = Math.max(1, Number(multiplier || 1));
  const config = curveConfig(round);
  if (value <= config.targetMultiplier) {
    let low = 0;
    let high = config.earlyTargetMs;
    for (let i = 0; i < 48; i += 1) {
      const mid = (low + high) / 2;
      if (multiplierFromElapsed(mid, round) < value) {
        low = mid;
      } else {
        high = mid;
      }
    }
    return high;
  }
  return config.earlyTargetMs + config.lateSpeedMs * Math.log(value / config.targetMultiplier);
}

function refreshState(reason = "sync", force = false) {
  if (!session?.playerId || stateRefreshInFlight) return;
  const now = performance.now();
  if (!force && now - lastStateRefreshAt < STATE_REFRESH_INTERVAL_MS) return;
  stateRefreshInFlight = true;
  lastStateRefreshAt = now;
  api(`/api/state?playerId=${encodeURIComponent(session.playerId)}`)
    .then((data) => {
      snapshot = data;
      render();
    })
    .catch((error) => {
      console.warn(`State refresh failed (${reason})`, error);
    })
    .finally(() => {
      stateRefreshInFlight = false;
    });
}

function displayMultiplier(round = snapshot?.round) {
  if (!round) return 1;
  if (round.phase !== "flying" || !round.launchAt) {
    return safeRoundMultiplier(round.currentMultiplier || round.crashMultiplier || 1);
  }
  const launchAt = Number(round.launchAt);
  const fallback = safeRoundMultiplier(round.currentMultiplier || 1);
  if (!Number.isFinite(launchAt)) {
    refreshState("invalid-flight-time");
    return fallback;
  }

  const trueElapsed = Math.max(0, serverNow() - launchAt);
  if (!Number.isFinite(trueElapsed)) {
    refreshState("invalid-elapsed");
    return fallback;
  }

  const displayCap = maxDisplayMultiplier();
  const staleAtMs = elapsedForMultiplier(displayCap, round) + STALE_FLIGHT_GRACE_MS;
  if (trueElapsed > staleAtMs) {
    refreshState("stale-flight");
  }

  const displayElapsed = Math.max(0, trueElapsed - DISPLAY_LAG_MS);
  const raw = Math.min(multiplierFromElapsed(displayElapsed, round), displayCap);
  if (!Number.isFinite(raw)) {
    refreshState("overflow");
    return displayCap;
  }
  return Math.floor(clamp(raw, 1, displayCap) * 100) / 100;
}

function isDisplayStartingSoon(round = snapshot?.round) {
  if (!round || round.phase !== "flying" || !round.launchAt) return false;
  const launchAt = Number(round.launchAt);
  if (!Number.isFinite(launchAt)) return false;
  return Math.max(0, serverNow() - launchAt) < DISPLAY_LAG_MS;
}

function smoothReadoutMultiplier(target, round = snapshot?.round) {
  const value = safeRoundMultiplier(target, 1);
  if (round?.phase !== "flying" || !round?.id) {
    readoutRoundId = round?.id || null;
    readoutMultiplier = value;
    return value;
  }
  if (readoutRoundId !== round.id || readoutMultiplier === null || readoutMultiplier > value) {
    readoutRoundId = round.id;
    readoutMultiplier = value;
    return value;
  }
  const maxStep = readoutMultiplier < 3 ? 0.01 : readoutMultiplier < 10 ? 0.03 : 0.08;
  readoutMultiplier = Math.min(value, readoutMultiplier + maxStep);
  return Math.floor(readoutMultiplier * 100) / 100;
}

function secondsUntil(timestamp) {
  const numeric = Number(timestamp || 0);
  const target = Number.isFinite(numeric) && numeric > 0 ? numeric : Date.parse(timestamp || "");
  if (!Number.isFinite(target)) return 0;
  return Math.max(0, Math.ceil((target - serverNow()) / 1000));
}

function showMessage(text, isError = false) {
  ui.message.textContent = text || "";
  ui.message.style.color = isError ? "var(--red)" : "var(--amber)";
  clearTimeout(messageTimer);
  if (text) {
    messageTimer = setTimeout(() => {
      ui.message.textContent = "";
    }, 3200);
  }
}

function resetLatencyStatus() {
  currentLatencyMs = null;
  ui.connectionStatus.textContent = formatLatency(null);
  ui.connectionStatus.classList.remove("online", "slow");
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    keepalive: Boolean(options.keepalive),
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  syncServerClock(response.headers.get("X-Server-Time"));
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function sendLatencyPing() {
  if (latencyInFlight || !source || source.readyState !== WebSocket.OPEN) return;
  latencyInFlight = true;
  const clientTime = performance.now();
  try {
    source.send(JSON.stringify({ type: "ping", clientTime }));
  } catch {
    latencyInFlight = false;
    resetLatencyStatus();
    return;
  }
  clearTimeout(latencyTimeout);
  latencyTimeout = setTimeout(() => {
    latencyInFlight = false;
    resetLatencyStatus();
  }, 2500);
}

function handleLatencyPong(data) {
  latencyInFlight = false;
  clearTimeout(latencyTimeout);
  const clientTime = Number(data.clientTime);
  if (!Number.isFinite(clientTime)) return;
  const receivedAt = Number.isFinite(Number(data.receivedAt)) ? Number(data.receivedAt) : performance.now();
  const rtt = Math.max(1, receivedAt - clientTime);
  syncServerClock(data.serverTime, rtt / 2, receivedAt);
  currentLatencyMs = rtt;
  ui.connectionStatus.textContent = formatLatency(rtt);
  ui.connectionStatus.classList.add("online");
  ui.connectionStatus.classList.toggle("slow", rtt > HIGH_LATENCY_THRESHOLD_MS);
}

function startLatencyMonitor() {
  clearInterval(latencyTimer);
  clearTimeout(latencyTimeout);
  latencyInFlight = false;
  sendLatencyPing();
  latencyTimer = setInterval(sendLatencyPing, 3000);
}

function forceForegroundSync(reason = "foreground") {
  if (!session?.playerId) return;
  clearTimeout(latencyTimeout);
  latencyInFlight = false;
  sendLatencyPing();
  refreshState(reason, true);
  if (snapshot) render();
}

function saveSession(player) {
  session = { playerId: player.id, username: player.username };
  localStorage.setItem("rocket.session", JSON.stringify(session));
}

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem("rocket.session") || "null");
    if (saved?.username) {
      return saved;
    }
  } catch {
    localStorage.removeItem("rocket.session");
  }
  return null;
}

function hasCompletedTutorial() {
  return Boolean(snapshot?.player?.tutorialCompleted);
}

async function markTutorialComplete() {
  if (!session?.playerId || hasCompletedTutorial() || tutorialCompleteInFlight) return;
  tutorialCompleteInFlight = true;
  try {
    const data = await api("/api/player/tutorial", {
      method: "POST",
      keepalive: true,
      body: { playerId: session.playerId, completed: true }
    });
    snapshot = data.state || snapshot;
    if (data.player && snapshot) {
      snapshot.player = data.player;
    }
    render();
  } catch (error) {
    console.error(error);
  } finally {
    tutorialCompleteInFlight = false;
  }
}

function schedulePreferenceSave() {
  if (!session?.playerId || isTutorialActive()) return;
  clearTimeout(preferenceTimer);
  preferenceTimer = setTimeout(async () => {
    const value = Number(ui.autoInput.value);
    if (!Number.isFinite(value) || value < 1.01) return;
    try {
      const data = await api("/api/player/preferences", {
        method: "POST",
        body: {
          playerId: session.playerId,
          defaultAutoCashout: value
        }
      });
      snapshot = data.state || snapshot;
      if (data.player && snapshot) {
        snapshot.player = data.player;
      }
    } catch (error) {
      console.error(error);
    }
  }, 500);
}

function clearTutorialTimers() {
  for (const timer of tutorialTimers) clearTimeout(timer);
  tutorialTimers = [];
  if (tutorialAnimationFrame) {
    cancelAnimationFrame(tutorialAnimationFrame);
    tutorialAnimationFrame = null;
  }
}

function scheduleTutorial(delayMs, fn) {
  const timer = setTimeout(fn, delayMs);
  tutorialTimers.push(timer);
}

function isTutorialActive() {
  return Boolean(tutorialState?.active);
}

function setTutorialCopy(step, total, title, text) {
  if (!ui.tutorialTitle) return;
  ui.tutorialProgress.textContent = `Step ${step} / ${total}`;
  ui.tutorialTitle.textContent = title;
  ui.tutorialText.textContent = text;
}

function clearTutorialHighlights() {
  document.querySelectorAll(".tutorial-highlight").forEach((element) => {
    element.classList.remove("tutorial-highlight");
  });
}

function highlightTutorialTarget(selector) {
  clearTutorialHighlights();
  if (!selector) return;
  document.querySelectorAll(selector).forEach((element) => {
    element.classList.add("tutorial-highlight");
  });
}

function resetTutorialDemo() {
  clearTutorialTimers();
  clearTutorialHighlights();
  cashoutEffectIds.delete("tutorial_user_bet");
  tutorialState = {
    active: true,
    step: "chooseChip",
    amount: null,
    autoCashout: Number(ui.autoInput.value || snapshot?.player?.defaultAutoCashout || 2),
    multiplier: 1,
    cashoutMultiplier: null,
    cashedPayout: 0,
    startedAt: null,
    launchEndsAt: null,
    crashed: false,
    complete: false,
    phase: "betting"
  };
  document.body.classList.add("tutorial-active");
  ui.tutorialOverlay?.classList.remove("hidden");
  ui.historyPopover?.classList.add("hidden");
  ui.rulesPopover?.classList.add("hidden");
  render();
}

function runTutorialDemo() {
  resetTutorialDemo();
}

function handleTutorialChip(amount) {
  if (!isTutorialActive() || !["chooseChip", "placeBet"].includes(tutorialState.step)) return;
  tutorialState.amount = amount;
  tutorialState.step = "placeBet";
  ui.amountInput.value = amount;
  render();
}

function placeTutorialManualBet() {
  if (!isTutorialActive() || tutorialState.step !== "placeBet" || !tutorialState.amount) return;
  clearTutorialTimers();
  tutorialState.step = "launching";
  tutorialState.phase = "betting";
  tutorialState.launchEndsAt = Date.now() + 3000;
  tutorialState.multiplier = 1;
  render();
  scheduleTutorial(3100, startTutorialManualFlight);
}

function startTutorialManualFlight() {
  if (!isTutorialActive()) return;
  tutorialState.step = "cashout";
  tutorialState.phase = "flying";
  tutorialState.launchEndsAt = null;
  tutorialState.startedAt = performance.now();
  function frame(now) {
    if (!isTutorialActive() || tutorialState.step !== "cashout") return;
    const elapsed = now - tutorialState.startedAt;
    const progress = clamp(elapsed / 5200, 0, 1);
    tutorialState.multiplier = Math.floor((1 + 1.65 * (1 - Math.pow(1 - progress, 2.2))) * 100) / 100;
    render();
    tutorialAnimationFrame = requestAnimationFrame(frame);
  }
  tutorialAnimationFrame = requestAnimationFrame(frame);
}

function cashoutTutorialManual() {
  if (!isTutorialActive() || tutorialState.step !== "cashout") return;
  clearTutorialTimers();
  if (tutorialAnimationFrame) cancelAnimationFrame(tutorialAnimationFrame);
  tutorialAnimationFrame = null;
  const cashoutMultiplier = Math.max(1.15, tutorialState.multiplier || 1.15);
  tutorialState.cashoutMultiplier = Number(cashoutMultiplier.toFixed(2));
  tutorialState.cashedPayout = (tutorialState.amount || 10) * tutorialState.cashoutMultiplier;
  tutorialState.step = "crashing";
  render();
  scheduleTutorial(650, () => {
    if (!isTutorialActive()) return;
    const start = tutorialState.multiplier;
    const startedAt = performance.now();
    function frame(now) {
      if (!isTutorialActive() || tutorialState.step !== "crashing") return;
      const progress = clamp((now - startedAt) / 1300, 0, 1);
      tutorialState.multiplier = Math.floor((start + (2.84 - start) * progress) * 100) / 100;
      render();
      if (progress < 1) {
        tutorialAnimationFrame = requestAnimationFrame(frame);
      } else {
        tutorialState.multiplier = 2.84;
        tutorialState.phase = "crashed";
        tutorialState.crashed = true;
        tutorialState.step = "lossLesson";
        render();
      }
    }
    tutorialAnimationFrame = requestAnimationFrame(frame);
  });
}

function handleTutorialAction() {
  if (!isTutorialActive()) return;
  if (tutorialState.step === "placeBet") {
    placeTutorialManualBet();
  } else if (tutorialState.step === "cashout") {
    cashoutTutorialManual();
  } else if (tutorialState.step === "autoCashout") {
    finishTutorial();
  }
}

function prepareTutorialAutoCashout() {
  if (!isTutorialActive()) return;
  tutorialState.step = "autoCashout";
  tutorialState.complete = true;
  tutorialState.phase = "crashed";
  ui.autoToggle.checked = true;
  ui.autoInput.disabled = false;
  ui.autoInput.value = formatInputMultiplier(tutorialState.autoCashout || 2);
  markTutorialComplete();
  render();
}

function tutorialBets() {
  if (!isTutorialActive()) return [];
  const now = new Date().toISOString();
  const amount = tutorialState.amount || 10;
  const bets = [
    {
      id: "tutorial_bot_1",
      roundId: "tutorial_round",
      playerId: "tutorial_bot_1",
      displayName: "Lu**",
      amount,
      autoCashout: null,
      status: tutorialState.phase === "crashed" ? "lost" : "open",
      cashoutMultiplier: null,
      payout: 0,
      placedAt: now
    },
    {
      id: "tutorial_bot_2",
      roundId: "tutorial_round",
      playerId: "tutorial_bot_2",
      displayName: "Ra**",
      amount: 50,
      autoCashout: 2,
      status: tutorialState.phase === "crashed" ? "lost" : "open",
      cashoutMultiplier: null,
      payout: 0,
      placedAt: now
    }
  ];

  if (["launching", "cashout", "crashing", "lossLesson", "autoCashout"].includes(tutorialState.step)) {
    const cashed = Boolean(tutorialState.cashoutMultiplier);
    bets.unshift({
      id: "tutorial_user_bet",
      roundId: "tutorial_round",
      playerId: session?.playerId || "tutorial_player",
      displayName: "Yo**",
      username: snapshot?.player?.username || "You",
      amount,
      autoCashout: null,
      status: cashed ? "cashed" : "open",
      cashoutMultiplier: tutorialState.cashoutMultiplier,
      payout: cashed ? tutorialState.cashedPayout : 0,
      placedAt: now
    });
  }
  return bets;
}

function tutorialRound() {
  if (!isTutorialActive()) return null;
  const launchEndsAt = tutorialState.launchEndsAt || Date.now() + 3000;
  return {
    id: "tutorial_round",
    phase: tutorialState.phase,
    bettingEndsAt: launchEndsAt,
    nextRoundAt: Date.now() + 5000,
    currentMultiplier: tutorialState.multiplier,
    crashMultiplier: 2.84,
    bets: tutorialBets(),
    curve: snapshot?.settings?.curve || null,
    seedHash: "demo_9f2a7c84e1b05d3c8a4f",
    serverSeedHash: "demo_9f2a7c84e1b05d3c8a4f",
    hmac: "demo_hmac_preview"
  };
}

function tutorialSnapshot() {
  return {
    ...(snapshot || {}),
    player: {
      ...(snapshot?.player || {}),
      id: session?.playerId || "tutorial_player",
      username: snapshot?.player?.username || "Guest",
      balance: snapshot?.player?.balance || 1000
    },
    settings: snapshot?.settings || {},
    history: [
      { crashMultiplier: 1.42 },
      { crashMultiplier: 2.88 },
      { crashMultiplier: 6.36 },
      { crashMultiplier: 1.03 }
    ],
    myHistory: [],
    round: tutorialRound()
  };
}

function renderTutorialCoach() {
  if (!isTutorialActive()) return;
  ui.tutorialOverlay?.classList.remove("hidden");
  ui.tutorialOverlay.dataset.position = ["chooseChip", "placeBet", "launching", "cashout", "autoCashout"].includes(tutorialState.step)
    ? "top"
    : "bottom";
  const showNext = tutorialState.step === "lossLesson";
  const showDone = tutorialState.complete;
  ui.tutorialDone.hidden = !showNext && !showDone;
  ui.tutorialDone.disabled = !showNext && !showDone;
  ui.tutorialDone.textContent = showNext ? "Next" : "Start Playing";

  if (tutorialState.step === "chooseChip") {
    setTutorialCopy(1, 5, "Choose a Chip", "Pick a chip amount. This simulated round does not change your real balance.");
    highlightTutorialTarget("#chipRow");
  } else if (tutorialState.step === "placeBet") {
    setTutorialCopy(2, 5, "Place the Bet", "The amount is selected. Press Place Bet to enter the simulated round.");
    highlightTutorialTarget("#placeBetButton");
  } else if (tutorialState.step === "launching") {
    setTutorialCopy(3, 5, "Waiting for Launch", "Watch the 3 second countdown. The simulated rocket launches when it reaches zero.");
    highlightTutorialTarget(".stage-panel");
  } else if (tutorialState.step === "cashout") {
    setTutorialCopy(3, 5, "Cash Out Before Crash", "The multiplier is rising. Press Cash Out before the rocket explodes to lock the payout.");
    highlightTutorialTarget("#placeBetButton");
  } else if (tutorialState.step === "crashing") {
    setTutorialCopy(4, 5, "Payout Locked", "You cashed out. The round keeps flying until the rocket explodes.");
    highlightTutorialTarget(".stage-panel");
  } else if (tutorialState.step === "lossLesson") {
    setTutorialCopy(4, 5, "Crash Means Loss", "If you had not cashed out before this explosion, your bet would have been lost.");
    highlightTutorialTarget(".stage-panel");
  } else {
    setTutorialCopy(5, 5, "Use Auto Cashout", "Auto Cashout is useful when the network is slow. After you place a normal bet, the server automatically cashes out at your saved target.");
    highlightTutorialTarget("#autoToggle, #autoInput");
  }
}

function renderTutorialView() {
  const realSnapshot = snapshot;
  snapshot = tutorialSnapshot();
  const round = snapshot.round;
  const currentMultiplier = tutorialState.multiplier;
  document.body.classList.toggle("tutorial-launching", tutorialState.step === "launching");
  renderChips();
  if (ui.cashoutEffects) ui.cashoutEffects.innerHTML = "";
  ui.playerName.textContent = snapshot.player?.username || "Guest";
  ui.balance.textContent = formatMoney(snapshot.player?.balance || 0);
  ui.phaseLabel.textContent = phaseText(round?.phase);
  ui.phaseLabel.className = `phase-label ${round?.phase || ""}`;
  ui.roundId.textContent = "tutorial";
  renderMainReadout(round, smoothReadoutMultiplier(currentMultiplier, round));
  if (ui.seedHash) {
    ui.seedHash.textContent = round.seedHash || "-";
  }
  ui.resultLabel.textContent = tutorialState.phase === "crashed"
    ? `Crashed at ${formatMultiplier(round.crashMultiplier)}`
    : tutorialState.phase === "flying"
      ? "Flying"
      : tutorialState.step === "launching"
        ? "Waiting for Launch"
        : "Tutorial round";
  const tutorialBet = getMyBet();
  ui.resultLabel.classList.toggle("won", tutorialBet?.status === "cashed");
  if (tutorialBet?.status === "cashed") {
    ui.resultLabel.textContent = `Won +${formatMoney(tutorialBet.payout)}`;
  }
  renderClock(round);
  renderHistory();
  renderMyHistory();
  renderBets();
  renderMyBet();
  renderTutorialActions();
  renderTutorialCoach();
  snapshot = realSnapshot;
}

function setActionButtonContent(label, sublabel = "") {
  const main = document.createElement("span");
  main.className = "action-button-label";
  main.textContent = label;

  if (!sublabel) {
    ui.placeBetButton.replaceChildren(main);
    return;
  }

  const detail = document.createElement("span");
  detail.className = "action-button-detail";
  detail.textContent = sublabel;
  ui.placeBetButton.replaceChildren(main, detail);
}

function renderTutorialActions() {
  ui.amountInput.value = tutorialState.amount || ui.amountInput.value || 10;
  ui.autoInput.value = formatInputMultiplier(tutorialState.autoCashout || 2);
  ui.autoInput.disabled = !ui.autoToggle.checked && tutorialState.step !== "autoCashout";

  let label = "Choose Chip";
  let sublabel = "";
  let disabled = true;
  let cashoutMode = false;
  if (tutorialState.step === "placeBet") {
    label = "Place Bet";
    disabled = false;
  } else if (tutorialState.step === "launching") {
    label = `Launching in ${secondsUntil(tutorialState.launchEndsAt)}s`;
  } else if (tutorialState.step === "cashout") {
    label = "Cash Out";
    sublabel = formatMoney(projectedPayout(tutorialState.amount || 10, tutorialState.multiplier));
    disabled = false;
    cashoutMode = true;
  } else if (tutorialState.step === "crashing" || tutorialState.step === "lossLesson") {
    label = "Cashed Out";
  } else if (tutorialState.step === "autoCashout") {
    label = "Auto Cashout";
  }
  ui.placeBetButton.dataset.mode = "tutorial";
  setActionButtonContent(label, sublabel);
  ui.placeBetButton.disabled = disabled;
  ui.placeBetButton.classList.toggle("cashout-mode", cashoutMode);
}

function openTutorial(force = false) {
  if (!ui.tutorialOverlay || !session?.playerId) return;
  if (!force && hasCompletedTutorial()) return;
  runTutorialDemo();
}

function openTutorialIfNeeded() {
  openTutorial(false);
}

function closeTutorial(markComplete = true) {
  clearTutorialTimers();
  if (markComplete) markTutorialComplete();
  clearTutorialHighlights();
  document.body.classList.remove("tutorial-active", "tutorial-launching");
  tutorialState = null;
  ui.tutorialOverlay?.classList.add("hidden");
  render();
}

function finishTutorial() {
  closeTutorial(true);
}

async function login(username) {
  const data = await api("/api/player/login", {
    method: "POST",
    body: { username }
  });
  saveSession(data.player);
  snapshot = data.state;
  const savedAutoCashout = Number(data.player?.defaultAutoCashout || data.state?.player?.defaultAutoCashout || 2);
  ui.autoInput.value = formatInputMultiplier(savedAutoCashout);
  ui.overlay.classList.add("hidden");
  connectEvents();
  render();
  setTimeout(openTutorialIfNeeded, 350);
}

function connectEvents() {
  if (!session?.playerId) return;
  if (source) source.close();
  clearTimeout(reconnectTimer);

  resetLatencyStatus();
  const socket = new WebSocket(buildWsUrl(session.playerId));
  source = socket;
  socket.addEventListener("open", () => {
    if (source !== socket) return;
    startLatencyMonitor();
  });
  socket.addEventListener("message", (event) => {
    if (source !== socket) return;
    const receivedAt = performance.now();
    const message = JSON.parse(event.data);
    const data = message.data || {};
    if (message.type === "pong") {
      data.serverTime = message.serverTime;
      data.receivedAt = receivedAt;
    } else {
      syncServerClock(message.serverTime, 0, receivedAt);
    }
    handleRealtimeEvent(message.type, data);
  });
  socket.addEventListener("close", () => {
    if (source !== socket) return;
    source = null;
    resetLatencyStatus();
    clearInterval(latencyTimer);
    clearTimeout(latencyTimeout);
    latencyInFlight = false;
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectEvents, 1200);
  });
  socket.addEventListener("error", () => {
    if (source !== socket) return;
    resetLatencyStatus();
    clearTimeout(latencyTimeout);
    latencyInFlight = false;
    socket.close();
  });
}

function buildWsUrl(playerId) {
  const configuredUrl = runtimeConfig.publicWsUrl || snapshot?.settings?.publicWsUrl || "";
  const fallbackProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  const fallbackUrl = `${fallbackProtocol}//${location.host}/ws`;
  const url = new URL(configuredUrl || fallbackUrl, location.href);

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  url.searchParams.set("playerId", playerId);
  return url.toString();
}

function handleRealtimeEvent(type, data) {
  if (type === "pong") {
    handleLatencyPong(data);
    return;
  }

  if (type === "snapshot") {
    snapshot = data;
  } else {
    if (!snapshot) snapshot = { history: [], settings: {}, round: null, player: null };
  }

  if (type === "round_start") {
    snapshot.round = data.round;
    if (data.settings) snapshot.settings = data.settings;
  } else if (type === "flight_start") {
    if (data.round) {
      snapshot.round = data.round;
      snapshot.round.curve = data.curve || snapshot.settings?.curve || null;
    } else {
      patchRound(data.roundId, {
        phase: data.phase || "flying",
        launchAt: data.launchAt,
        currentMultiplier: data.currentMultiplier || 1,
        curve: data.curve || snapshot.settings?.curve || null
      });
    }
  } else if (type === "bet_placed") {
    if (data.round) {
      snapshot.round = data.round;
    } else {
      upsertBet(data.bet);
    }
  } else if (type === "cashout") {
    let applied = true;
    if (data.round) {
      snapshot.round = data.round;
    } else {
      applied = upsertBet(data.bet);
    }
    if (applied) spawnCashoutEffect(data.bet);
  } else if (type === "crash") {
    snapshot.round = data.round;
    if (data.history) snapshot.history = data.history;
    if (data.settings) snapshot.settings = data.settings;
  } else if (type === "settings_updated") {
    snapshot.settings = data.settings;
  } else if (type === "player_update" && data.player) {
    snapshot.player = data.player;
  } else if (type === "my_history") {
    snapshot.myHistory = data.myHistory || [];
  }
  render();
}

function patchRound(roundId, changes) {
  if (!snapshot?.round || !roundId || snapshot.round.id !== roundId) {
    refreshState("round-delta-miss");
    return false;
  }
  Object.assign(snapshot.round, changes);
  return true;
}

function upsertBet(bet) {
  if (!snapshot?.round || !bet || bet.roundId !== snapshot.round.id) {
    refreshState("bet-delta-miss");
    return false;
  }
  const bets = snapshot.round.bets || [];
  const index = bets.findIndex((item) => item.id === bet.id);
  if (index >= 0) {
    bets[index] = bet;
  } else {
    bets.push(bet);
  }
  snapshot.round.bets = bets;
  return true;
}

function getMyBet() {
  if (!snapshot?.round?.bets || !session?.playerId) return null;
  return snapshot.round.bets.find((bet) => bet.playerId === session.playerId) || null;
}

function phaseText(phase) {
  if (phase === "betting") return "Betting";
  if (phase === "flying") return "Flying";
  if (phase === "crashed") return "Crashed";
  return "Waiting";
}

function renderClock(round) {
  ui.clockLabel.classList.remove("urgent");
  if (!round) {
    ui.clockLabel.textContent = "--";
    return;
  }
  if (round.phase === "betting") {
    const seconds = secondsUntil(round.bettingEndsAt);
    ui.clockLabel.textContent = `${seconds}s`;
    ui.clockLabel.classList.toggle("urgent", seconds <= 3);
  } else if (round.phase === "crashed") {
    ui.clockLabel.textContent = `${secondsUntil(round.nextRoundAt)}s`;
  } else {
    ui.clockLabel.textContent = "LIVE";
  }
}

function renderMainReadout(round, currentMultiplier = displayMultiplier(round)) {
  ui.multiplier.classList.remove("countdown", "urgent", "starting");
  if (round?.phase === "betting") {
    const seconds = secondsUntil(round.bettingEndsAt);
    ui.multiplier.textContent = `${seconds}s`;
    ui.multiplier.classList.add("countdown");
    ui.multiplier.classList.toggle("urgent", seconds <= 3);
  } else if (isDisplayStartingSoon(round)) {
    ui.multiplier.textContent = "Starting Soon!";
    ui.multiplier.classList.add("starting");
  } else if (round?.phase === "flying") {
    ui.multiplier.textContent = formatMultiplier(currentMultiplier);
  } else if (round?.phase === "crashed") {
    ui.multiplier.textContent = formatMultiplier(round.crashMultiplier);
  } else {
    ui.multiplier.textContent = "--";
  }
}

function renderHistory() {
  const rounds = snapshot?.history || [];
  ui.crashHistory.innerHTML = rounds
    .map((round) => {
      const value = Number(round.crashMultiplier || 1);
      const className = value < 1.5 ? "low" : value < 3 ? "mid" : "";
      return `<span class="history-chip ${className}">${formatMultiplier(value)}</span>`;
    })
    .join("");
}

function renderMyHistory() {
  const history = snapshot?.myHistory || [];
  if (history.length === 0) {
    ui.myHistory.innerHTML = `<div class="my-history-empty">No records yet</div>`;
    return;
  }
  ui.myHistory.innerHTML = history
    .map((item) => {
      const bet = item.bet || {};
      const status = bet.status === "cashed"
        ? `Won +${formatMoney(bet.payout)}`
        : bet.status === "lost"
          ? "Lost"
          : "Open";
      return `
        <div class="my-history-item">
          <strong>${formatMoney(bet.amount)}</strong>
          <span>${status}</span>
          <small>${item.crashMultiplier ? formatMultiplier(item.crashMultiplier) : "Live"}</small>
        </div>
      `;
    })
    .join("");
}

function renderBets() {
  const bets = snapshot?.round?.bets || [];
  ui.betCount.textContent = `${bets.length} ${bets.length === 1 ? "bet" : "bets"}`;
  if (bets.length === 0) {
    ui.betsBody.innerHTML = `<tr><td colspan="5">No bets yet</td></tr>`;
    return;
  }

  const sortedBets = [...bets].sort((a, b) => {
    const aPlacedAt = Date.parse(a.placedAt || "") || 0;
    const bPlacedAt = Date.parse(b.placedAt || "") || 0;
    if (snapshot?.round?.phase === "betting") {
      return aPlacedAt - bPlacedAt;
    }
    const amountDiff = Number(b.amount || 0) - Number(a.amount || 0);
    return amountDiff || aPlacedAt - bPlacedAt;
  });

  ui.betsBody.innerHTML = sortedBets
    .map((bet) => {
      const statusLabel =
        bet.status === "cashed"
          ? `+${formatMoney(bet.payout)}`
          : bet.status === "lost"
            ? "Lost"
            : "Open";
      return `
        <tr>
          <td>${escapeHtml(bet.displayName || bet.username)}</td>
          <td>${formatChip(bet.amount)}</td>
          <td>${bet.autoCashout ? formatMultiplier(bet.autoCashout) : "-"}</td>
          <td class="state-${bet.status}">${statusLabel}</td>
          <td>${formatMoney(bet.payout)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderMyBet() {
  const bet = getMyBet();
  const round = snapshot?.round;
  if (!bet) {
    ui.myBetStatus.classList.remove("won");
    ui.myBetStatus.textContent = "No Bet";
    ui.myBetDetail.textContent = "-";
    return;
  }

  ui.myBetStatus.classList.toggle("won", bet.status === "cashed");
  if (bet.status === "open") {
    ui.myBetStatus.textContent = round?.phase === "flying" ? "Ready to Cash Out" : "Waiting for Launch";
    ui.myBetDetail.textContent = `${formatMoney(bet.amount)} / Auto ${bet.autoCashout ? formatMultiplier(bet.autoCashout) : "Off"}`;
  } else if (bet.status === "cashed") {
    ui.myBetStatus.textContent = `Won +${formatMoney(bet.payout)}`;
    ui.myBetDetail.textContent = `Cashed at ${formatMultiplier(bet.cashoutMultiplier)}`;
  } else {
    ui.myBetStatus.textContent = "Lost";
    ui.myBetDetail.textContent = `Lost ${formatMoney(bet.amount)}`;
  }
}

function renderActions() {
  const round = snapshot?.round;
  const myBet = getMyBet();
  const canBet = round?.phase === "betting" && !myBet && !snapshot?.settings?.paused;
  const canCashout = round?.phase === "flying" && myBet?.status === "open";

  let mode = "wait";
  let label = "Waiting";
  let sublabel = "";
  let disabled = true;

  if (canCashout) {
    if (isDisplayStartingSoon(round)) {
      label = "Starting Soon!";
    } else {
      mode = "cashout";
      const cashoutDisplay = readoutRoundId === round.id && readoutMultiplier !== null
        ? readoutMultiplier
        : displayMultiplier(round);
      label = "Cash Out";
      sublabel = formatMoney(projectedPayout(myBet.amount, cashoutDisplay));
      disabled = false;
    }
  } else if (canBet) {
    mode = "bet";
    label = "Place Bet";
    disabled = false;
  } else if (myBet?.status === "open") {
    label = round?.phase === "betting" ? "Bet Placed" : "Waiting";
  } else if (myBet?.status === "cashed") {
    label = "Cashed Out";
  } else if (round?.phase === "crashed") {
    label = "Round Ended";
  }

  ui.placeBetButton.dataset.mode = mode;
  setActionButtonContent(label, sublabel);
  ui.placeBetButton.disabled = disabled;
  ui.placeBetButton.classList.toggle("cashout-mode", mode === "cashout");
}

function confirmHighLatencyBet() {
  if (!Number.isFinite(currentLatencyMs) || currentLatencyMs <= HIGH_LATENCY_THRESHOLD_MS) {
    return true;
  }
  const autoNote = ui.autoToggle.checked
    ? "Auto Cashout is enabled and will be handled by the server."
    : "Auto Cashout is recommended before placing this bet.";
  return window.confirm(
    `Your latency is ${formatLatency(currentLatencyMs)}, which is over 1 second.\n\n` +
    "The rocket display may be delayed, and manual cashout may fail even if the screen looks safe.\n\n" +
    `${autoNote}\n\nPlace this bet anyway?`
  );
}

function renderChips() {
  const tiers = snapshot?.settings?.betTiers?.length
    ? snapshot.settings.betTiers
    : [10, 50, 100, 500];
  const signature = tiers.join("|");
  if (signature === renderedChipSignature) return;
  renderedChipSignature = signature;
  ui.chipRow.innerHTML = tiers
    .map((tier, index) => `<button type="button" data-chip="${Number(tier)}" style="--chip-index:${index}"><span>${formatChip(tier)}</span></button>`)
    .join("");
}

function trackCashoutEffects(round) {
  if (!round?.id) return;
  const bets = round.bets || [];

  if (trackedRoundId !== round.id) {
    trackedRoundId = round.id;
    betStatusById = new Map(bets.map((bet) => [bet.id, bet.status]));
    cashoutEffectIds = new Set();
    return;
  }

  for (const bet of bets) {
    const previousStatus = betStatusById.get(bet.id);
    if (previousStatus && previousStatus !== "cashed" && bet.status === "cashed") {
      spawnCashoutEffect(bet);
    }
    betStatusById.set(bet.id, bet.status);
  }
}

function spawnCashoutEffect(bet) {
  if (!ui.cashoutEffects || !ui.canvas) return;
  if (cashoutEffectIds.has(bet.id)) return;
  cashoutEffectIds.add(bet.id);
  const rect = ui.canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  const width = rect.width;
  const height = rect.height;
  const padX = Math.max(28, width * 0.06);
  const padY = Math.max(32, height * 0.12);
  const multiplier = Number(bet.cashoutMultiplier || snapshot?.round?.currentMultiplier || 1);
  const progress = clamp(Math.log(Math.max(multiplier, 1)) / Math.log(12), 0, 1);
  const point = curvePoint(width, height, padX, padY, progress);
  const offset = (Math.random() - 0.5) * 42;

  const element = document.createElement("div");
  element.className = "cashout-pop";
  element.style.left = `${clamp(point.x + offset, 52, width - 52)}px`;
  element.style.top = `${clamp(point.y - 12, 66, height - 18)}px`;

  const name = document.createElement("strong");
  name.textContent = bet.displayName || bet.username;
  const payout = document.createElement("span");
  payout.textContent = `+${formatMoney(bet.payout)}`;
  element.append(name, payout);
  ui.cashoutEffects.append(element);
  setTimeout(() => element.remove(), 1700);
}

function render() {
  if (isTutorialActive()) {
    renderTutorialView();
    return;
  }
  const player = snapshot?.player;
  const round = snapshot?.round;
  trackCashoutEffects(round);
  renderChips();
  const currentMultiplier = displayMultiplier(round);
  ui.playerName.textContent = player?.username || "Guest";
  ui.balance.textContent = formatMoney(player?.balance || 0);
  ui.phaseLabel.textContent = phaseText(round?.phase);
  ui.phaseLabel.className = `phase-label ${round?.phase || ""}`;
  ui.roundId.textContent = round?.id ? round.id.slice(-10) : "-";
  renderMainReadout(round, smoothReadoutMultiplier(currentMultiplier, round));
  if (ui.seedHash) {
    ui.seedHash.textContent = round?.seedHash || "-";
  }
  renderClock(round);

  if (snapshot?.settings?.paused && (!round || round.phase === "crashed")) {
    ui.resultLabel.textContent = "Paused";
  } else if (round?.phase === "betting") {
    ui.resultLabel.textContent = "Place your bet";
  } else if (round?.phase === "flying") {
    ui.resultLabel.textContent = isDisplayStartingSoon(round) ? "Starting Soon!" : "Flying";
  } else if (round?.phase === "crashed") {
    ui.resultLabel.textContent = `Crashed at ${formatMultiplier(round.crashMultiplier)}`;
  } else {
    ui.resultLabel.textContent = "Waiting";
  }
  const myBet = getMyBet();
  ui.resultLabel.classList.toggle("won", myBet?.status === "cashed");
  if (myBet?.status === "cashed") {
    ui.resultLabel.textContent = `Won +${formatMoney(myBet.payout)}`;
  }

  renderHistory();
  renderMyHistory();
  renderBets();
  renderMyBet();
  renderActions();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setupCanvas() {
  const ctx = ui.canvas.getContext("2d");
  let canvasDpr = 1;
  const stars = Array.from({ length: 80 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 1.8 + 0.4,
    s: Math.random() * 0.4 + 0.1
  }));

  function resize() {
    const rect = ui.canvas.getBoundingClientRect();
    canvasDpr = window.devicePixelRatio || 1;
    ui.canvas.width = Math.max(1, Math.ceil(rect.width * canvasDpr));
    ui.canvas.height = Math.max(1, Math.ceil(rect.height * canvasDpr));
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);
  }

  function draw(timestamp) {
    if (timestamp - lastDrawAt < 16) {
      requestAnimationFrame(draw);
      return;
    }
    lastDrawAt = timestamp;
    const rect = ui.canvas.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    const round = isTutorialActive() ? tutorialRound() : snapshot?.round;
    const multiplier = isTutorialActive() ? Number(tutorialState.multiplier || 1) : Number(displayMultiplier(round));
    if (round?.phase === "flying") {
      renderMainReadout(round, smoothReadoutMultiplier(multiplier, round));
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, ui.canvas.width, ui.canvas.height);
    ctx.setTransform(canvasDpr, 0, 0, canvasDpr, 0, 0);

    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, "#141713");
    gradient.addColorStop(1, "#0d0d0b");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);

    drawStars(ctx, stars, width, height, timestamp);
    drawGrid(ctx, width, height);

    const padX = Math.max(28, width * 0.06);
    const padY = Math.max(32, height * 0.12);
    const progress = clamp(Math.log(multiplier) / Math.log(12), 0, 1);
    const point = curvePoint(width, height, padX, padY, progress);
    const x = point.x;
    const y = point.y;

    drawTrail(ctx, width, height, padX, padY, progress);
    if (round?.phase === "crashed") {
      if (explosionRoundId !== round.id) {
        explosionRoundId = round.id;
        explosionStartedAt = timestamp;
      }
      const explosionElapsed = timestamp - explosionStartedAt;
      if (explosionElapsed < 650) {
        drawExplosion(ctx, x, y, explosionElapsed);
      }
    } else {
      explosionRoundId = null;
      drawRocket(ctx, x, y, round?.phase === "flying" ? timestamp : 0);
    }

    ctx.save();
    ctx.fillStyle = "#0d0d0b";
    ctx.fillRect(0, height - 2, width, 2);
    ctx.restore();
    requestAnimationFrame(draw);
  }

  resize();
  window.addEventListener("resize", resize);
  requestAnimationFrame(draw);
}

function drawStars(ctx, stars, width, height, timestamp) {
  ctx.save();
  for (const star of stars) {
    const twinkle = 0.45 + Math.sin(timestamp * 0.002 * star.s + star.x * 20) * 0.25;
    ctx.globalAlpha = clamp(twinkle, 0.18, 0.8);
    ctx.fillStyle = "#f4f0e7";
    ctx.beginPath();
    ctx.arc(star.x * width, star.y * height, star.r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawGrid(ctx, width, height) {
  ctx.save();
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 72) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y < height; y += 58) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();
}

function curvePoint(width, height, padX, padY, progress) {
  const usableX = width - padX * 2;
  const usableY = height - padY * 2;
  const easedY = Math.pow(clamp(progress, 0, 1), 1.45);
  return {
    x: padX + progress * usableX,
    y: height - padY - easedY * usableY
  };
}

function drawTrail(ctx, width, height, padX, padY, progress) {
  ctx.save();
  ctx.strokeStyle = "#4ed49b";
  ctx.lineWidth = 4;
  ctx.shadowColor = "rgba(78, 212, 155, 0.55)";
  ctx.shadowBlur = 18;
  ctx.beginPath();
  const steps = Math.max(2, Math.ceil(progress * 80));
  for (let i = 0; i <= steps; i += 1) {
    const t = progress * (i / steps);
    const point = curvePoint(width, height, padX, padY, t);
    if (i === 0) {
      ctx.moveTo(point.x, point.y);
    } else {
      ctx.lineTo(point.x, point.y);
    }
  }
  ctx.stroke();
  ctx.restore();
}

function drawRocket(ctx, x, y, timestamp) {
  const bob = timestamp ? Math.sin(timestamp * 0.012) * 2 : 0;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(0.72);
  ctx.shadowColor = "rgba(244, 184, 74, 0.45)";
  ctx.shadowBlur = 24;

  ctx.fillStyle = "#f4f0e7";
  roundedPath(ctx, -16, -34, 32, 68, 15);
  ctx.fill();

  ctx.fillStyle = "#ff6b5f";
  ctx.beginPath();
  ctx.moveTo(0, -50);
  ctx.lineTo(17, -23);
  ctx.lineTo(-17, -23);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#67d9e8";
  ctx.beginPath();
  ctx.arc(0, -10, 8, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#f4b84a";
  ctx.beginPath();
  ctx.moveTo(-12, 32);
  ctx.lineTo(0, 62 + Math.sin(timestamp * 0.04) * 9);
  ctx.lineTo(12, 32);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#ff6b5f";
  ctx.beginPath();
  ctx.moveTo(-16, 22);
  ctx.lineTo(-35, 44);
  ctx.lineTo(-10, 34);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.moveTo(16, 22);
  ctx.lineTo(35, 44);
  ctx.lineTo(10, 34);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawExplosion(ctx, x, y, elapsedMs) {
  ctx.save();
  ctx.translate(x, y);
  const progress = clamp(elapsedMs / 650, 0, 1);
  const fade = 1 - progress;
  const burst = 1 - Math.pow(1 - progress, 3);

  ctx.globalAlpha = fade;
  ctx.strokeStyle = "#f4b84a";
  ctx.lineWidth = 4;
  ctx.shadowColor = "rgba(244, 184, 74, 0.5)";
  ctx.shadowBlur = 16;
  ctx.beginPath();
  ctx.arc(0, 0, 18 + burst * 54, 0, Math.PI * 2);
  ctx.stroke();

  const colors = ["#ff6b5f", "#f4b84a", "#f4f0e7"];
  for (let i = 0; i < 14; i += 1) {
    const angle = (i / 14) * Math.PI * 2;
    const radius = 12 + burst * (30 + (i % 4) * 10);
    const size = 9 - progress * 4 + (i % 3);
    ctx.fillStyle = colors[i % colors.length];
    ctx.globalAlpha = fade * (0.95 - (i % 4) * 0.08);
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function roundedPath(ctx, x, y, width, height, radius) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

ui.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  ui.loginError.textContent = "";
  try {
    await login(ui.usernameInput.value);
  } catch (error) {
    ui.loginError.textContent = error.message;
  }
});

async function submitBet() {
  if (!session?.playerId) return;
  if (!confirmHighLatencyBet()) return;
  ui.placeBetButton.disabled = true;
  try {
    const data = await api("/api/bet", {
      method: "POST",
      body: {
        playerId: session.playerId,
        amount: ui.amountInput.value,
        autoCashout: ui.autoToggle.checked ? ui.autoInput.value : null
      }
    });
    snapshot = data.state;
    showMessage("Bet placed");
    render();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    renderActions();
  }
}

async function submitCashout() {
  if (!session?.playerId) return;
  ui.placeBetButton.disabled = true;
  try {
    const data = await api("/api/cashout", {
      method: "POST",
      body: { playerId: session.playerId }
    });
    snapshot = data.state;
    showMessage("Cashed out");
    render();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    renderActions();
  }
}

ui.betForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (isTutorialActive()) {
    handleTutorialAction();
    return;
  }
  const mode = ui.placeBetButton.dataset.mode;
  if (mode === "cashout") {
    await submitCashout();
  } else if (mode === "bet") {
    await submitBet();
  }
});

ui.chipRow.addEventListener("click", (event) => {
  const button = event.target.closest("[data-chip]");
  if (!button) return;
  if (isTutorialActive()) {
    handleTutorialChip(Number(button.dataset.chip));
    return;
  }
  ui.amountInput.value = button.dataset.chip;
});

ui.autoToggle.addEventListener("change", () => {
  if (isTutorialActive()) {
    ui.autoInput.disabled = !ui.autoToggle.checked;
    if (tutorialState) tutorialState.autoCashout = Number(ui.autoInput.value || 2);
    render();
    return;
  }
  ui.autoInput.disabled = !ui.autoToggle.checked;
  if (ui.autoToggle.checked) schedulePreferenceSave();
});

ui.autoInput.addEventListener("input", () => {
  if (isTutorialActive()) {
    if (tutorialState) tutorialState.autoCashout = Number(ui.autoInput.value || 2);
    return;
  }
  schedulePreferenceSave();
});

ui.autoInput.addEventListener("change", () => {
  ui.autoInput.value = formatInputMultiplier(ui.autoInput.value);
  if (!isTutorialActive()) schedulePreferenceSave();
});

ui.historyButton.addEventListener("click", () => {
  ui.historyPopover.classList.toggle("hidden");
});

ui.historyClose.addEventListener("click", () => {
  ui.historyPopover.classList.add("hidden");
});

ui.rulesButton?.addEventListener("click", () => {
  ui.rulesPopover?.classList.toggle("hidden");
});

ui.rulesClose?.addEventListener("click", () => {
  ui.rulesPopover?.classList.add("hidden");
});

ui.rulesTutorialButton?.addEventListener("click", () => {
  ui.rulesPopover?.classList.add("hidden");
  openTutorial(true);
});

ui.tutorialSkip?.addEventListener("click", () => {
  closeTutorial(true);
});

ui.tutorialDone?.addEventListener("click", () => {
  if (!isTutorialActive()) return;
  if (tutorialState.step === "lossLesson") {
    prepareTutorialAutoCashout();
  } else if (tutorialState.complete) {
    closeTutorial(true);
  }
});

ui.tutorialReplay?.addEventListener("click", () => {
  runTutorialDemo();
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    forceForegroundSync("visible");
  }
});

window.addEventListener("focus", () => {
  forceForegroundSync("focus");
});

window.addEventListener("pageshow", () => {
  forceForegroundSync("pageshow");
});

setInterval(() => {
  if (isTutorialActive()) {
    renderTutorialView();
  } else if (snapshot) {
    renderClock(snapshot.round);
    if (snapshot.round?.phase !== "flying") {
      renderMainReadout(snapshot.round);
    }
    renderActions();
  }
}, 250);

setupCanvas();

const restored = loadSession();
if (restored?.username) {
  ui.usernameInput.value = restored.username;
  login(restored.username).catch(() => {
    ui.overlay.classList.remove("hidden");
  });
} else {
  ui.overlay.classList.remove("hidden");
}
