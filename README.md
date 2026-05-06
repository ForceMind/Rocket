# Rocket Crash Platform

这是一个完整的演示版 Rocket / Crash 多人实时下注游戏，包含玩家端、后台管理、实时倍率推送、下注/提现/结算、积分余额、回合历史和可验证公平基础信息。

默认实现是积分币/演示币版本，不包含真实资金、支付通道或合规风控。真实资金上线前需要补充 KYC、AML、地区合规、支付审计、风控、限额、异常监控和独立安全审计。

## 功能

- 玩家端：登录、余额、下注、可选自动提现、手动提现、实时倍率、下注列表、历史回合。
- 后台端：本地免登录、运营指标、玩家余额调整、游戏参数、暂停/恢复、强制爆炸、回合记录。
- 机器人：每局自动生成机器人玩家，分批下注，并按各自自动提现倍率跳下。纯机器人局可按配置概率飞到 100-500 倍。
- 实时通信：使用 Server-Sent Events，无需外部依赖。
- 持久化：本地 JSON 文件 `data/db.json`，服务启动时自动创建。
- 公平性：每局提前公开 `serverSeedHash`，结束后公开 `serverSeed` 和 HMAC，便于复算爆炸点。

## 启动

在项目根目录双击：

```text
start-rocket.bat
```

或手动启动：

```bash
cd E:\Privy\Rocket
node server.js
```

可选环境变量：

```bash
PORT=3000 node server.js
```

Windows PowerShell：

```powershell
$env:PORT="3000"
node server.js
```

访问：

- 玩家端：http://localhost:3000/
- 后台端：http://localhost:3000/admin

后台默认是本地开发免登录。如果需要打开后台密码：

```powershell
$env:ADMIN_AUTH="1"
$env:ADMIN_PASSWORD="change-me"
node server.js
```

## OpenCloudOS 部署

把项目上传到服务器后，在项目目录执行：

```bash
sudo bash deploy-opencloudos.sh
```

部署脚本会做这些事：

- 检查并尝试安装 Node.js。
- 把项目部署到 `/opt/rocket-crash-platform`。
- 创建 systemd 服务 `rocket-crash`。
- 使用 `start-linux.sh` 启动服务。
- 自动选择可用端口。
- 如果 firewalld 正在运行，会开放端口范围。

默认端口规则：

```text
BASE_PORT=3000
MAX_PORT=3050
```

启动时会先尝试 `3000`，如果被占用就尝试 `3001`，一直递增到 `3050`。实际选中的端口会写入：

```text
/opt/rocket-crash-platform/data/runtime.env
```

自定义端口范围：

```bash
sudo BASE_PORT=3100 MAX_PORT=3150 bash deploy-opencloudos.sh
```

云服务器部署默认开启后台密码。如果不传 `ADMIN_PASSWORD`，脚本会自动生成一个并在部署结束时打印：

```bash
sudo ADMIN_PASSWORD='your-strong-password' bash deploy-opencloudos.sh
```

常用管理命令：

```bash
sudo systemctl status rocket-crash
sudo systemctl restart rocket-crash
sudo journalctl -u rocket-crash -f
```

如果只是 Linux 手动启动，不安装 systemd 服务：

```bash
BASE_PORT=3000 MAX_PORT=3050 bash start-linux.sh
```

## 后台功能说明

- 顶部指标：用于观察本地演示数据。总下注和总返还是历史回合累计，平台盈亏等于总下注减总返还，玩家余额是所有真实玩家当前积分合计。
- 当前回合：显示当前局状态、实时倍率、预设爆点和公平性 Hash。后台能看到爆点，玩家端飞行阶段看不到。
- 强制爆炸：本地测试用。留空会按当前倍率立即爆炸；填写倍率会把当前局爆点改成该值。这类回合会标记为 `forced`。
- 暂停/恢复：暂停后不再开新局；当前局如果已经开始，会按当前状态继续走完。
- 游戏参数：保存到 `data/db.json`。多数参数下一局完整生效，当前已经创建的回合不会全部重算。
- 玩家管理：只管理真实玩家。余额加减输入正数是加积分，输入负数是扣积分，用于本地测试补余额或修正余额。
- 回合记录：显示历史爆点、总下注、总返还和平台盈亏。带 `forced` 的回合不应作为公平随机局验证。
- 玩家端默认不显示 Hash。公平性数据仍由服务端保留，爆炸后会在接口数据里公开，后台可以查看。

