# Rocket Crash Platform 接口文档

## 1. 基础信息

默认地址：

```text
http://localhost:3000
```

如果配置 `HTTPS_CERT_PATH` 和 `HTTPS_KEY_PATH` 启动服务，基础地址变为：

```text
https://localhost:3000
```

数据格式：

- HTTP 请求体使用 JSON。
- HTTP 响应使用 JSON。
- 金额在接口输出中通常是普通数字，例如 `10`、`900.00`。
- 服务端内部金额使用 cents 整数保存。

错误格式：

```json
{
  "error": "错误说明"
}
```

## 2. 静态页面

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/` | 玩家端 |
| GET | `/manage` | 后台端，路径可通过 `ADMIN_PATH` 配置 |
| GET | `/favicon.ico` | 跳转到 `/favicon.svg` |

## 3. 玩家 API

### 3.1 获取状态

```text
GET /api/state?playerId=...
```

返回：

```json
{
  "now": 1778130000000,
  "settings": {},
  "player": {},
  "round": {},
  "history": [],
  "myHistory": []
}
```

说明：

- `playerId` 可选。
- 有 `playerId` 时返回当前玩家信息和本人历史。
- 玩家端 WebSocket 公网地址优先来自 `public/runtime-config.js` 中的 `window.ROCKET_CONFIG.publicWsUrl`。该值为空时，玩家端按当前页面地址自动生成 WebSocket 地址。

### 3.2 Ping

```text
GET /api/ping
```

返回：

```json
{
  "now": 1778130000000
}
```

说明：

- 该接口保留用于诊断。
- 玩家端延迟显示使用 WebSocket ping/pong，不再定时请求该 HTTP 接口。

### 3.3 玩家登录

```text
POST /api/player/login
```

请求：

```json
{
  "username": "Tester01"
}
```

返回：

```json
{
  "player": {
    "id": "player_...",
    "username": "Tester01",
    "balance": 1000,
    "createdAt": "2026-05-07T00:00:00.000Z"
  },
  "state": {}
}
```

规则：

- 昵称至少 2 个字符。
- 同名玩家会复用已有玩家记录。
- 新玩家获得后台配置的初始积分。

### 3.4 下注

```text
POST /api/bet
```

请求：

```json
{
  "playerId": "player_...",
  "amount": 100,
  "autoCashout": 2
}
```

规则：

- 只能在 `betting` 阶段下注。
- 每局每个玩家只能下注一次。
- `amount` 必须在最小下注和最大下注之间。
- `amount` 必须命中后台筹码档位。
- `autoCashout` 可为 `null`，表示不启用自动提现。
- 真实玩家下注会扣余额并进入奖池。

返回：

```json
{
  "bet": {},
  "player": {},
  "state": {}
}
```

### 3.5 Cash Out

```text
POST /api/cashout
```

请求：

```json
{
  "playerId": "player_..."
}
```

规则：

- 只能在 `flying` 阶段提现。
- 玩家必须有 `open` 状态下注。
- 服务端用服务器时间重新计算当前倍率。
- 当前倍率达到或超过爆点时，先爆炸，提现失败。
- 奖池余额不足时，提现失败。

返回：

```json
{
  "bet": {},
  "player": {},
  "state": {}
}
```

## 4. 后台 API

当前 MVP 后台免密码，`POST /api/admin/login` 返回本地 token 占位。

### 4.1 后台登录

```text
POST /api/admin/login
```

返回：

```json
{
  "token": "local-dev",
  "admin": {}
}
```

### 4.2 后台总览

```text
GET /api/admin/overview
```

返回：

```json
{
  "now": 1778130000000,
  "settings": {},
  "metrics": {},
  "currentRound": {},
  "players": [],
  "rounds": []
}
```

金额指标只统计真实玩家金额，机器人只统计数量。

### 4.3 保存参数

```text
POST /api/admin/settings
```

常用字段：

```json
{
  "bettingDurationMs": 7000,
  "roundPauseMs": 3500,
  "minBet": 10,
  "maxBet": 1000,
  "betTiers": "10,50,100,500,1000",
  "demoCredit": 1000,
  "prizePool": 100000,
  "houseEdgeBps": 150,
  "instantCrashBps": 150,
  "maxCrashMultiplier": 100,
  "botMinCount": 14,
  "botMaxCount": 34,
  "botBetIntervalMinMs": 100,
  "botBetIntervalMaxMs": 230,
  "botMinBet": 10,
  "botMaxBet": 500,
  "botOnlyHighFlightBps": 800,
  "botOnlyHighFlightMin": 100,
  "botOnlyHighFlightMax": 500,
  "paused": false
}
```

校验：

- `botMinCount <= botMaxCount`
- `botBetIntervalMinMs <= botBetIntervalMaxMs`
- `botOnlyHighFlightMin <= botOnlyHighFlightMax`
- `minBet <= maxBet`
- 下注档位会被过滤到下注上下限内。

### 4.4 调整玩家余额

```text
POST /api/admin/player-credit
```

请求：

```json
{
  "playerId": "player_...",
  "delta": 100
}
```

说明：

- 正数表示加积分。
- 负数表示扣积分。
- 调整后余额不能小于 0。

### 4.5 强制爆炸

```text
POST /api/admin/force-crash
```

请求：

```json
{
  "multiplier": 2.5
}
```

说明：

- `multiplier` 留空时按当前倍率立即爆炸。
- 有值时把当前局爆点调整到该倍率。
- 回合会标记为 `forced`。

### 4.6 暂停 / 恢复

```text
POST /api/admin/pause
```

请求：

```json
{
  "paused": true
}
```

说明：

- 暂停后不再创建新局。
- 当前已经进行中的回合继续走完。

### 4.7 维护操作

```text
POST /api/admin/maintenance
```

请求：

```json
{
  "action": "clear_metrics"
}
```

`action` 可选值：

- `clear_metrics`：清理顶部金额指标，让总下注、总返还和平台盈亏从当前时点重新统计，不删除玩家、奖池或回合记录。
- `clear_rounds`：删除历史回合记录，同时重置金额指标偏移，不删除玩家、奖池或当前回合。

## 5. WebSocket

连接：

```text
ws://localhost:3000/ws?playerId=player_...
```

HTTPS 页面会自动使用：

```text
wss://localhost:3000/ws?playerId=player_...
```

所有服务端消息格式：

```json
{
  "type": "event_name",
  "serverTime": 1778130000000,
  "data": {}
}
```

### 5.1 客户端发送 ping

```json
{
  "type": "ping",
  "clientTime": 1778130000000
}
```

服务端返回：

```json
{
  "type": "pong",
  "serverTime": 1778130000100,
  "data": {
    "clientTime": 1778130000000
  }
}
```

### 5.2 snapshot

连接成功后发送完整状态。

```json
{
  "type": "snapshot",
  "data": {
    "settings": {},
    "player": {},
    "round": {},
    "history": [],
    "myHistory": []
  }
}
```

### 5.3 round_start

新局开始。

```json
{
  "type": "round_start",
  "data": {
    "round": {},
    "settings": {}
  }
}
```

### 5.4 bet_placed

真实玩家或机器人下注。

```json
{
  "type": "bet_placed",
  "data": {
    "roundId": "round_...",
    "round": {},
    "bet": {}
  }
}
```

说明：

- 当前版本带上完整 `round`，前端收到后直接刷新列表。
- 机器人下注按后台间隔陆续触发。

### 5.5 flight_start

火箭起飞。

```json
{
  "type": "flight_start",
  "data": {
    "round": {
      "phase": "flying",
      "launchAt": 1778130000000
    },
    "curve": {
      "type": "exp",
      "speedMs": 6500
    }
  }
}
```

前端收到后本地计算倍率，不需要服务端持续推倍率。

### 5.6 cashout

有人成功跳出。

```json
{
  "type": "cashout",
  "data": {
    "roundId": "round_...",
    "round": {},
    "bet": {}
  }
}
```

说明：

- 带完整 `round`，保证列表状态实时更新。
- 玩家端会在曲线上显示跳出效果。

### 5.7 crash

火箭爆炸。

```json
{
  "type": "crash",
  "data": {
    "round": {},
    "history": [],
    "settings": {}
  }
}
```

爆炸后才公开 `crashMultiplier`、`serverSeed` 和 `hmac`。

### 5.8 settings_updated

后台参数变化。

```json
{
  "type": "settings_updated",
  "data": {
    "settings": {}
  }
}
```

### 5.9 player_update

当前玩家余额变化。

```json
{
  "type": "player_update",
  "data": {
    "player": {}
  }
}
```

### 5.10 my_history

当前玩家下注历史更新。

```json
{
  "type": "my_history",
  "data": {
    "myHistory": []
  }
}
```
