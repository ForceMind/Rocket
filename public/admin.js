const $ = (selector) => document.querySelector(selector);

const ui = {
  app: $("#adminApp"),
  status: $("#adminStatus"),
  refreshButton: $("#refreshButton"),
  metricPlayers: $("#metricPlayers"),
  metricOnline: $("#metricOnline"),
  metricBet: $("#metricBet"),
  metricPayout: $("#metricPayout"),
  metricProfit: $("#metricProfit"),
  metricPrizePool: $("#metricPrizePool"),
  metricCurrentBotCount: $("#metricCurrentBotCount"),
  metricLiability: $("#metricLiability"),
  adminRoundPhase: $("#adminRoundPhase"),
  adminRoundId: $("#adminRoundId"),
  adminCurrentMultiplier: $("#adminCurrentMultiplier"),
  adminCrashMultiplier: $("#adminCrashMultiplier"),
  adminPoolCap: $("#adminPoolCap"),
  adminSeedHash: $("#adminSeedHash"),
  forceForm: $("#forceForm"),
  forceMultiplier: $("#forceMultiplier"),
  pauseButton: $("#pauseButton"),
  settingsForm: $("#settingsForm"),
  playerSearch: $("#playerSearch"),
  playersBody: $("#playersBody"),
  roundCount: $("#roundCount"),
  roundsBody: $("#roundsBody")
};

let token = "local-dev";
let state = null;
let pollTimer = null;
let settingsDirty = false;
let settingsSaving = false;

function formatMoney(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatMultiplier(value) {
  return `${Number(value || 1).toFixed(2)}x`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function adminApi(path, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {})
  };
  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) {
      lockAdmin();
    }
    throw new Error(data.error || "请求失败");
  }
  return data;
}

function unlockAdmin() {
  ui.app.classList.remove("locked");
  ui.status.textContent = "免密";
  ui.status.classList.add("online");
}

function lockAdmin() {
  token = "local-dev";
  ui.app.classList.add("locked");
  ui.status.textContent = "离线";
  ui.status.classList.remove("online");
  clearInterval(pollTimer);
}

async function refresh() {
  if (!token) return false;
  if (settingsSaving) return false;
  try {
    state = await adminApi("/api/admin/overview");
    unlockAdmin();
    render();
    return true;
  } catch (error) {
    console.error(error);
    ui.status.textContent = "加载失败";
    ui.status.classList.remove("online");
    return false;
  }
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 1000);
}

function phaseText(phase) {
  if (phase === "betting") return "下注中";
  if (phase === "flying") return "飞行中";
  if (phase === "crashed") return "已爆炸";
  return "等待";
}

function renderMetrics() {
  const metrics = state?.metrics || {};
  ui.metricPlayers.textContent = metrics.players || 0;
  ui.metricOnline.textContent = metrics.onlinePlayers || 0;
  ui.metricBet.textContent = formatMoney(metrics.totalBet);
  ui.metricPayout.textContent = formatMoney(metrics.totalPayout);
  ui.metricProfit.textContent = formatMoney(metrics.houseProfit);
  ui.metricProfit.style.color = Number(metrics.houseProfit || 0) >= 0 ? "var(--green)" : "var(--red)";
  ui.metricPrizePool.textContent = formatMoney(metrics.prizePool);
  ui.metricCurrentBotCount.textContent = metrics.currentBotCount || 0;
  ui.metricLiability.textContent = formatMoney(metrics.playerLiability);
}

function renderRound() {
  const round = state?.round;
  ui.adminRoundPhase.textContent = phaseText(round?.phase);
  ui.adminRoundId.value = round?.id || "-";
  ui.adminCurrentMultiplier.value = formatMultiplier(round?.currentMultiplier || 1);
  ui.adminCrashMultiplier.value = round?.crashMultiplier ? formatMultiplier(round.crashMultiplier) : "-";
  ui.adminPoolCap.value = round?.poolCapMultiplier ? formatMultiplier(round.poolCapMultiplier) : "-";
  ui.adminSeedHash.value = round?.seedHash || "-";
  ui.pauseButton.textContent = state?.settings?.paused ? "恢复" : "暂停";
}

function renderSettings(force = false) {
  const settings = state?.settings;
  if (!settings) return;
  if (!force && settingsDirty) return;
  for (const element of ui.settingsForm.elements) {
    if (!element.name || settings[element.name] === undefined) continue;
    element.value = settings[element.name];
  }
}

