# Rocket Crash Platform 技术设计

## 1. 架构概览

项目使用 Node.js 原生模块实现，不依赖外部运行时框架。

```text
Browser
  index.html + app.js + styles.css
  admin.html + admin.js + styles.css
        |
        | HTTP API
        | WebSocket /ws
        v
server.js
  HTTP or HTTPS static server
  JSON API router
  WebSocket or WSS event broadcaster
  round state machine
  local JSON persistence
        |
        v
data/db.json
```

## 2. 运行时模块

- `server.js`：HTTP / HTTPS 服务、WebSocket / WSS 服务、游戏状态机、结算、后台接口。
- `public/app.js`：玩家端状态渲染、WebSocket 事件处理、本地倍率计算、下注和提现请求。
- `public/admin.js`：后台轮询、参数保存、玩家管理、强制爆炸和暂停恢复。
- `public/styles.css`：玩家端和后台端样式。
- `data/db.json`：本地持久化数据。

## 3. 数据模型

### 3.1 Settings

核心字段：

| 字段 | 说明 |
| --- | --- |
| `bettingDurationMs` | 每局下注等待时间 |
| `roundPauseMs` | 兼容展示字段，当前固定为 3000ms 爆炸停留 |
| `minBetCents` / `maxBetCents` | 真实玩家下注上下限 |
| `betTiersCents` | 筹码档位 |
| `demoCreditCents` | 新玩家初始积分 |
| `prizePoolCents` | 奖池余额 |
| `houseEdgeBps` | 平台优势，100 bps = 1% |
| `instantCrashBps` | 1.00x 即爆概率 |
| `maxCrashMultiplier` | 普通随机爆点上限 |
| `curveEarlyTargetMs` | 飞行曲线约多少毫秒到 20x |
| `curveEarlyPower` | 20x 前慢启动程度 |
| `curveLateSpeedMs` | 20x 后加速速度 |
| `botMinCount` / `botMaxCount` | 每局机器人数量范围 |
| `botBetIntervalMinMs` / `botBetIntervalMaxMs` | 机器人下注间隔范围 |
| `botMinBetCents` / `botMaxBetCents` | 机器人下注金额范围 |
| `botOnlyHighFlightBps` | 纯机器人高飞触发概率 |
| `botOnlyHighFlightMin` / `botOnlyHighFlightMax` | 纯机器人高飞倍率范围 |
| `paused` | 是否暂停开新局 |

### 3.2 Player

核心字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 玩家 ID |
| `username` | 后台可见的真实昵称 |
| `balanceCents` | 玩家积分余额 |
| `tutorialCompletedAt` | 新手引导完成或跳过时间，`null` 表示首次进入仍需自动展示 |
| `createdAt` / `updatedAt` / `lastSeenAt` | 创建、更新和最近登录时间 |

玩家端登录后使用服务器返回的 `tutorialCompleted` 判断是否自动展示新手引导。规则弹窗中的手动重播只播放前端演示，不会清空 `tutorialCompletedAt`。

新手引导是前端内的交互式模拟状态机，不会创建真实下注，也不会改动真实余额或真实回合。完成流程包括选择筹码、点击下注、手动 Cash Out、观看爆炸、开启 Auto Cashout、放置自动提现模拟注单和服务端自动跳出的讲解。

### 3.3 Round

核心字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 回合 ID |
| `nonce` | 递增局号，用于公平性计算 |
| `phase` | `betting` / `flying` / `crashed` |
| `seedHash` | 开局公开的 serverSeed 哈希 |
| `serverSeed` | 爆炸后公开的种子 |
| `hmac` | HMAC 结果 |
| `crashMultiplier` | 服务端预设爆点 |
| `currentMultiplier` | 服务端当前倍率快照 |
| `bettingEndsAt` | 下注截止时间 |
| `launchAt` | 起飞时间 |
| `crashedAt` | 爆炸时间 |
| `nextRoundAt` | 下一局开始时间 |
| `bets` | 本局下注 |
| `botPlan` | 本局机器人下注计划 |
| `forced` | 是否后台强制爆炸 |
| `poolCapped` | 是否被奖池上限压低爆点 |

