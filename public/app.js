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
  tutorialText: $("#tutorialText"),
  tutorialDemo: $("#tutorialDemo"),
  tutorialTrail: $("#tutorialTrail"),
  tutorialRocket: $("#tutorialRocket"),
  tutorialBurst: $("#tutorialBurst"),
  tutorialMultiplier: $("#tutorialMultiplier"),
  tutorialPhase: $("#tutorialPhase"),
  tutorialCashoutPop: $("#tutorialCashoutPop"),
  tutorialPayout: $("#tutorialPayout"),
  tutorialBetAmount: $("#tutorialBetAmount"),
  tutorialChipRow: $("#tutorialChipRow"),
  tutorialAutoToggle: $("#tutorialAutoToggle"),
  tutorialAutoCashout: $("#tutorialAutoCashout"),
  tutorialAction: $("#tutorialAction"),
  tutorialInstruction: $("#tutorialInstruction"),
  tutorialRoundStatus: $("#tutorialRoundStatus"),
  tutorialPlayers: $("#tutorialPlayers")
};

const runtimeConfig = window.ROCKET_CONFIG || {};
const CURVE_TARGET_MULTIPLIER = 20;
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
let serverTimeOffset = 0;
let currentLatencyMs = null;
let latencyTimer = null;
let latencyInFlight = false;
let latencyTimeout = null;
let cashoutEffectIds = new Set();
let tutorialTimers = [];
let tutorialAnimationFrame = null;
let tutorialCompleteInFlight = false;
let tutorialState = null;
let stateRefreshInFlight = false;
let lastStateRefreshAt = 0;

