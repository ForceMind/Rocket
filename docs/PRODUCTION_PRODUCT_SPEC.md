# Rocket Crash 生产版产品文档

## 1. 产品定位

Rocket Crash 是一个实时多人倍率下注游戏。每一局开始前，玩家选择一个下注筹码；火箭起飞后，倍率随服务器时间增长；玩家需要在火箭爆炸前 Cash Out。成功 Cash Out 的玩家按跳出倍率获得返还；没有在爆炸前跳出的玩家损失本局下注。

本文档面向开发、测试、运营和风控人员，定义生产版本的玩法规则、服务端权威逻辑、运营配置、结算规则和数学公式。

## 2. 角色

| 角色  | 说明                                             |
| --- | ---------------------------------------------- |
| 玩家  | 参与下注、手动 Cash Out、设置 Auto Cashout、查看余额和记录。      |
| 运营  | 通过后台配置局时长、下注限制、奖池、爆点参数、飞行曲线、机器人和风险控制。          |
| 服务端 | 唯一权威来源，负责生成回合、计算爆点、校验下注、结算 Cash Out、更新奖池和推送事件。 |
| 前端  | 展示实时状态和动画，不能决定爆点、倍率、结算结果或余额变化。                 |
| 机器人 | 可选的虚拟玩家，用于展示活跃度；机器人金额不计入真实奖池、平台盈亏和真实下注额。       |

## 3. 核心术语

| 术语                 | 说明                            |
| ------------------ | ----------------------------- |
| Round              | 一局游戏，从下注开放开始，到爆炸结算结束。         |
| Betting            | 下注阶段，玩家可下注，火箭未起飞。             |
| Flying             | 起飞阶段，倍率按服务器时间增长，玩家可 Cash Out。 |
| Crashed            | 爆炸阶段，本局结算完成，等待进入下一局。          |
| Bet                | 玩家在一局中的下注。每名玩家每局最多一笔下注。       |
| Crash Multiplier   | 本局爆点倍率。玩家不能提前在前端看到。           |
| Current Multiplier | 当前服务器倍率，由起飞时间和飞行曲线计算。         |
| Manual Cash Out    | 玩家手动点击 Cash Out。              |
| Auto Cashout       | 玩家下注时提交目标倍率，服务端在达到目标后自动跳出。    |
| Prize Pool         | 奖池余额，用于覆盖真实玩家返还。              |
| House Profit       | 平台盈亏，只统计真实玩家下注和真实玩家返还。        |
| Seed Hash          | 回合开始时公开的服务端种子哈希，用于公平性校验。      |

## 4. 金额和单位

- 服务端内部所有金额使用最小货币单位整数保存，记为 `cents`。
- 前端和后台展示金额时使用普通数字，保留两位小数。
- 倍率统一保留两位小数。
- 概率配置使用 basis points，记为 `bps`。`10000 bps = 100%`，`150 bps = 1.5%`。
- 所有结算以服务端时间为准。前端显示时间只用于动画和提示。

数学表示：

```text
amountCents = round(amount * 100)
amount = amountCents / 100
probability = bps / 10000
```

## 5. 玩家玩法规则

### 5.1 进入游戏

玩家进入游戏后由账户系统或钱包系统提供玩家身份和余额，游戏服务只使用可信玩家 ID 和余额数据。

### 5.2 下注

下注只允许在 `Betting` 阶段进行。

下注规则：

- 下注金额必须大于等于最小下注。
- 下注金额必须小于等于最大下注。
- 下注金额必须匹配运营配置的筹码档位。
- 玩家余额必须足够。
- 每名玩家每局最多下注一次。
- 下注成功后，立即从玩家余额扣除下注金额。
- 真实玩家下注金额立即加入奖池。
- 下注成功后，该注单状态为 `open`。
- 下注不会因为奖池上限不足直接拒绝；奖池风险通过降低本局实际爆点控制。

数学表示：

```text
A = betAmountCents
balance >= A
minBetCents <= A <= maxBetCents
A in betTiersCents
player has no bet in current round

balanceAfterBet = balanceBeforeBet - A
prizePoolAfterBet = prizePoolBeforeBet + A
```