### 3.4 Bet

| 字段 | 说明 |
| --- | --- |
| `playerId` | 真实玩家 ID 或 bot ID |
| `username` | 真实昵称或机器人名 |
| `isBot` | 是否机器人 |
| `amountCents` | 下注金额 |
| `autoCashout` | 自动提现倍率 |
| `status` | `open` / `cashed` / `lost` |
| `cashoutMultiplier` | 实际跳出倍率 |
| `payoutCents` | 返还金额 |
| `placedAt` | 下注时间 |
| `settledAt` | 结算时间 |

## 4. 回合状态机

```text
createRound()
  phase = betting
  generate seed, hash, nonce, crashMultiplier
  create botPlan
  broadcast round_start

betting
  accept human bets
  place due bot bets by interval
  broadcast bet_placed

when Date.now() >= bettingEndsAt
  startFlying()
  phase = flying
  launchAt = Date.now()
  broadcast flight_start

flying
  currentMultiplier = curveMultiplier(elapsedMs)
  process auto cashouts
  if currentMultiplier >= crashMultiplier
    finishRound()

crashed
  settle remaining open bets as lost
  persist round history
  broadcast crash
  keep currentRound and public bets visible for 3000ms
  then set currentRound = null
  createRound()
  new betting countdown starts from the new round's bettingEndsAt
```

下注截止时不会再调用机器人补下注。机器人必须在自己的 `placeAt` 到达时下注。

## 5. 飞行倍率公式

服务端和前端使用同一条分段倍率公式，默认目标是让火箭约 35 秒飞到 20x，20x 之后再加速：

```text
targetMultiplier = 20
earlyTargetMs = curveEarlyTargetMs
earlyPower = curveEarlyPower
earlyLinearWeight = 0.02
lateSpeedMs = curveLateSpeedMs

if elapsedMs <= earlyTargetMs:
  progress = elapsedMs / earlyTargetMs
  easedProgress = earlyLinearWeight * progress + (1 - earlyLinearWeight) * progress ^ earlyPower
  currentMultiplier = 1 + (targetMultiplier - 1) * easedProgress
else:
  currentMultiplier = targetMultiplier * exp((elapsedMs - earlyTargetMs) / lateSpeedMs)

currentMultiplier = floor(currentMultiplier * 100) / 100
```

解释：

- `elapsedMs` 是火箭起飞后经过的毫秒数。
- 20x 前使用慢启动幂函数。`progress ^ earlyPower` 会让起步更慢，越接近 20x 越追上目标。
- `earlyLinearWeight = 0.02` 是固定保护项，表示前段进度里有 2% 按线性推进，用来保证起飞后倍率会逐步从 `1.00x` 变成 `1.01x`。
- 20x 后使用指数函数，让高倍不要拖太久。
- `floor(... * 100) / 100` 是向下保留两位小数。

默认参数：

```text
curveEarlyTargetMs = 35000
curveEarlyPower = 2.4
earlyLinearWeight = 0.02
curveLateSpeedMs = 12000
```

默认效果大约是：

| 倍率 | 时间 |
| --- | --- |
| 1.01x | 0.8 秒 |
| 2x | 9.9 秒 |
| 5x | 18.1 秒 |
| 10x | 25.5 秒 |
| 20x | 35 秒 |
| 50x | 46 秒 |
| 100x | 54 秒 |
| 500x | 74 秒 |

配置方法：

- `curveEarlyTargetMs`：20x 到达时间。越大，20x 以前整体越慢；建议 `30000` 到 `45000`。
- `curveEarlyPower`：20x 前慢启动程度。越大，1x 到 5x 越慢，但越靠近 20x 会追上；建议 `2.0` 到 `3.2`。
- `curveLateSpeedMs`：20x 后加速速度。越小，高倍越快；建议 `9000` 到 `16000`。
- 已经起飞的回合会冻结当局曲线参数，后台保存的新参数从下一次起飞开始完整生效。

