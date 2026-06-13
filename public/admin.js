const $ = (selector) => document.querySelector(selector);

const ui = {
  app: $("#adminApp"),
  status: $("#adminStatus"),
  refreshButton: $("#refreshButton"),
  analyticsRefreshButton: $("#analyticsRefreshButton"),
  metricPlayers: $("#metricPlayers"),
  metricOnline: $("#metricOnline"),
  metricBet: $("#metricBet"),
  metricPayout: $("#metricPayout"),
  metricProfit: $("#metricProfit"),
  metricPrizePool: $("#metricPrizePool"),
  metricWaterBudget: $("#metricWaterBudget"),
  metricRiskMode: $("#metricRiskMode"),
  metricTodayRtp: $("#metricTodayRtp"),
  metricWeekRtp: $("#metricWeekRtp"),
  metricTodayBet: $("#metricTodayBet"),
  metricTodayPayout: $("#metricTodayPayout"),
  analyticsDateFrom: $("#analyticsDateFrom"),
  analyticsDateTo: $("#analyticsDateTo"),
  analyticsPlayerSelect: $("#analyticsPlayerSelect"),
  dailyBody: $("#dailyBody"),
  userSummaryBody: $("#userSummaryBody"),
  selectedUserTitle: $("#selectedUserTitle"),
  userDailyBody: $("#userDailyBody"),
  userRoundsBody: $("#userRoundsBody"),
  analyticsRoundCount: $("#analyticsRoundCount"),
  analyticsRoundsBody: $("#analyticsRoundsBody"),
  adminRoundPhase: $("#adminRoundPhase"),
  adminRoundId: $("#adminRoundId"),
  adminCurrentMultiplier: $("#adminCurrentMultiplier"),
  adminCrashMultiplier: $("#adminCrashMultiplier"),
  adminRandomCrashMultiplier: $("#adminRandomCrashMultiplier"),
  adminPoolCapReason: $("#adminPoolCapReason"),
  prizePoolForm: $("#prizePoolForm"),
  prizePoolInput: $("#prizePoolInput"),
  waterBudgetInput: $("#waterBudgetInput"),
  prizePoolSave: $("#prizePoolSave"),
  clearMetricsButton: $("#clearMetricsButton"),
  clearRoundsButton: $("#clearRoundsButton"),
  forceForm: $("#forceForm"),
  forceMultiplier: $("#forceMultiplier"),
  pauseButton: $("#pauseButton"),
  settingsForm: $("#settingsForm"),
  playerSearch: $("#playerSearch"),
  playersBody: $("#playersBody")
};

let state = null;
let analytics = null;
let pollTimer = null;
let settingsDirty = false;
let settingsSaving = false;
let analyticsInitialized = false;

function initTabs() {
  document.querySelectorAll('.admin-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const targetId = tab.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');
    });
  });
}