### 5.3 手动 Cash Out

手动 Cash Out 只允许在 `Flying` 阶段进行。

服务端收到请求后必须重新计算当前倍率，不允许使用前端提交或前端显示的倍率。

成功条件：

- 当前回合处于 `Flying`。
- 玩家存在本局 `open` 注单。
- 服务端当前倍率小于本局爆点。

失败条件：

- 未起飞或已经爆炸。
- 玩家没有本局未结算注单。
- 服务端当前倍率大于或等于爆点。
- 如果剩余奖池已经不足以支撑当前倍率，服务端应先通过奖池上限触发爆炸，而不是拒绝 Cash Out。

数学表示：

```text
M = currentMultiplier(serverNow)
C = crashMultiplier

manual cashout succeeds if:
round.phase = Flying
bet.status = open
M < C

manual cashout fails if:
M >= C
```

### 5.4 Auto Cashout

玩家下注时可以提交 Auto Cashout 目标倍率。前端只负责提交目标倍率，服务端负责自动结算。

规则：

- Auto Cashout 默认关闭。
- 目标倍率必须大于等于 `1.01x`。
- 目标倍率不能超过运营配置的最大倍率。
- 只要目标倍率低于本局爆点，且服务器当前倍率已经达到目标倍率，服务端必须在爆炸前结算。
- 若目标倍率大于或等于爆点，本局 Auto Cashout 失败，注单在爆炸时结算为 lost。
- 服务端每个 tick 必须先处理满足条件的 Auto Cashout，再判断爆炸，避免一次 tick 同时跨过自动跳出点和爆点时漏结算。

数学表示：

```text
T = autoCashout
C = crashMultiplier
M = currentMultiplier(serverNow)

auto cashout succeeds if:
bet.status = open
T < C
M >= T

auto cashout fails if:
T >= C
```

### 5.5 爆炸结算

当服务端当前倍率大于或等于本局爆点时，本局爆炸。

爆炸时：

- 所有仍为 `open` 的真实玩家注单结算为 `lost`。
- 所有仍为 `open` 的机器人注单结算为 `lost`。
- 爆点、服务端种子和 HMAC 在回合结束后公开。
- 回合记录写入历史。
- 页面保留爆炸结果一段时间后进入下一局。

数学表示：

```text
if currentMultiplier(serverNow) >= crashMultiplier:
  round.phase = Crashed
  for each bet where status = open:
    status = lost
    payoutCents = 0
```

### 5.6 前端信息展示规则

玩家端展示必须遵循以下规则：

- 玩家列表显示脱敏昵称，不显示完整真实昵称。
- 脱敏昵称保留前两个字符，后续用 `**` 替代。
- 玩家列表下注金额必须显示为配置的筹码档位。
- 下注阶段玩家列表按下注时间升序显示。
- 起飞后玩家列表按下注金额降序显示；金额相同按下注时间升序显示。
- 玩家 Cash Out 后，列表状态必须实时变为返还金额。
- 玩家本人区域必须显示本局下注状态、下注金额、Auto Cashout 状态和最终输赢。
- 上方可展示历史爆点，但不能在本局爆炸前展示本局爆点。
- 玩家端不展示本局未公开的 seed、HMAC 或 Hash。
- 玩家端可提供个人下注历史入口，历史只展示该玩家自己的下注记录。

数学表示：

```text
displayName = firstTwoChars(username) + "**"

if phase = Betting:
  playerListOrder = sortBy(placedAt asc)
else:
  playerListOrder = sortBy(amount desc, placedAt asc)
```

## 6. 回合状态机

### 6.1 状态

| 状态      | 玩家可下注 | 玩家可 Cash Out | 服务端动作                            |
| ------- | ----- | ------------ | -------------------------------- |
| Betting | 是     | 否            | 接收下注，安排机器人下注，倒计时到起飞。             |
| Flying  | 否     | 是            | 按服务器时间计算倍率，处理 Auto Cashout，判断爆炸。 |
| Crashed | 否     | 否            | 结算未跳出注单，公开公平性数据，写入历史。            |