function renderPlayers(force = false) {
  if (!force && ui.playersBody.contains(document.activeElement)) return;
  const query = ui.playerSearch.value.trim().toLowerCase();
  const players = (state?.players || []).filter((player) => {
    return !query || player.username.toLowerCase().includes(query) || player.id.toLowerCase().includes(query);
  });

  if (players.length === 0) {
    ui.playersBody.innerHTML = `<tr><td colspan="4">暂无玩家</td></tr>`;
    return;
  }

  ui.playersBody.innerHTML = players
    .map((player) => {
      return `
        <tr>
          <td>
            <strong>${escapeHtml(player.username)}</strong><br />
            <small>${escapeHtml(player.id)}</small>
          </td>
          <td>${formatMoney(player.balance)}</td>
          <td>
            <div class="credit-control">
              <input data-credit-input="${escapeHtml(player.id)}" type="number" step="0.01" placeholder="+100 / -50" />
              <button data-credit-button="${escapeHtml(player.id)}" type="button">应用</button>
            </div>
          </td>
          <td>${player.lastSeenAt ? new Date(player.lastSeenAt).toLocaleString("zh-CN") : "-"}</td>
        </tr>
      `;
    })
    .join("");
}

function renderRounds() {
  const rounds = state?.rounds || [];
  ui.roundCount.textContent = `${rounds.length} 局`;
  if (rounds.length === 0) {
    ui.roundsBody.innerHTML = `<tr><td colspan="7">暂无记录</td></tr>`;
    return;
  }

  ui.roundsBody.innerHTML = rounds
    .map((round) => {
      const profit = Number(round.houseProfit || 0);
      const forced = round.forced ? " / forced" : "";
      const highFlight = round.botOnlyHighFlight ? " / bot-high" : "";
      return `
        <tr>
          <td>${new Date(round.crashedAt).toLocaleString("zh-CN")}</td>
          <td>${round.humanCount || 0} 真人 / ${round.botCount || 0} 机器人</td>
          <td>${formatMultiplier(round.crashMultiplier)}</td>
          <td>${formatMoney(round.totalBet)}</td>
          <td>${formatMoney(round.totalPayout)}</td>
          <td style="color:${profit >= 0 ? "var(--green)" : "var(--red)"}">${formatMoney(profit)}</td>
          <td class="hash-cell">${escapeHtml(round.seedHash)}${forced}${highFlight}</td>
        </tr>
      `;
    })
    .join("");
}

function render(options = {}) {
  renderMetrics();
  renderRound();
  renderSettings(Boolean(options.forceSettings));
  renderPlayers(Boolean(options.forcePlayers));
  renderRounds();
}

ui.refreshButton.addEventListener("click", refresh);

ui.settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  settingsSaving = true;
  clearInterval(pollTimer);
  const payload = {};
  for (const element of ui.settingsForm.elements) {
    if (!element.name) continue;
    payload[element.name] = element.value;
  }
  try {
    state = await adminApi("/api/admin/settings", {
      method: "POST",
      body: payload
    });
    settingsDirty = false;
    render({ forceSettings: true });
  } catch (error) {
    alert(error.message);
  } finally {
    settingsSaving = false;
    startPolling();
  }
});

ui.settingsForm.addEventListener("input", () => {
  settingsDirty = true;
});

ui.forceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!confirm("确认强制当前回合爆炸？")) return;
  try {
    state = await adminApi("/api/admin/force-crash", {
      method: "POST",
      body: { multiplier: ui.forceMultiplier.value }
    });
    ui.forceMultiplier.value = "";
    render({ forcePlayers: true });
  } catch (error) {
    alert(error.message);
  }
});

ui.pauseButton.addEventListener("click", async () => {
  try {
    state = await adminApi("/api/admin/pause", {
      method: "POST",
      body: { paused: !state?.settings?.paused }
    });
    render();
  } catch (error) {
    alert(error.message);
  }
});

ui.playerSearch.addEventListener("input", renderPlayers);

ui.playersBody.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-credit-button]");
  if (!button) return;
  const playerId = button.dataset.creditButton;
  const input = ui.playersBody.querySelector(`[data-credit-input="${CSS.escape(playerId)}"]`);
  const delta = input?.value;
  if (!delta) return;

  try {
    button.disabled = true;
    state = await adminApi("/api/admin/player-credit", {
      method: "POST",
      body: { playerId, delta }
    });
    render();
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
  }
});

refresh()
  .then((ok) => {
    if (ok) startPolling();
  })
  .catch(lockAdmin);