## 飞行曲线

### 1. 飞行倍率

真实倍率按时间指数增长：

```text
currentMultiplier = exp(elapsedMs / 6500)
currentMultiplier = floor(currentMultiplier * 100) / 100
```

大白话解释：

- `elapsedMs` 是火箭起飞后过去了多少毫秒。
- `/ 6500` 是速度参数，数字越小，倍率涨得越快；数字越大，涨得越慢。
- `exp(...)` 是指数增长，所以刚开始涨得慢，后面会越来越快。
- `floor(currentMultiplier * 100) / 100` 是把倍率向下保留两位小数，比如 `1.239` 显示成 `1.23x`。
- 这条公式只决定当前飞到了多少倍，不决定爆点。

爆炸判断：

```text
currentMultiplier >= crashMultiplier
```

大白话解释：

- 当前倍率涨到或超过本局提前算好的爆点，火箭就爆炸。
- 玩家在这之前提现成功，之后就输掉本局下注。

普通随机局的最大爆点由后台 `最大倍率` 控制。默认是 `100x`，不是算法只能算到 `100x`；后台可以把它调高，服务端当前限制最高 `1000x`。

### 2. 前端视觉轨迹

前端画面为了让轨迹稳定，会把倍率转成 0 到 1 的进度：

```text
progress = clamp(log(currentMultiplier) / log(12), 0, 1)
x = left + progress * width
y = bottom - progress^1.45 * height
```

大白话解释：

- `progress` 是画面进度，`0` 表示左下角起飞，`1` 表示接近右上方。
- `log(currentMultiplier) / log(12)` 是把倍率压缩成适合屏幕显示的比例，避免高倍率一下飞出屏幕。
- `x` 随着 `progress` 增大一直往右走。
- `y` 用 `progress^1.45`，让火箭起步更平缓，后段抬升更明显。
- 这只是视觉显示公式，不参与结算。

火箭的视觉轨迹不会决定输赢，服务端的 `currentMultiplier >= crashMultiplier` 才会结算爆炸。

### 3. 爆点生成

每局开始时服务端先生成一个秘密种子：

```text
serverSeed = random 32 bytes
serverSeedHash = sha256(serverSeed)
```

大白话解释：

- `serverSeed` 是本局的秘密随机数。
- `serverSeedHash` 是这个秘密的指纹。
- 开局前只公开指纹，不公开秘密本身。
- 这样玩家可以知道服务端不能事后换种子，但也不能提前知道爆点。

用种子和局号生成随机数：

```text
hmac = HMAC_SHA256(serverSeed, nonce)
sample = first 13 hex chars of hmac
random = sample / 0x10000000000000
```

大白话解释：

- `nonce` 是递增局号，每局不同。
- `HMAC_SHA256` 会把 `serverSeed + nonce` 变成一串看起来随机的十六进制字符。
- 取前 13 位转成数字，再除以最大值，得到一个 `0` 到 `1` 之间的小数。
- 这个小数越接近 `1`，爆点越高；越接近 `0`，爆点越低。

先判断是否 1.00x 即爆：

```text
instantCrashChance = instantCrashBps / 10000
if random < instantCrashChance:
  crashMultiplier = 1.00
```

大白话解释：

- `instantCrashBps` 是后台可配置的 `1.00x` 即爆概率。
- `100 bps` 等于 `1%`，`150 bps` 等于 `1.5%`。
- 如果命中这个概率，火箭刚起飞就是 `1.00x` 爆炸。
- 没命中时，才进入普通爆点计算。

把随机数变成普通爆点：