### 6.2 状态流转

自然语言：

1. 没有当前回合且游戏未暂停时，服务端创建新回合。
2. 新回合进入 `Betting`，生成本局服务端种子、nonce、爆点、种子哈希和机器人计划。
3. `Betting` 倒计时结束后，回合进入 `Flying`，记录 `launchAt`。
4. `Flying` 阶段服务端按固定 tick 推进状态。
5. 每个 tick 先计算当前倍率，再处理 Auto Cashout，再判断是否爆炸。
6. 爆炸后进入 `Crashed`，结算并公开结果。
7. 爆炸结果停留固定时间后，服务端创建下一局。

数学表示：

```text
createdAt = serverNow
bettingEndsAt = createdAt + bettingDurationMs

if serverNow >= bettingEndsAt:
  phase = Flying
  launchAt = serverNow

elapsedMs = serverNow - launchAt
currentMultiplier = multiplierFromElapsed(elapsedMs)

tick order:
  1. currentMultiplier = multiplierFromElapsed(serverNow - launchAt)
  2. processAutoCashouts(currentMultiplier)
  3. if currentMultiplier >= crashMultiplier: finishRound()

nextRoundAt = crashedAt + crashHoldMs
```

## 7. 爆点生成规则

### 7.1 自然语言说明

每局开始时，服务端生成一个随机 `serverSeed`，并使用递增的 `nonce` 计算 HMAC。HMAC 的前 13 个十六进制字符作为随机样本，转换成 `0` 到 `1` 之间的随机数。

爆点生成分为三步：

1. 先判断是否命中 `1.00x` 即爆的概率。
2. 如果没有命中，将剩余随机数映射到普通爆点分布。
3. 使用平台边际参数降低理论返还，并将结果限制在最大爆点以内。

回合开始时只公开 `serverSeedHash`，不公开 `serverSeed`、HMAC 和爆点。回合爆炸后公开 `serverSeed` 和 HMAC，外部可以复算本局爆点。

### 7.2 数学公式

变量：

```text
S = serverSeed
N = nonce
H = HMAC_SHA256(S, String(N))
X = integer(first 13 hex chars of H)
D = 0x10000000000000 = 16^13
U = clamp(X / D, Number.EPSILON, 1 - Number.EPSILON)
p0 = clamp(instantCrashBps / 10000, 0, 1)
h = clamp(1 - houseEdgeBps / 10000, 0.5, 1)
maxC = maxCrashMultiplier
```

若命中 `1.00x`：

```text
if U < p0:
  C = 1.00
```

若未命中：

```text
U' = (U - p0) / (1 - p0)
raw = h / (1 - U')
floored = floor(raw * 100) / 100
C0 = max(1.01, floored)
C = clamp(C0, 1.01, maxC)
```

说明：

- `instantCrashBps` 控制 `1.00x` 爆炸概率。
- `houseEdgeBps` 控制平台边际，数值越高，整体爆点越低。
- `maxCrashMultiplier` 是普通随机爆点的上限。
- 奖池上限会在下注和真实玩家 Cash Out 后动态影响本局实际爆点。

## 8. 奖池和风险控制

### 8.1 自然语言说明

奖池用于限制平台最大赔付风险。真实玩家下注加入奖池，真实玩家 Cash Out 从奖池扣除。机器人不影响奖池。

奖池不作为玩家侧的拒绝理由。玩家不知道奖池余额，也不知道奖池如何影响爆点。服务端需要在后台持续计算剩余未逃跑真实玩家的最大可赔付倍率，并用该倍率控制本局实际爆点。

如果随机爆点高于奖池可承受上限，本局实际爆点应降为奖池可承受上限。火箭起飞后，每当真实玩家 Cash Out 后，剩余未逃跑玩家的总下注会变化，奖池余额也会变化，因此奖池可承受上限必须重新计算。若当前服务器倍率达到新的奖池上限，服务端应直接判定火箭爆炸，而不是在玩家 Cash Out 时返回“奖池不足”。