function formatMoney(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatMultiplier(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${Math.max(1, number).toFixed(2)}x`;
}

function formatChip(value) {
  const number = Number(value || 0);
  if (number >= 1000 && number % 1000 === 0) return `${number / 1000}K`;
  if (number >= 1000) return `${(number / 1000).toFixed(1).replace(/\.0$/, "")}K`;
  return formatMoney(number).replace(".00", "");
}

function serverNow() {
  return Date.now() + serverTimeOffset;
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
  return {
    earlyTargetMs: Number.isFinite(earlyTargetMs) && earlyTargetMs > 0 ? earlyTargetMs : DEFAULT_CURVE_EARLY_TARGET_MS,
    earlyPower: Number.isFinite(earlyPower) && earlyPower > 0 ? earlyPower : DEFAULT_CURVE_EARLY_POWER,
    lateSpeedMs: Number.isFinite(lateSpeedMs) && lateSpeedMs > 0 ? lateSpeedMs : DEFAULT_CURVE_LATE_SPEED_MS,
    targetMultiplier: Number.isFinite(targetMultiplier) && targetMultiplier > 1 ? targetMultiplier : CURVE_TARGET_MULTIPLIER
  };
}

function multiplierFromElapsed(elapsedMs, round = snapshot?.round) {
  const elapsed = Math.max(0, Number(elapsedMs || 0));
  const config = curveConfig(round);
  let raw;
  if (elapsed <= config.earlyTargetMs) {
    raw = 1 + (config.targetMultiplier - 1) * Math.pow(elapsed / config.earlyTargetMs, config.earlyPower);
  } else {
    raw = config.targetMultiplier * Math.exp((elapsed - config.earlyTargetMs) / config.lateSpeedMs);
  }
  return Number.isFinite(raw) ? raw : maxDisplayMultiplier();
}

function elapsedForMultiplier(multiplier, round = snapshot?.round) {
  const value = Math.max(1, Number(multiplier || 1));
  const config = curveConfig(round);
  if (value <= config.targetMultiplier) {
    return config.earlyTargetMs * Math.pow((value - 1) / (config.targetMultiplier - 1), 1 / config.earlyPower);
  }
  return config.earlyTargetMs + config.lateSpeedMs * Math.log(value / config.targetMultiplier);
}

function refreshState(reason = "sync") {
  if (!session?.playerId || stateRefreshInFlight) return;
  const now = Date.now();
  if (now - lastStateRefreshAt < STATE_REFRESH_INTERVAL_MS) return;
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

function secondsUntil(timestamp) {
  return Math.max(0, Math.ceil((Number(timestamp || 0) - serverNow()) / 1000));
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
  ui.connectionStatus.textContent = "-- ms";
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
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }
  return data;
}

function sendLatencyPing() {
  if (latencyInFlight || !source || source.readyState !== WebSocket.OPEN) return;
  latencyInFlight = true;
  const clientTime = Date.now();
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
  const rtt = Math.max(1, Date.now() - clientTime);
  currentLatencyMs = rtt;
  ui.connectionStatus.textContent = `${rtt} ms`;
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

function setTutorialRocket(progress) {
  if (!ui.tutorialRocket) return;
  const value = clamp(progress, 0, 1);
  if (tutorialState) tutorialState.progress = value;
  ui.tutorialRocket.style.left = `${12 + value * 66}%`;
  ui.tutorialRocket.style.bottom = `${14 + value * 50}%`;
  if (ui.tutorialTrail) {
    ui.tutorialTrail.style.transform = `rotate(-34deg) scaleX(${0.12 + value * 0.88})`;
  }
}

function setTutorialCopy(step, title, text, instruction = "") {
  if (!ui.tutorialTitle) return;
  ui.tutorialProgress.textContent = `Step ${step} / 6`;
  ui.tutorialTitle.textContent = title;
  ui.tutorialText.textContent = text;
  if (ui.tutorialInstruction) {
    ui.tutorialInstruction.textContent = instruction;
  }
}

function renderTutorialControls() {
  if (!ui.tutorialDemo || !tutorialState) return;
  ui.tutorialBetAmount.textContent = tutorialState.amount ? formatChip(tutorialState.amount) : "Pick";
  ui.tutorialAutoCashout.textContent = tutorialState.autoEnabled ? "2.00x" : "Off";
  ui.tutorialAutoToggle?.classList.toggle("on", Boolean(tutorialState.autoEnabled));
  if (ui.tutorialAutoToggle) {
    ui.tutorialAutoToggle.disabled = !tutorialState.autoToggleEnabled;
  }
  ui.tutorialDone.disabled = !tutorialState.complete;

  ui.tutorialChipRow?.querySelectorAll("[data-tutorial-chip]").forEach((button) => {
    const selected = Number(button.dataset.tutorialChip) === tutorialState.amount;
    button.classList.toggle("selected", selected);
    button.disabled = !tutorialState.chipsEnabled;
  });
}

function setTutorialStatus({
  phase = "Waiting",
  multiplier = 1,
  action = "Place Bet",
  actionMode = tutorialState?.actionMode || "none",
  actionDisabled = false,
  status = "No Bet",
  players = "0 bets",
  payout = "+17.20",
  cashout = false,
  crashed = false,
  complete = false,
  instruction
} = {}) {
  if (!ui.tutorialDemo || !tutorialState) return;
  tutorialState.multiplier = Number(multiplier || tutorialState.multiplier || 1);
  tutorialState.actionMode = actionMode;
  tutorialState.complete = Boolean(complete);
  ui.tutorialPhase.textContent = phase;
  ui.tutorialMultiplier.textContent = formatMultiplier(multiplier);
  ui.tutorialAction.textContent = action;
  ui.tutorialAction.disabled = actionDisabled;
  ui.tutorialRoundStatus.textContent = status;
  ui.tutorialPlayers.textContent = players;
  ui.tutorialPayout.textContent = payout;
  if (instruction !== undefined && ui.tutorialInstruction) {
    ui.tutorialInstruction.textContent = instruction;
  }
  ui.tutorialCashoutPop.classList.toggle("hidden", !cashout);
  ui.tutorialBurst.classList.toggle("show", crashed);
  ui.tutorialDemo.classList.toggle("complete", complete);
  ui.tutorialAction.classList.toggle("cashout-mode", action.includes("Cash Out"));
  renderTutorialControls();
}

function animateTutorialFlight({
  from = 1,
  to = 2,
  duration = 1600,
  startProgress = 0,
  endProgress = 0.75,
  onFrame,
  onDone
}) {
  const startedAt = performance.now();

  function drawFrame(now) {
    const progress = clamp((now - startedAt) / duration, 0, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    const multiplier = Math.floor((from + (to - from) * eased) * 100) / 100;
    const rocketProgress = startProgress + (endProgress - startProgress) * eased;

    setTutorialRocket(rocketProgress);
    onFrame?.(multiplier, rocketProgress);

    if (progress < 1) {
      tutorialAnimationFrame = requestAnimationFrame(drawFrame);
    } else {
      tutorialAnimationFrame = null;
      onDone?.();
    }
  }

  tutorialAnimationFrame = requestAnimationFrame(drawFrame);
}

function resetTutorialDemo() {
  clearTutorialTimers();
  tutorialState = {
    amount: null,
    autoEnabled: false,
    chipsEnabled: true,
    autoToggleEnabled: false,
    actionMode: "none",
    multiplier: 1,
    progress: 0,
    complete: false
  };
  setTutorialRocket(0);
  ui.tutorialDemo?.classList.remove("complete");
  ui.tutorialBurst?.classList.remove("show");
  ui.tutorialCashoutPop?.classList.add("hidden");
  setTutorialCopy(
    1,
    "Choose a Chip",
    "Pick the chip amount you want to bet before the rocket launches.",
    "Click one of the chip buttons."
  );
  setTutorialStatus({
    phase: "Betting",
    multiplier: 1,
    action: "Place Bet",
    actionMode: "none",
    actionDisabled: true,
    status: "No Bet",
    players: "0 bets"
  });
}

function runTutorialDemo() {
  resetTutorialDemo();
}

function handleTutorialChip(amount) {
  if (!tutorialState?.chipsEnabled) return;
  tutorialState.amount = amount;
  setTutorialCopy(
    2,
    "Place Your Bet",
    "The bet is not active until you press Place Bet.",
    "Click Place Bet to enter this simulated round."
  );
  setTutorialStatus({
    phase: "Betting",
    multiplier: 1,
    action: "Place Bet",
    actionMode: "placeManualBet",
    actionDisabled: false,
    status: "Ready",
    players: "0 bets"
  });
}

function placeTutorialManualBet() {
  tutorialState.chipsEnabled = false;
  tutorialState.autoToggleEnabled = false;
  setTutorialStatus({
    phase: "Betting",
    multiplier: 1,
    action: "Launching...",
    actionMode: "none",
    actionDisabled: true,
    status: "Waiting for Launch",
    players: "1 bet",
    instruction: "The rocket launches after betting closes."
  });
  scheduleTutorial(750, startTutorialManualFlight);
}

function startTutorialManualFlight() {
  setTutorialCopy(
    3,
    "Cash Out Manually",
    "The multiplier grows while the rocket flies. Cash out before the crash to lock a payout.",
    "Click Cash Out while the rocket is flying."
  );
  animateTutorialFlight({
    from: 1,
    to: 2.35,
    duration: 6500,
    startProgress: 0.02,
    endProgress: 0.66,
    onFrame: (multiplier) => {
      if (tutorialState.actionMode !== "manualCashout") {
        tutorialState.actionMode = "manualCashout";
      }
      setTutorialStatus({
        phase: "Flying",
        multiplier,
        action: `Cash Out ${formatMultiplier(multiplier)}`,
        actionMode: "manualCashout",
        actionDisabled: false,
        status: "Open",
        players: "3 bets"
      });
    },
    onDone: () => {
      if (tutorialState?.actionMode === "manualCashout") {
        setTutorialStatus({
          phase: "Flying",
          multiplier: tutorialState.multiplier,
          action: `Cash Out ${formatMultiplier(tutorialState.multiplier)}`,
          actionMode: "manualCashout",
          actionDisabled: false,
          status: "Open",
          players: "3 bets",
          instruction: "Click Cash Out now. In the real game, waiting too long can lose the bet."
        });
      }
    }
  });
}

function cashoutTutorialManual() {
  if (tutorialAnimationFrame) {
    cancelAnimationFrame(tutorialAnimationFrame);
    tutorialAnimationFrame = null;
  }
  const cashoutMultiplier = Math.max(1.15, tutorialState.multiplier || 1.15);
  const payout = `+${formatMoney((tutorialState.amount || 10) * cashoutMultiplier)}`;
  tutorialState.actionMode = "none";
  setTutorialCopy(
    4,
    "Crash Ends the Round",
    "Your payout is locked. Bets that stay open lose when the rocket explodes.",
    "Watch the round finish, then set up Auto Cashout."
  );
  setTutorialStatus({
    phase: "Flying",
    multiplier: cashoutMultiplier,
    action: "Cashed Out",
    actionMode: "none",
    actionDisabled: true,
    status: `Cashed ${formatMultiplier(cashoutMultiplier)}`,
    players: "3 bets",
    payout,
    cashout: true
  });
  scheduleTutorial(700, () => {
    const startProgress = tutorialState.progress || 0.45;
    animateTutorialFlight({
      from: cashoutMultiplier,
      to: 2.84,
      duration: 1100,
      startProgress,
      endProgress: 0.78,
      onFrame: (multiplier) => {
        setTutorialStatus({
          phase: "Flying",
          multiplier,
          action: "Cashed Out",
          actionMode: "none",
          actionDisabled: true,
          status: `Cashed ${formatMultiplier(cashoutMultiplier)}`,
          players: "3 bets",
          payout,
          cashout: true
        });
      },
      onDone: () => {
        setTutorialStatus({
          phase: "Crashed",
          multiplier: 2.84,
          action: "Round Ended",
          actionMode: "none",
          actionDisabled: true,
          status: `Cashed ${formatMultiplier(cashoutMultiplier)}`,
          players: "3 bets",
          payout,
          crashed: true
        });
        scheduleTutorial(1300, prepareTutorialAutoCashout);
      }
    });
  });
}

function prepareTutorialAutoCashout() {
  clearTutorialTimers();
  tutorialState.amount = 10;
  tutorialState.autoEnabled = false;
  tutorialState.chipsEnabled = false;
  tutorialState.autoToggleEnabled = true;
  tutorialState.actionMode = "none";
  tutorialState.complete = false;
  ui.tutorialBurst?.classList.remove("show");
  ui.tutorialCashoutPop?.classList.add("hidden");
  setTutorialRocket(0);
  setTutorialCopy(
    5,
    "Turn On Auto Cashout",
    "Auto Cashout stores a target on the server. The server jumps out automatically at that multiplier.",
    "Click Auto Cashout, then place the auto bet."
  );
  setTutorialStatus({
    phase: "Betting",
    multiplier: 1,
    action: "Place Auto Bet",
    actionMode: "none",
    actionDisabled: true,
    status: "No Bet",
    players: "0 bets"
  });
}

function toggleTutorialAutoCashout() {
  if (!tutorialState?.autoToggleEnabled) return;
  tutorialState.autoEnabled = true;
  setTutorialStatus({
    phase: "Betting",
    multiplier: 1,
    action: "Place Auto Bet",
    actionMode: "placeAutoBet",
    actionDisabled: false,
    status: "Auto at 2.00x",
    players: "0 bets",
    instruction: "Now click Place Auto Bet. You will not need to click Cash Out."
  });
}

function placeTutorialAutoBet() {
  tutorialState.autoToggleEnabled = false;
  setTutorialStatus({
    phase: "Betting",
    multiplier: 1,
    action: "Launching...",
    actionMode: "none",
    actionDisabled: true,
    status: "Auto at 2.00x",
    players: "1 bet",
    instruction: "The server will cash out automatically at 2.00x."
  });
  scheduleTutorial(700, startTutorialAutoFlight);
}

function startTutorialAutoFlight() {
  animateTutorialFlight({
    from: 1,
    to: 2,
    duration: 2100,
    startProgress: 0.02,
    endProgress: 0.58,
    onFrame: (multiplier) => {
      setTutorialStatus({
        phase: "Flying",
        multiplier,
        action: "Auto Armed",
        actionMode: "none",
        actionDisabled: true,
        status: "Auto at 2.00x",
        players: "3 bets"
      });
    },
    onDone: () => {
      setTutorialStatus({
        phase: "Flying",
        multiplier: 2,
        action: "Auto Cashed",
        actionMode: "none",
        actionDisabled: true,
        status: "Cashed 2.00x",
        players: "3 bets",
        payout: "+20.00",
        cashout: true,
        instruction: "Auto Cashout happened on the server at 2.00x."
      });
      scheduleTutorial(700, finishTutorialAutoRound);
    }
  });
}

function finishTutorialAutoRound() {
  animateTutorialFlight({
    from: 2,
    to: 3.18,
    duration: 1000,
    startProgress: tutorialState.progress || 0.58,
    endProgress: 0.86,
    onFrame: (multiplier) => {
      setTutorialStatus({
        phase: "Flying",
        multiplier,
        action: "Auto Cashed",
        actionMode: "none",
        actionDisabled: true,
        status: "Cashed 2.00x",
        players: "3 bets",
        payout: "+20.00",
        cashout: true
      });
    },
    onDone: () => {
      tutorialState.complete = true;
      setTutorialCopy(
        6,
        "Ready to Play",
        "You practiced manual cashout and server-side Auto Cashout.",
        "Click Start Playing to close the tutorial."
      );
      setTutorialStatus({
        phase: "Crashed",
        multiplier: 3.18,
        action: "Complete",
        actionMode: "none",
        actionDisabled: true,
        status: "Cashed 2.00x",
        players: "3 bets",
        payout: "+20.00",
        crashed: true,
        complete: true
      });
      markTutorialComplete();
    }
  });
}

function handleTutorialAction() {
  if (!tutorialState) return;
  if (tutorialState.actionMode === "placeManualBet") {
    placeTutorialManualBet();
  } else if (tutorialState.actionMode === "manualCashout") {
    cashoutTutorialManual();
  } else if (tutorialState.actionMode === "placeAutoBet") {
    placeTutorialAutoBet();
  }
}

function openTutorial(force = false) {
  if (!ui.tutorialOverlay || !session?.playerId) return;
  if (!force && hasCompletedTutorial()) return;
  ui.tutorialOverlay.classList.remove("hidden");
  runTutorialDemo();
}

function openTutorialIfNeeded() {
  openTutorial(false);
}

function closeTutorial(markComplete = true) {
  clearTutorialTimers();
  if (markComplete) markTutorialComplete();
  ui.tutorialOverlay?.classList.add("hidden");
}

async function login(username) {
  const data = await api("/api/player/login", {
    method: "POST",
    body: { username }
  });
  saveSession(data.player);
  snapshot = data.state;
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
    const message = JSON.parse(event.data);
    if (message.serverTime) {
      serverTimeOffset = message.serverTime - Date.now();
    }
    handleRealtimeEvent(message.type, message.data || {});
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
    snapshot.round = data.round;
    snapshot.round.curve = data.curve || snapshot.settings?.curve || null;
  } else if (type === "bet_placed") {
    if (data.round) {
      snapshot.round = data.round;
    } else {
      upsertBet(data.bet);
    }
  } else if (type === "cashout") {
    if (data.round) {
      snapshot.round = data.round;
    } else {
      upsertBet(data.bet);
    }
    spawnCashoutEffect(data.bet);
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

function upsertBet(bet) {
  if (!snapshot?.round || !bet || bet.roundId !== snapshot.round.id) return;
  const bets = snapshot.round.bets || [];
  const index = bets.findIndex((item) => item.id === bet.id);
  if (index >= 0) {
    bets[index] = bet;
  } else {
    bets.push(bet);
  }
  snapshot.round.bets = bets;
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
  ui.multiplier.classList.remove("countdown", "urgent");
  if (round?.phase === "betting") {
    const seconds = secondsUntil(round.bettingEndsAt);
    ui.multiplier.textContent = `${seconds}s`;
    ui.multiplier.classList.add("countdown");
    ui.multiplier.classList.toggle("urgent", seconds <= 3);
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
    ui.myBetStatus.textContent = "No Bet";
    ui.myBetDetail.textContent = "-";
    return;
  }

  if (bet.status === "open") {
    ui.myBetStatus.textContent = round?.phase === "flying" ? "Ready to Cash Out" : "Waiting for Launch";
    ui.myBetDetail.textContent = `${formatMoney(bet.amount)} / Auto ${bet.autoCashout ? formatMultiplier(bet.autoCashout) : "Off"}`;
  } else if (bet.status === "cashed") {
    ui.myBetStatus.textContent = `Cashed ${formatMultiplier(bet.cashoutMultiplier)}`;
    ui.myBetDetail.textContent = `Payout ${formatMoney(bet.payout)}`;
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
  let disabled = true;

  if (canCashout) {
    mode = "cashout";
    label = `Cash Out ${formatMultiplier(displayMultiplier(round))}`;
    disabled = false;
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
  ui.placeBetButton.textContent = label;
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
    `Your latency is ${currentLatencyMs} ms, which is over 1 second.\n\n` +
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
  renderMainReadout(round, currentMultiplier);
  if (ui.seedHash) {
    ui.seedHash.textContent = round?.seedHash || "-";
  }
  renderClock(round);

  if (snapshot?.settings?.paused && (!round || round.phase === "crashed")) {
    ui.resultLabel.textContent = "Paused";
  } else if (round?.phase === "betting") {
    ui.resultLabel.textContent = "Place your bet";
  } else if (round?.phase === "flying") {
    ui.resultLabel.textContent = "Flying";
  } else if (round?.phase === "crashed") {
    ui.resultLabel.textContent = `Crashed at ${formatMultiplier(round.crashMultiplier)}`;
  } else {
    ui.resultLabel.textContent = "Waiting";
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
  const stars = Array.from({ length: 80 }, () => ({
    x: Math.random(),
    y: Math.random(),
    r: Math.random() * 1.8 + 0.4,
    s: Math.random() * 0.4 + 0.1
  }));

  function resize() {
    const rect = ui.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    ui.canvas.width = Math.floor(rect.width * dpr);
    ui.canvas.height = Math.floor(rect.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
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
    const round = snapshot?.round;
    const multiplier = Number(displayMultiplier(round));

    ctx.clearRect(0, 0, width, height);
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
  ui.amountInput.value = button.dataset.chip;
});

ui.autoToggle.addEventListener("change", () => {
  ui.autoInput.disabled = !ui.autoToggle.checked;
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
  closeTutorial(true);
});

ui.tutorialReplay?.addEventListener("click", () => {
  runTutorialDemo();
});

ui.tutorialChipRow?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-tutorial-chip]");
  if (!button) return;
  handleTutorialChip(Number(button.dataset.tutorialChip));
});

ui.tutorialAutoToggle?.addEventListener("click", () => {
  toggleTutorialAutoCashout();
});

ui.tutorialAction?.addEventListener("click", () => {
  handleTutorialAction();
});

setInterval(() => {
  if (snapshot) {
    renderClock(snapshot.round);
    renderMainReadout(snapshot.round);
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
