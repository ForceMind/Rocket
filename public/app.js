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
  seedHash: $("#seedHash"),
  history: $("#history"),
  betForm: $("#betForm"),
  amountInput: $("#amountInput"),
  autoInput: $("#autoInput"),
  placeBetButton: $("#placeBetButton"),
  cashoutButton: $("#cashoutButton"),
  myBetStatus: $("#myBetStatus"),
  myBetDetail: $("#myBetDetail"),
  message: $("#message"),
  betCount: $("#betCount"),
  betsBody: $("#betsBody"),
  canvas: $("#rocketCanvas")
};

let session = null;
let snapshot = null;
let source = null;
let messageTimer = null;
let lastDrawAt = 0;

function formatMoney(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatMultiplier(value) {
  return `${Number(value || 1).toFixed(2)}x`;
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

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "请求失败");
  }
  return data;
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
}

function connectEvents() {
  if (!session?.playerId) return;
  if (source) source.close();

  ui.connectionStatus.textContent = "连接中";
  ui.connectionStatus.classList.remove("online");
  source = new EventSource(`/events?playerId=${encodeURIComponent(session.playerId)}`);
  source.addEventListener("open", () => {
    ui.connectionStatus.textContent = "在线";
    ui.connectionStatus.classList.add("online");
  });
  source.addEventListener("state", (event) => {
    snapshot = JSON.parse(event.data);
    render();
  });
  source.addEventListener("error", () => {
    ui.connectionStatus.textContent = "重连中";
    ui.connectionStatus.classList.remove("online");
  });
}

function getMyBet() {
  if (!snapshot?.round?.bets || !session?.playerId) return null;
  return snapshot.round.bets.find((bet) => bet.playerId === session.playerId) || null;
}

function phaseText(phase) {
  if (phase === "betting") return "下注中";
  if (phase === "flying") return "飞行中";
  if (phase === "crashed") return "已爆炸";
  return "等待";
}

function renderClock(round) {
  if (!round) {
    ui.clockLabel.textContent = "--";
    return;
  }
  const now = Date.now();
  if (round.phase === "betting") {
    ui.clockLabel.textContent = `${Math.max(0, Math.ceil((round.bettingEndsAt - now) / 1000))}s`;
  } else if (round.phase === "crashed") {
    ui.clockLabel.textContent = `${Math.max(0, Math.ceil((round.nextRoundAt - now) / 1000))}s`;
  } else {
    ui.clockLabel.textContent = "LIVE";
  }
}

function renderHistory() {
  const rounds = snapshot?.history || [];
  ui.history.innerHTML = rounds
    .map((round) => {
      const value = Number(round.crashMultiplier || 1);
      const className = value < 1.5 ? "low" : value < 3 ? "mid" : "";
      return `<span class="history-chip ${className}">${formatMultiplier(value)}</span>`;
    })
    .join("");
}