### 8.2 数学公式

变量：

```text
P = prizePoolCents
B = sum(open human bet amountCents)
maxC = maxCrashMultiplier
```

当前奖池可承受上限：

```text
if B <= 0:
  poolCap = randomCrashMultiplier
else:
  poolCap = clamp(floor((P / B) * 100) / 100, 1.00, maxC)
```

实际爆点：

```text
effectiveCrashMultiplier = min(randomCrashMultiplier, poolCap)
```

飞行中动态更新：

```text
after each human cashout:
  P = prizePoolCents after payout
  B = sum(remaining open human bet amountCents)
  poolCap = floor((P / B) * 100) / 100 if B > 0
  effectiveCrashMultiplier = min(randomCrashMultiplier, poolCap)

if currentMultiplier >= effectiveCrashMultiplier:
  crash round
```

### 8.3 运营要求

- 奖池余额必须可由后台手动设置。
- 平台盈亏和回合记录必须只统计真实玩家金额。
- 机器人下注和机器人返还不得进入奖池、总下注、总返还或平台盈亏。
- 奖池不足不能作为合法下注或合法 Cash Out 的直接拒绝理由。
- 奖池风险必须通过有效爆点控制：当前倍率达到奖池可承受上限时，服务端判定爆炸。
- 玩家端不得展示奖池如何影响爆点。

## 9. 飞行倍率曲线

### 9.1 自然语言说明

火箭起飞后，倍率根据起飞时间和服务器当前时间计算。曲线分为前段和后段：

- 前段从 `1.00x` 平滑增长到目标倍率 `20.00x`。
- 后段从 `20.00x` 开始按指数增长。
- 前端可以使用相同公式进行动画显示，但结算只以服务端计算结果为准。
- 前端显示可以故意延迟一段时间，用于降低用户看到“刚起飞长期停在 1.00x”的视觉问题；该延迟不影响服务端结算。

### 9.2 数学公式

变量：

```text
e = max(0, serverNow - launchAt)
T = 20
E = curveEarlyTargetMs
q = curveEarlyPower
w = 0.02
L = curveLateSpeedMs
maxC = max(maxCrashMultiplier, crashMultiplier)
```

前段曲线：

```text
if e <= E:
  p = e / E
  eased = w * p + (1 - w) * p^q
  rawMultiplier = 1 + (T - 1) * eased
```

后段曲线：

```text
if e > E:
  rawMultiplier = T * exp((e - E) / L)
```

服务端当前倍率：

```text
currentMultiplier = floor(clamp(rawMultiplier, 1, maxC) * 100) / 100
```

前端显示倍率：

```text
displayElapsed = max(0, serverNow - launchAt - displayLagMs)
displayMultiplier = multiplierFromElapsed(displayElapsed)
```

说明：

- `curveEarlyTargetMs` 越大，`1x` 到 `20x` 越慢。
- `curveEarlyPower` 越大，前段越慢，后段追赶越明显。
- `curveLateSpeedMs` 越大，超过 `20x` 后增长越慢。
- `displayLagMs` 只影响视觉显示，不影响手动 Cash Out 和 Auto Cashout 结算。

## 10. 返还和平台盈亏

### 10.1 返还计算

自然语言：

玩家成功 Cash Out 后，返还金额等于下注金额乘以结算倍率。结果向下取整到最小货币单位，避免超额支付。

数学表示：

```text
A = betAmountCents
M = cashoutMultiplier
m100 = round(M * 100)
payoutCents = floor(A * m100 / 100)
```

结算后：

```text
playerBalanceAfterCashout = playerBalanceBeforeCashout + payoutCents
prizePoolAfterCashout = prizePoolBeforeCashout - payoutCents
```

### 10.2 平台盈亏

自然语言：

平台盈亏只统计真实玩家金额。机器人金额只用于展示活跃度，不参与财务指标。

数学表示：

```text
humanTotalBet = sum(human bet amountCents)
humanTotalPayout = sum(human payoutCents)
houseProfit = humanTotalBet - humanTotalPayout
```

## 11. 机器人规则

### 11.1 自然语言说明