function formatMoney(value) {
  return Number(value || 0).toLocaleString("zh-CN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatRtp(value) {
  return `${Number(value || 0).toFixed(2)}%`;
}

function formatMultiplier(value) {
  const numeric = Number(value || 0);
  return numeric > 0 ? `${numeric.toFixed(2)}x` : "-";
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function profitColor(value) {
  return Number(value || 0) >= 0 ? "var(--green)" : "var(--red)";
}

async function adminApi(path, options = {}) {
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

function buildAnalyticsPath() {
  const params = new URLSearchParams();
  if (ui.analyticsDateFrom.value) params.set("dateFrom", ui.analyticsDateFrom.value);
  if (ui.analyticsDateTo.value) params.set("dateTo", ui.analyticsDateTo.value);
  if (ui.analyticsPlayerSelect.value) params.set("playerId", ui.analyticsPlayerSelect.value);
  params.set("limit", "300");
  return `/api/admin/analytics?${params.toString()}`;
}

function unlockAdmin() {
  ui.app.classList.remove("locked");
  ui.status.textContent = "在线";
  ui.status.classList.add("online");
}

function lockAdmin(message = "加载失败") {
  ui.status.textContent = message;
  ui.status.classList.remove("online");
  clearInterval(pollTimer);
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 2000);
}

async function refresh(options = {}) {
  if (settingsSaving) return false;
  try {
    const [overviewData, analyticsData] = await Promise.all([
      adminApi("/api/admin/overview"),
      adminApi(buildAnalyticsPath())
    ]);
    state = overviewData;
    analytics = analyticsData;
    unlockAdmin();
    render(options);
    return true;
  } catch (error) {
    console.error(error);
    lockAdmin(error.message || "加载失败");
    return false;
  }
}

function phaseText(phase) {
  if (phase === "betting") return "下注中";
  if (phase === "flying") return "飞行中";
  if (phase === "crashed") return "已爆炸";
  return "等待";
}

function renderMetrics() {
  const metrics = state?.metrics || {};
  const today = analytics?.summary?.today || {};
  const week = analytics?.summary?.week || {};
  
  ui.metricPlayers.textContent = metrics.players || 0;
  ui.metricOnline.textContent = metrics.onlinePlayers || 0;
  ui.metricBet.textContent = formatMoney(metrics.totalBet);
  ui.metricPayout.textContent = formatMoney(metrics.totalPayout);
  ui.metricProfit.textContent = formatMoney(metrics.houseProfit);
  ui.metricProfit.style.color = profitColor(metrics.houseProfit);
  ui.metricPrizePool.textContent = formatMoney(metrics.prizePool);
  
  ui.metricWaterBudget.textContent = formatMoney(state?.waterBudget);
  ui.metricRiskMode.textContent = state?.round?.riskMode || "正常";
  
  ui.metricTodayRtp.textContent = formatRtp(today.rtp);
  ui.metricWeekRtp.textContent = formatRtp(week.rtp);
  ui.metricTodayBet.textContent = formatMoney(today.totalBet);
  ui.metricTodayPayout.textContent = formatMoney(today.totalPayout);
  
  if (document.activeElement !== ui.prizePoolInput) {
    ui.prizePoolInput.value = state?.settings?.prizePool ?? metrics.prizePool ?? "";
  }
  if (document.activeElement !== ui.waterBudgetInput) {
    ui.waterBudgetInput.value = state?.waterBudget ?? "";
  }
}

function renderRound() {
  const round = state?.round;
  ui.adminRoundPhase.textContent = phaseText(round?.phase);
  ui.adminRoundId.value = round?.id || "-";
  ui.adminCurrentMultiplier.value = formatMultiplier(round?.currentMultiplier || 1);
  ui.adminCrashMultiplier.value = round?.crashMultiplier ? formatMultiplier(round.crashMultiplier) : "-";
  ui.adminRandomCrashMultiplier.value = round?.randomCrashMultiplier ? formatMultiplier(round.randomCrashMultiplier) : "-";
  ui.adminPoolCapReason.value = round?.poolCapReason || "无限制";
  ui.pauseButton.textContent = state?.settings?.paused ? "恢复" : "暂停";
}

function renderSettings(force = false) {
  const settings = state?.settings;
  if (!settings || (!force && settingsDirty)) return;
  for (const element of ui.settingsForm.elements) {
    if (!element.name || settings[element.name] === undefined) continue;
    element.value = settings[element.name];
  }
}

function renderAnalyticsFilters() {
  if (!analytics?.filters || analyticsInitialized) return;
  ui.analyticsDateFrom.value = analytics.filters.dateFrom || "";
  ui.analyticsDateTo.value = analytics.filters.dateTo || "";
  analyticsInitialized = true;
}

function renderPlayerSelect() {
  const selected = ui.analyticsPlayerSelect.value;
  const players = state?.players || [];
  ui.analyticsPlayerSelect.innerHTML = [
    `<option value="">全部玩家</option>`,
    ...players.map((player) => {
      const isSelected = player.id === selected ? " selected" : "";
      return `<option value="${escapeHtml(player.id)}"${isSelected}>${escapeHtml(player.username)} (${escapeHtml(player.id)})</option>`;
    })
  ].join("");
}

function renderDaily() {
  const rows = analytics?.daily || [];
  if (rows.length === 0) {
    ui.dailyBody.innerHTML = `<tr><td colspan="9">暂无每日数据</td></tr>`;
    return;
  }
  ui.dailyBody.innerHTML = rows
    .map((item) => `
      <tr>
        <td>${escapeHtml(item.date)}</td>
        <td>${item.rounds || 0}</td>
        <td>${item.uniquePlayers || 0}</td>
        <td>${formatMoney(item.totalBet)}</td>
        <td>${formatMoney(item.totalPayout)}</td>
        <td>${formatRtp(item.rtp)}</td>
        <td style="color:${profitColor(item.houseProfit)}">${formatMoney(item.houseProfit)}</td>
        <td>${formatMultiplier(item.avgCrash)}</td>
        <td>${formatMultiplier(item.maxCrash)}</td>
      </tr>
    `)
    .join("");
}

function renderUserSummary() {
  const rows = analytics?.users || [];
  if (rows.length === 0) {
    ui.userSummaryBody.innerHTML = `<tr><td colspan="7">暂无用户数据</td></tr>`;
    return;
  }
  ui.userSummaryBody.innerHTML = rows
    .slice(0, 80)
    .map((item) => `
      <tr>
        <td><strong>${escapeHtml(item.username)}</strong><br /><small>${escapeHtml(item.playerId)}</small></td>
        <td>${item.rounds || 0}</td>
        <td>${formatMoney(item.totalBet)}</td>
        <td>${formatMoney(item.totalPayout)}</td>
        <td>${formatRtp(item.rtp)}</td>
        <td style="color:${profitColor(item.net)}">${formatMoney(item.net)}</td>
        <td><button class="mini-button" data-user-select="${escapeHtml(item.playerId)}" type="button">查看</button></td>
      </tr>
    `)
    .join("");
}

function renderUserDetails() {
  const selectedPlayerId = analytics?.filters?.playerId || "";
  const selectedPlayer = selectedPlayerId
    ? (state?.players || []).find((player) => player.id === selectedPlayerId)
    : null;
  ui.selectedUserTitle.textContent = selectedPlayer
    ? `${selectedPlayer.username} / ${selectedPlayer.id}`
    : "全部玩家";

  const dailyRows = analytics?.userDaily || [];
  if (dailyRows.length === 0) {
    ui.userDailyBody.innerHTML = `<tr><td colspan="8">暂无按天明细</td></tr>`;
  } else {
    ui.userDailyBody.innerHTML = dailyRows
      .map((item) => `
        <tr>
          <td>${escapeHtml(item.date)}</td>
          <td><strong>${escapeHtml(item.username)}</strong><br /><small>${escapeHtml(item.playerId)}</small></td>
          <td>${item.rounds || 0}</td>
          <td>${formatMoney(item.totalBet)}</td>
          <td>${formatMoney(item.totalPayout)}</td>
          <td>${formatRtp(item.rtp)}</td>
          <td style="color:${profitColor(item.net)}">${formatMoney(item.net)}</td>
          <td>${item.wins || 0}/${item.losses || 0}</td>
        </tr>
      `)
      .join("");
  }

  const roundRows = analytics?.userRounds || [];
  if (!selectedPlayerId) {
    ui.userRoundsBody.innerHTML = `<tr><td colspan="7">请先指定玩家</td></tr>`;
  } else if (roundRows.length === 0) {
    ui.userRoundsBody.innerHTML = `<tr><td colspan="7">暂无回合明细</td></tr>`;
  } else {
    ui.userRoundsBody.innerHTML = roundRows
      .map((item) => `
        <tr>
          <td>${formatDateTime(item.createdAt)}</td>
          <td>${escapeHtml(item.roundId)}</td>
          <td>${formatMultiplier(item.crashMultiplier)}</td>
          <td>${formatMoney(item.amount)}</td>
          <td>${item.payout ? formatMoney(item.payout) : "-"}</td>
          <td style="color:${profitColor(item.payout ? item.payout - item.amount : -item.amount)}">
            ${formatMoney(item.payout ? item.payout - item.amount : -item.amount)}
          </td>
          <td><span class="state-${item.status}">${item.status === "cashed" ? "已逃脱" : "已坠毁"}</span></td>
        </tr>
      `)
      .join("");
  }
}

function renderAnalyticsRounds() {
  const rows = analytics?.rounds || [];
  ui.analyticsRoundCount.textContent = `${rows.length} 局`;
  if (rows.length === 0) {
    ui.analyticsRoundsBody.innerHTML = `<tr><td colspan="10">暂无回合数据</td></tr>`;
    return;
  }
  ui.analyticsRoundsBody.innerHTML = rows
    .map((item) => {
      const isLive = !item.crashedAt;
      return `
      <tr>
        <td>${formatDateTime(item.createdAt)}</td>
        <td>${escapeHtml(item.id)}</td>
        <td>${isLive ? "运行中" : formatMultiplier(item.crashMultiplier)}</td>
        <td>${formatMultiplier(item.randomCrashMultiplier)}</td>
        <td>${item.humanCount || 0} / ${item.botCount || 0}</td>
        <td>${formatMoney(item.humanBet)}</td>
        <td>${formatMoney(item.humanPayout)}</td>
        <td>${formatRtp(item.rtp)}</td>
        <td style="color:${profitColor(item.houseProfit)}">${formatMoney(item.houseProfit)}</td>
        <td><span class="state-${isLive ? "cashed" : "lost"}">${isLive ? "进行中" : "已结束"}</span></td>
      </tr>
    `;
    })
    .join("");
}

function renderPlayers() {
  const players = state?.players || [];
  const searchTerm = ui.playerSearch.value.trim().toLowerCase();
  const filtered = players.filter(
    (p) =>
      p.username.toLowerCase().includes(searchTerm) ||
      p.id.toLowerCase().includes(searchTerm)
  );

  if (filtered.length === 0) {
    ui.playersBody.innerHTML = `<tr><td colspan="4">未找到玩家</td></tr>`;
    return;
  }

  ui.playersBody.innerHTML = filtered
    .map((p) => `
      <tr>
        <td><strong>${escapeHtml(p.username)}</strong><br /><small>${escapeHtml(p.id)}</small></td>
        <td><strong>${formatMoney(p.balance)}</strong></td>
        <td>
          <div class="inline-form" style="display:inline-flex; align-items:center; gap:8px;">
            <input type="number" step="0.01" style="width: 80px;" id="add_${escapeHtml(p.id)}" placeholder="金额" />
            <button class="mini-button" onclick="addBalance('${escapeHtml(p.id)}')">加钱</button>
            <button class="mini-button" onclick="subBalance('${escapeHtml(p.id)}')">扣钱</button>
          </div>
        </td>
        <td>${formatDateTime(p.updatedAt || p.createdAt)}</td>
      </tr>
    `)
    .join("");
}

window.addBalance = async (playerId) => {
  const amount = Number(document.getElementById(`add_${playerId}`)?.value || 0);
  if (amount <= 0) return alert("请输入正确金额");
  if (!confirm(`确定要给 ${playerId} 增加 ${amount} 吗？`)) return;
  try {
    await adminApi("/api/admin/player-credit", { method: "POST", body: { playerId, delta: amount } });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
};

window.subBalance = async (playerId) => {
  const amount = Number(document.getElementById(`add_${playerId}`)?.value || 0);
  if (amount <= 0) return alert("请输入正确金额");
  if (!confirm(`确定要给 ${playerId} 扣除 ${amount} 吗？`)) return;
  try {
    await adminApi("/api/admin/player-credit", { method: "POST", body: { playerId, delta: -amount } });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
};

function render(options = {}) {
  renderMetrics();
  renderRound();
  renderSettings(options.forceSettings);
  renderAnalyticsFilters();
  if (document.activeElement !== ui.analyticsPlayerSelect) {
    renderPlayerSelect();
  }
  renderDaily();
  renderUserSummary();
  renderUserDetails();
  renderAnalyticsRounds();
  renderPlayers();
}

ui.settingsForm.addEventListener("input", () => {
  settingsDirty = true;
});

ui.settingsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const formData = new FormData(ui.settingsForm);
  const data = {};
  for (const [key, value] of formData.entries()) {
    if (key === "betTiers") {
      data[key] = value;
    } else {
      data[key] = Number(value);
    }
  }

  try {
    settingsSaving = true;
    const saveBtn = ui.settingsForm.querySelector("button[type=submit]");
    saveBtn.textContent = "保存中...";
    saveBtn.disabled = true;

    await adminApi("/api/admin/settings", {
      method: "POST",
      body: data
    });

    settingsDirty = false;
    await refresh({ forceSettings: true });
    alert("参数已保存并在下局生效！");
  } catch (err) {
    alert(err.message);
  } finally {
    settingsSaving = false;
    const saveBtn = ui.settingsForm.querySelector("button[type=submit]");
    saveBtn.textContent = "保存参数";
    saveBtn.disabled = false;
  }
});

ui.prizePoolForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const poolVal = Number(ui.prizePoolInput.value);
  const waterVal = Number(ui.waterBudgetInput.value);
  
  if (Number.isNaN(poolVal)) return alert("请输入有效的奖池金额");
  if (Number.isNaN(waterVal)) return alert("请输入有效的放水金额");

  if (!confirm(`确定保存吗？`)) return;
  try {
    await adminApi("/api/admin/pool", {
      method: "POST",
      body: { prizePool: poolVal, waterBudget: waterVal }
    });
    ui.prizePoolInput.blur();
    ui.waterBudgetInput.blur();
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

ui.forceForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const val = Number(ui.forceMultiplier.value);
  try {
    await adminApi("/api/admin/force-crash", {
      method: "POST",
      body: { multiplier: val || null }
    });
    ui.forceMultiplier.value = "";
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

ui.pauseButton.addEventListener("click", async () => {
  try {
    await adminApi("/api/admin/pause", { method: "POST" });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

ui.clearMetricsButton.addEventListener("click", async () => {
  if (!confirm("确定要清理全服的平台盈亏和周期统计数据吗？此操作不可撤销，且会重新开始计算 RTP。")) return;
  try {
    await adminApi("/api/admin/clear-metrics", { method: "POST" });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

ui.clearRoundsButton.addEventListener("click", async () => {
  if (!confirm("确定要清理所有回合的历史记录吗？数据看板也将被清空！")) return;
  try {
    await adminApi("/api/admin/clear-rounds", { method: "POST" });
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

ui.refreshButton.addEventListener("click", () => {
  refresh({ forceSettings: true });
});

ui.analyticsRefreshButton.addEventListener("click", () => {
  refresh();
});

[ui.analyticsDateFrom, ui.analyticsDateTo, ui.analyticsPlayerSelect].forEach((el) => {
  el.addEventListener("change", () => {
    refresh();
  });
});

document.addEventListener("click", (e) => {
  if (e.target.matches("button[data-user-select]")) {
    const playerId = e.target.getAttribute("data-user-select");
    ui.analyticsPlayerSelect.value = playerId;
    refresh();
  }
});

ui.playerSearch.addEventListener("input", renderPlayers);

initTabs();
refresh({ forceSettings: true }).then(() => {
  startPolling();
});