爆炸判断：

```text
currentMultiplier >= crashMultiplier
```

服务端判断爆炸和提现，前端计算只用于显示。

玩家端显示会额外减去 1 秒缓冲：

```text
if serverNow - launchAt < 1000:
  show "Starting Soon!"
else:
  displayElapsedMs = serverNow - launchAt - 1000
  displayMultiplier = curveMultiplier(displayElapsedMs)
  readoutMultiplier = smoothToward(displayMultiplier)
```

飞行中的大倍率文字使用 `requestAnimationFrame` 平滑刷新，低倍阶段每帧最多推进 `0.01x`，避免从 `1.13x` 直接跳到 `1.15x` 这类视觉跳变。

这只影响画面和按钮文案，不影响服务端爆炸、手动提现或自动提现结算。目的在于让画面比服务端权威时间保守一些，降低网络延迟造成的“画面飞过爆点后才收到爆炸”的观感。

前端显示保护：

```text
displayMultiplier = clamp(currentMultiplier, 1, maxDisplayMultiplier)
```

- `maxDisplayMultiplier` 由服务端公开，取后台最大倍率和纯机器人高飞倍率范围的最大值。
- 如果浏览器错过爆炸事件、系统休眠后恢复，或本地时间差导致 `elapsedMs` 异常变大，前端不会显示 `Infinityx`。
- 当飞行时间超过理论显示上限后，前端会主动请求 `/api/state`，用服务端权威状态校准当前回合。

## 6. 视觉轨迹公式

玩家端把倍率转换为画面进度：

```text
progress = clamp(log(currentMultiplier) / log(12), 0, 1)
x = left + progress * width
y = bottom - progress^1.45 * height
```

解释：

- `progress` 把倍率压缩到 0 到 1 的屏幕比例。
- `log` 避免高倍时火箭快速飞出屏幕。
- `progress^1.45` 让起步更平缓，后段抬升更明显。
- 这只是视觉轨迹，不参与输赢结算。

## 7. 爆点生成

### 7.1 种子

```text
serverSeed = random 32 bytes
serverSeedHash = sha256(serverSeed)
```

开局前只公开 `serverSeedHash`，爆炸后才公开 `serverSeed`。

### 7.2 随机数

```text
hmac = HMAC_SHA256(serverSeed, nonce)
sample = first 13 hex chars of hmac
random = sample / 0x10000000000000
```

`random` 是 0 到 1 之间的小数。

### 7.3 1.00x 即爆

```text
instantCrashChance = instantCrashBps / 10000
if random < instantCrashChance:
  crashMultiplier = 1.00
```

`100 bps = 1%`。

### 7.4 普通爆点

```text
adjustedRandom = (random - instantCrashChance) / (1 - instantCrashChance)
houseFactor = 1 - houseEdgeBps / 10000
rawCrash = houseFactor / (1 - adjustedRandom)
crashMultiplier = floor(rawCrash * 100) / 100
crashMultiplier = clamp(crashMultiplier, 1.01, maxCrashMultiplier)
```

解释：

- `houseEdgeBps` 控制平台优势。
- `adjustedRandom` 排除即爆区间后重新归一化。
- 高倍来自 `1 - adjustedRandom` 很小的情况，因此低概率出现。
- 普通爆点最低是 `1.01x`。
- `1.00x` 只由 `instantCrashBps` 控制。

## 8. 奖池承受上限

真实玩家下注和 Cash Out 后，服务端计算剩余未结算真实玩家下注最多能承受多少倍：

```text
poolCapMultiplier = prizePool / humanOpenBetAmount
effectiveCrashMultiplier = min(randomCrashMultiplier, poolCapMultiplier, maxCrashMultiplier)

if currentMultiplier >= effectiveCrashMultiplier:
  finishRound()
```