机器人是可选功能，用于展示多人下注和跳出效果。机器人不代表真实资金，不应影响真实奖池和平台财务数据。

每局创建时，服务端根据运营配置生成机器人计划。机器人会在下注阶段按间隔陆续下注，不应集中在起飞前最后一刻出现。

### 11.2 下注数量

数学表示：

```text
count = randomInt(botMinCount, botMaxCount)
firstPlaceMs = 350
latestPlaceMs = max(firstPlaceMs, bettingDurationMs - 1100)
maxSchedulableCount = floor((latestPlaceMs - firstPlaceMs) / botBetIntervalMinMs) + 1
scheduledCount = min(count, max(0, maxSchedulableCount))
```

### 11.3 下注时间

自然语言：

第一个机器人最早在本局创建后 `350ms` 下注。之后每个机器人按配置的最小和最大间隔随机安排时间，同时保证剩余机器人仍能在下注窗口内排完。

数学表示：

```text
placeOffset[0] = 350

for each next bot:
  remaining = scheduledCount - index - 1
  latestNextInterval = latestPlaceMs - placeOffset[index] - remaining * botBetIntervalMinMs
  maxNextInterval = max(botBetIntervalMinMs, min(botBetIntervalMaxMs, latestNextInterval))
  interval = randomInt(botBetIntervalMinMs, maxNextInterval)
  placeOffset[index + 1] = placeOffset[index] + interval
```

### 11.4 下注金额

自然语言：

机器人下注金额从运营配置的筹码档位中选择，并限制在机器人最小下注和最大下注之间。如果没有符合条件的筹码，则从所有筹码档位中选择。

数学表示：

```text
eligibleTiers = betTiersCents where botMinBetCents <= tier <= botMaxBetCents

if eligibleTiers is not empty:
  botAmount = randomChoice(eligibleTiers)
else:
  botAmount = randomChoice(betTiersCents)
```

### 11.5 机器人 Auto Cashout 分布

自然语言：

机器人跳出倍率按区间随机，用于制造不同风险偏好的行为。

数学表示：

```text
r = random number in [0, 1)

if r < 0.58:
  botAutoCashout = 1.15 + random() * 1.35
else if r < 0.88:
  botAutoCashout = 2.50 + random() * 3.50
else:
  botAutoCashout = 6.00 + random() * 14.00

botAutoCashout = round2(clamp(botAutoCashout, 1.01, maxCrashMultiplier))
```

### 11.6 纯机器人高倍率回合

自然语言：

如果本局只有机器人下注，没有真实玩家下注，运营可以配置一定概率让火箭飞到较高倍率区间，用于视觉效果。该规则只能在无真实玩家下注时生效。

数学表示：

```text
if botsEnabled
and currentRound has bets
and humanBetCount = 0
and random() < botOnlyHighFlightBps / 10000:
  crashMultiplier = randomMultiplier(botOnlyHighFlightMin, botOnlyHighFlightMax)
  botOnlyHighFlight = true
```

## 12. 公平性校验

### 12.1 回合开始

服务端在回合创建时：

- 生成 `serverSeed`。
- 读取并递增 `nonce`。
- 根据 `serverSeed` 和 `nonce` 计算本局 HMAC。
- 根据 HMAC 计算爆点。
- 对外公开 `seedHash = SHA256(serverSeed)`。
- 不公开 `serverSeed`、HMAC 和爆点。

数学表示：

```text
serverSeed = randomBytes(32)
nonce = currentNonce
currentNonce = currentNonce + 1
seedHash = SHA256(serverSeed)
hmac = HMAC_SHA256(serverSeed, String(nonce))
crashMultiplier = crashPointFor(serverSeed, nonce)
```

### 12.2 回合结束

回合爆炸后，服务端公开：

- `serverSeed`
- `hmac`
- `crashMultiplier`
- `nonce`
- `seedHash`

校验方可以：

1. 计算 `SHA256(serverSeed)`，确认等于回合开始公开的 `seedHash`。
2. 计算 `HMAC_SHA256(serverSeed, String(nonce))`，确认等于公开的 `hmac`。
3. 使用本文档爆点公式复算 `crashMultiplier`。