function renderBets() {
  const bets = snapshot?.round?.bets || [];
  ui.betCount.textContent = `${bets.length} 注`;
  if (bets.length === 0) {
    ui.betsBody.innerHTML = `<tr><td colspan="5">暂无下注</td></tr>`;
    return;
  }

  ui.betsBody.innerHTML = bets
    .map((bet) => {
      const statusLabel =
        bet.status === "cashed"
          ? `已提现 ${formatMultiplier(bet.cashoutMultiplier)}`
          : bet.status === "lost"
            ? "爆炸"
            : "等待";
      return `
        <tr>
          <td>${escapeHtml(bet.username)}</td>
          <td>${formatMoney(bet.amount)}</td>
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
    ui.myBetStatus.textContent = "未下注";
    ui.myBetDetail.textContent = "-";
    return;
  }

  if (bet.status === "open") {
    ui.myBetStatus.textContent = round?.phase === "flying" ? "可提现" : "等待起飞";
    ui.myBetDetail.textContent = `${formatMoney(bet.amount)} / 自动 ${bet.autoCashout ? formatMultiplier(bet.autoCashout) : "-"}`;
  } else if (bet.status === "cashed") {
    ui.myBetStatus.textContent = `已提现 ${formatMultiplier(bet.cashoutMultiplier)}`;
    ui.myBetDetail.textContent = `返还 ${formatMoney(bet.payout)}`;
  } else {
    ui.myBetStatus.textContent = "已爆炸";
    ui.myBetDetail.textContent = `损失 ${formatMoney(bet.amount)}`;
  }
}

function renderActions() {
  const round = snapshot?.round;
  const myBet = getMyBet();
  const canBet = round?.phase === "betting" && !myBet && !snapshot?.settings?.paused;
  const canCashout = round?.phase === "flying" && myBet?.status === "open";

  ui.placeBetButton.disabled = !canBet;
  ui.cashoutButton.disabled = !canCashout;
  ui.cashoutButton.classList.toggle("visible", myBet?.status === "open");
  if (myBet?.status === "open" && round?.phase === "flying") {
    ui.cashoutButton.textContent = `立即提现 ${formatMultiplier(round.currentMultiplier)}`;
  } else {
    ui.cashoutButton.textContent = "立即提现";
  }
}

function render() {
  const player = snapshot?.player;
  const round = snapshot?.round;
  ui.playerName.textContent = player?.username || "未登录";
  ui.balance.textContent = formatMoney(player?.balance || 0);
  ui.phaseLabel.textContent = phaseText(round?.phase);
  ui.phaseLabel.className = `phase-label ${round?.phase || ""}`;
  ui.roundId.textContent = round?.id ? round.id.slice(-10) : "-";
  ui.multiplier.textContent = formatMultiplier(round?.currentMultiplier || round?.crashMultiplier || 1);
  ui.seedHash.textContent = round?.seedHash || "-";
  renderClock(round);

  if (snapshot?.settings?.paused && (!round || round.phase === "crashed")) {
    ui.resultLabel.textContent = "已暂停";
  } else if (round?.phase === "betting") {
    ui.resultLabel.textContent = "准备下注";
  } else if (round?.phase === "flying") {
    ui.resultLabel.textContent = "飞行中";
  } else if (round?.phase === "crashed") {
    ui.resultLabel.textContent = `爆点 ${formatMultiplier(round.crashMultiplier)}`;
  } else {
    ui.resultLabel.textContent = "等待";
  }

  renderHistory();
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
    const multiplier = Number(round?.currentMultiplier || round?.crashMultiplier || 1);

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
    const x = padX + progress * (width - padX * 2);
    const y = height - padY - progress * (height - padY * 2);

    drawTrail(ctx, padX, height - padY, x, y);
    if (round?.phase === "crashed") {
      drawExplosion(ctx, x, y, timestamp);
    } else {
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

function drawTrail(ctx, startX, startY, endX, endY) {
  ctx.save();
  ctx.strokeStyle = "#4ed49b";
  ctx.lineWidth = 4;
  ctx.shadowColor = "rgba(78, 212, 155, 0.55)";
  ctx.shadowBlur = 18;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.bezierCurveTo(startX + 120, startY - 24, endX - 120, endY + 84, endX, endY);
  ctx.stroke();
  ctx.restore();
}

function drawRocket(ctx, x, y, timestamp) {
  const bob = timestamp ? Math.sin(timestamp * 0.012) * 2 : 0;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.rotate(-0.72);
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

function drawExplosion(ctx, x, y, timestamp) {
  ctx.save();
  ctx.translate(x, y);
  const pulse = 1 + Math.sin(timestamp * 0.018) * 0.06;
  const colors = ["#ff6b5f", "#f4b84a", "#f4f0e7"];
  for (let ring = 0; ring < 3; ring += 1) {
    ctx.fillStyle = colors[ring];
    ctx.globalAlpha = 0.75 - ring * 0.18;
    for (let i = 0; i < 12; i += 1) {
      const angle = (i / 12) * Math.PI * 2 + ring * 0.22;
      const radius = (28 + ring * 16) * pulse;
      ctx.beginPath();
      ctx.arc(Math.cos(angle) * radius, Math.sin(angle) * radius, 8 + ring * 3, 0, Math.PI * 2);
      ctx.fill();
    }
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

ui.betForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session?.playerId) return;
  ui.placeBetButton.disabled = true;
  try {
    const data = await api("/api/bet", {
      method: "POST",
      body: {
        playerId: session.playerId,
        amount: ui.amountInput.value,
        autoCashout: ui.autoInput.value
      }
    });
    snapshot = data.state;
    showMessage("下注成功");
    render();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    renderActions();
  }
});

ui.cashoutButton.addEventListener("click", async () => {
  if (!session?.playerId) return;
  ui.cashoutButton.disabled = true;
  try {
    const data = await api("/api/cashout", {
      method: "POST",
      body: { playerId: session.playerId }
    });
    snapshot = data.state;
    showMessage("提现成功");
    render();
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    renderActions();
  }
});

document.querySelectorAll("[data-chip]").forEach((button) => {
  button.addEventListener("click", () => {
    ui.amountInput.value = button.dataset.chip;
  });
});

setInterval(() => {
  if (snapshot) {
    renderClock(snapshot.round);
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