规则：

- 只统计真实玩家未结算下注。
- 机器人下注不进入奖池，也不影响奖池上限。
- 若真实玩家下注总额为 100，奖池为 1000，奖池最多承受 10x。
- 如果随机爆点为 25x，真实爆点会被压到 10x。
- 如果玩家陆续 Cash Out，奖池余额和未结算下注额都会变化，服务端必须重新计算有效爆点。
- 奖池不足不能作为合法下注或合法 Cash Out 的直接拒绝理由；风险通过有效爆点提前爆炸控制。

## 9. 返还公式

提现成功：

```text
payout = betAmount * cashoutMultiplier
```

返还包含本金。

自动提现判断：

```text
autoCashout < crashMultiplier
currentMultiplier >= autoCashout
```

Auto Cashout 是服务端结算逻辑。前端只在下注时提交 `autoCashout` 目标倍率，后续不需要再发送提现请求。服务端每个 tick 会先结算所有 `autoCashout < crashMultiplier` 且已到达目标倍率的注单，再判断爆炸，避免离散 tick 同时跨过自动跳出点和爆点时漏结算。如果自动提现倍率大于或等于爆点，则爆炸优先，自动提现失败。

延迟提示：

- 玩家端通过 WebSocket ping/pong 统计当前 RTT。
- RTT 超过 1000ms 时，延迟显示变红。
- RTT 超过 1000ms 且玩家准备下注时，前端弹出确认框，提示手动 Cash Out 可能因为显示延迟失败，并建议使用 Auto Cashout。

## 10. 机器人调度

每局创建机器人计划：

```text
count = randomInt(botMinCount, botMaxCount)
placeOffset = 350ms
for each bot:
  placeAt = roundCreatedAt + placeOffset
  placeOffset += randomInt(botBetIntervalMinMs, botBetIntervalMaxMs)
```

调度保护：

- 机器人不会在起飞前最后一刻统一补下注。
- 如果数量多、间隔大，服务端会按下注窗口和最小间隔计算最多可排数量。
- 只有到达 `placeAt` 的机器人会下注并推送 `bet_placed`。

## 11. 实时通信设计

玩家端使用 WebSocket：

```text
/ws?playerId=...
```

如果页面通过 HTTPS 打开，浏览器会自动连接 `wss://host/ws`；如果页面通过 HTTP 打开，则连接 `ws://host/ws`。服务端配置证书后可以直接提供 HTTPS 和 WSS。

事件驱动：

- 连接后推完整 `snapshot`。
- 新局推完整 `round_start`。
- 每次下注推增量 `bet_placed`，只包含新增 `bet`。
- 起飞推增量 `flight_start`，只包含 `roundId`、`launchAt` 和曲线参数。
- Cash Out 推增量 `cashout`，只包含状态变化后的 `bet`。
- 爆炸推完整 `crash`，作为本局最终结算同步点。
- 后台参数变更推 `settings_updated`。
- 当前玩家余额变更推 `player_update`。

飞行中不持续推送倍率。前端收到 `flight_start.launchAt` 后本地计算倍率显示。增量事件应用失败时，前端会拉取 `/api/state` 做一次完整校准。

延迟显示使用 WebSocket ping/pong，不再依赖 HTTP `/api/ping` 定时请求。前端收到服务端时间后，用浏览器单调时钟 `performance.now()` 推进 `serverNow()`，不依赖用户本机系统时间。页面从后台恢复、重新获得焦点或 bfcache 恢复时，会强制发送一次 ping 并拉取 `/api/state` 校准当前回合。

## 12. 持久化

当前使用 `data/db.json` 保存：

- 设置。
- 玩家。
- 回合历史。
- 公平性 nonce。
- 审计日志。

本地 JSON 适合 MVP 和单机演示，不适合生产并发资金系统。