## 13. 服务端权威和前端显示

### 13.1 权威边界

服务端必须权威处理：

- 回合创建。
- 爆点生成。
- 当前倍率计算。
- 下注校验。
- 余额扣减。
- 手动 Cash Out 判定。
- Auto Cashout 判定。
- 奖池扣减。
- 爆炸结算。
- 历史记录。

前端只能处理：

- 页面展示。
- 动画。
- 用户输入。
- 根据服务端时间和曲线做预测显示。
- 展示服务端返回的余额、注单状态和回合结果。

### 13.2 服务端时间

前端不得依赖用户本地系统时间作为权威时间。生产版本应通过服务端时间戳校准前端显示时钟。

数学表示：

```text
serverNowForDisplay = lastServerTime + monotonicElapsedSinceLastSync
```

说明：

- `lastServerTime` 来自服务端 HTTP 响应头或 WebSocket 消息。
- `monotonicElapsedSinceLastSync` 应使用浏览器单调时钟。
- 页面从后台恢复时，前端应主动重新同步服务端状态。
- 即使前端显示落后，手动 Cash Out 仍按服务端当前真实倍率判定。

### 13.3 高延迟提示

当玩家网络延迟超过运营定义阈值时，前端应提示：

- 火箭显示可能落后。
- 手动 Cash Out 可能失败。
- 建议使用 Auto Cashout。

该提示不改变服务端结算规则。

## 14. 实时事件

生产版本应使用增量推送，避免飞行中持续推送倍率。

事件规则：

| 事件               | 推送时机            | 内容要求                 |
| ---------------- | --------------- | -------------------- |
| snapshot         | 连接后             | 当前设置、玩家、当前回合、历史记录。   |
| round_start      | 新局开始            | 完整当前回合和公开设置。         |
| bet_placed       | 玩家或机器人下注        | 只推新增注单。              |
| flight_start     | 起飞              | 只推回合 ID、起飞时间、曲线参数。   |
| cashout          | 玩家或机器人 Cash Out | 只推状态变化后的注单。          |
| crash            | 爆炸              | 推完整回合、爆点、公开公平性数据和历史。 |
| settings_updated | 后台配置变化          | 推公开设置。               |
| player_update    | 当前玩家余额变化        | 只推当前玩家数据。            |

飞行中倍率由前端根据 `launchAt` 和飞行曲线本地显示。服务端不需要持续推送倍率。

## 15. 后台运营配置

| 配置项                  | 说明              | 约束                   |
| -------------------- | --------------- | -------------------- |
| bettingDurationMs    | 下注阶段时长          | 建议 3000ms 到 30000ms。 |
| crashHoldMs          | 爆炸后结果停留时长       | 生产建议固定或后台可配。         |
| minBet               | 最小下注            | 必须大于 0。              |
| maxBet               | 最大下注            | 必须大于等于最小下注。          |
| betTiers             | 筹码档位            | 每个档位必须在最小和最大下注之间。    |
| initialBalance       | 新玩家初始余额         | 由生产账户或钱包策略决定。        |
| prizePool            | 奖池余额            | 不得小于 0。              |
| houseEdgeBps         | 平台边际            | 影响随机爆点分布。            |
| instantCrashBps      | `1.00x` 爆炸概率    | `0` 到 `10000`。       |
| maxCrashMultiplier   | 最大爆点            | 必须大于等于 `2.00x`。      |
| curveEarlyTargetMs   | 前段到达 `20x` 的时间  | 越大前段越慢。              |
| curveEarlyPower      | 前段曲线形状          | 越大前段越慢。              |
| curveLateSpeedMs     | 超过 `20x` 后的指数速度 | 越大后段越慢。              |
| botsEnabled          | 是否启用机器人         | 只影响展示。               |
| botMinCount          | 每局机器人最少数量       | 不得大于最大数量。            |
| botMaxCount          | 每局机器人最多数量       | 不得小于最少数量。            |
| botBetIntervalMinMs  | 机器人下注最小间隔       | 不得大于最大间隔。            |
| botBetIntervalMaxMs  | 机器人下注最大间隔       | 不得小于最小间隔。            |
| botMinBet            | 机器人最小下注         | 只影响机器人展示。            |
| botMaxBet            | 机器人最大下注         | 只影响机器人展示。            |
| botOnlyHighFlightBps | 纯机器人高倍率概率       | 只允许无真实玩家下注时生效。       |
| botOnlyHighFlightMin | 纯机器人高倍率下限       | 不得大于上限。              |
| botOnlyHighFlightMax | 纯机器人高倍率上限       | 不得小于下限。              |
| paused               | 暂停开新局           | 暂停后不创建新回合。           |