```text
adjustedRandom = (random - instantCrashChance) / (1 - instantCrashChance)
houseFactor = 1 - houseEdgeBps / 10000
rawCrash = houseFactor / (1 - adjustedRandom)
crashMultiplier = floor(rawCrash * 100) / 100
crashMultiplier = clamp(crashMultiplier, 1.01, maxCrashMultiplier)
```

大白话解释：

- `houseEdgeBps` 是平台优势，默认 `150`，意思是 `1.5%`。
- `houseFactor = 0.985`，表示整体爆点会乘上 `98.5%`。
- `adjustedRandom` 是排除即爆概率之后重新拉伸出来的随机数。
- `1 - adjustedRandom` 越小，除出来的结果越大，所以高倍率会少见。
- `floor(... * 100) / 100` 是向下保留两位小数。
- 普通爆点最小是 `1.01x`，`1.00x` 只由“1.00 爆炸 bps”这个配置控制。
- `clamp(..., 1.01, maxCrashMultiplier)` 是限制普通爆点的上下限。

### 4. 下注返还

提现成功时：

```text
payout = betAmount * cashoutMultiplier
```

大白话解释：

- 下注 `100`，在 `2.35x` 提现，返还就是 `235`。
- 这里的返还包含本金，不是只算利润。
- 如果没提现就爆炸，返还是 `0`。

自动提现判断：

```text
autoCashout < crashMultiplier
currentMultiplier >= autoCashout
```

大白话解释：

- 自动提现倍率必须小于真实爆点，才有机会成功。
- 当前飞行倍率达到玩家设置的自动提现倍率时，系统自动帮玩家跳下。
- 如果爆点刚好小于或等于自动提现倍率，就会先爆炸，自动提现失败。
- 玩家端自动提现默认关闭，只有勾选 Auto Cashout 后才会提交自动提现倍率。

### 5. 纯机器人高飞

下注结束、火箭起飞前，服务端会检查本局是否只有机器人下注：

```text
if hasHumanBet:
  keep normal crashMultiplier
else if random < botOnlyHighFlightBps / 10000:
  crashMultiplier = random between botOnlyHighFlightMin and botOnlyHighFlightMax
```

大白话解释：

- 只要有真实玩家下注，就不启用这个逻辑，仍然使用公平随机爆点。
- 如果本局只有机器人，才会按后台 `纯机器人高飞 bps` 的概率触发。
- 触发后爆点会随机落在后台设置的高飞区间，默认是 `100x` 到 `500x`。
- 这用于本地演示气氛，不参与真实玩家公平局。

## 公平性复算

爆炸点由服务端种子和 nonce 计算：

1. 回合开始前公开 `serverSeedHash = sha256(serverSeed)`。
2. 回合结束后公开 `serverSeed`、`nonce`、`hmac`。
3. 使用 `HMAC_SHA256(serverSeed, nonce)` 得到随机数，再按后台 house edge 和上限计算 crash multiplier。

后台“强制爆炸”会把该局标记为 `forced`，这类回合不应参与公平性验证。

## 爆点传输

玩家端实时连接 `/events?playerId=...`，服务端通过 SSE 推送 `state` 事件。

下注和飞行阶段只推送：

```json
{
  "seedHash": "sha256(serverSeed)",
  "currentMultiplier": 1.42,
  "phase": "flying"
}
```

不会提前把 `crashMultiplier` 或 `serverSeed` 发给玩家端。

爆炸后才推送：

```json
{
  "phase": "crashed",
  "crashMultiplier": 2.31,
  "serverSeed": "...",
  "hmac": "..."
}
```

## 生产化待办

- 把 JSON 持久化替换为 PostgreSQL/MySQL，并使用事务锁保护下注、扣款和提现。
- 接入账号系统、设备指纹、限额、风控规则和完整审计日志。
- 后台管理启用 RBAC、2FA、登录限速和操作复核。
- 所有资金相关接口使用整数分单位，补全幂等键和账变流水。
- 使用反向代理启用 HTTPS、CSP、安全 Cookie 和请求限流。