## 16. 后台操作

### 16.1 玩家余额调整

运营可对玩家余额进行加减调整。调整后余额不能为负数。所有调整必须进入审计日志。

数学表示：

```text
nextBalance = currentBalance + delta
require nextBalance >= 0
```

### 16.2 强制爆炸

强制爆炸用于运营干预或异常处理。生产版本必须记录 `forced = true`。

规则：

- 如果当前回合已经爆炸，不能强制爆炸。
- 如果处于下注阶段，强制爆炸前应先进入起飞阶段。
- 强制爆点不能低于当前服务器倍率。
- 强制爆点不能超过最大允许倍率。
- 有真实玩家未结算下注时，最大允许倍率还必须受奖池上限限制。

数学表示：

```text
currentM = currentMultiplier if phase = Flying else 1
maxAllowed = min(maxCrashMultiplier, prizePoolCap) if humanOpenBetCents > 0
maxAllowed = maxCrashMultiplier if humanOpenBetCents = 0

forcedCrash = clamp(requestedMultiplier, currentM, maxAllowed)
```

### 16.3 清理指标和回合记录

运营可以清理平台盈亏指标和回合记录。生产版本必须区分：

- 清理展示指标。
- 清理历史回合记录。
- 真实资金账务不得因展示清理而丢失。

## 17. 回合记录

回合结束后应保存：

- 回合 ID。
- nonce。
- seedHash。
- serverSeed。
- hmac。
- crashMultiplier。
- 是否强制爆炸。
- 是否奖池限制。
- 奖池限制倍率。
- 开始时间。
- 爆炸时间。
- 真实玩家总下注。
- 真实玩家总返还。
- 平台盈亏。
- 总人数。
- 真实玩家人数。
- 机器人人数。
- 真实玩家注单明细。

机器人注单不写入真实玩家注单明细，不计入金额指标。

## 18. 注单状态

| 状态     | 说明                  |
| ------ | ------------------- |
| open   | 已下注，未结算。            |
| cashed | 已成功 Cash Out。       |
| lost   | 爆炸时未 Cash Out，下注损失。 |

状态流转：

```text
open -> cashed
open -> lost
```

`cashed` 和 `lost` 为终态，不允许再次变更。

## 19. 关键验收标准

1. 玩家只能在下注阶段下注。
2. 玩家每局最多一笔下注。
3. 下注金额必须等于配置的筹码档位。
4. 真实玩家下注扣余额并进入奖池。
5. 手动 Cash Out 只按服务端当前倍率结算。
6. Auto Cashout 由服务端自动结算，前端不参与触发。
7. Auto Cashout 目标低于爆点时，必须保证在爆炸前结算。
8. 当前倍率达到或超过爆点时，所有 open 注单结算为 lost。
9. 奖池不能为负数。
10. 奖池风险必须通过动态爆点控制，不能通过向玩家暴露“奖池不足”来拒绝合法操作。
11. 随机爆点必须可通过公开的 serverSeed、nonce 和 HMAC 复算。
12. 爆点在回合爆炸前不能公开给玩家端。
13. 机器人金额不得计入奖池、真实总下注、真实总返还和平台盈亏。
14. 飞行中不得依赖持续倍率推送；前端显示倍率只能作为动画预测。
15. 前端不得使用用户本地系统时间作为结算依据。
16. 所有后台关键操作必须记录审计日志。
