# Rocket Crash Platform

这是一个完整的演示版 Rocket / Crash 多人实时下注游戏，包含玩家端、后台管理、实时倍率推送、下注/提现/结算、积分余额、回合历史和可验证公平基础信息。

默认实现是积分币/演示币版本，不包含真实资金、支付通道或合规风控。真实资金上线前需要补充 KYC、AML、地区合规、支付审计、风控、限额、异常监控和独立安全审计。

## 功能

- 玩家端：登录、余额、下注、自动提现、手动提现、实时倍率、下注列表、历史回合。
- 后台端：管理员登录、运营指标、玩家余额调整、游戏参数、暂停/恢复、强制爆炸、回合记录。
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
PORT=3000 ADMIN_PASSWORD=change-me node server.js
```

Windows PowerShell：

```powershell
$env:PORT="3000"
$env:ADMIN_PASSWORD="change-me"
node server.js
```

访问：

- 玩家端：http://localhost:3000/
- 后台端：http://localhost:3000/admin

默认后台密码是 `admin123`。只适合本地演示，请通过 `ADMIN_PASSWORD` 修改。

## 公平性复算

爆炸点由服务端种子和 nonce 计算：

1. 回合开始前公开 `serverSeedHash = sha256(serverSeed)`。
2. 回合结束后公开 `serverSeed`、`nonce`、`hmac`。
3. 使用 `HMAC_SHA256(serverSeed, nonce)` 得到随机数，再按后台 house edge 和上限计算 crash multiplier。

后台“强制爆炸”会把该局标记为 `forced`，这类回合不应参与公平性验证。

## 生产化待办

- 把 JSON 持久化替换为 PostgreSQL/MySQL，并使用事务锁保护下注、扣款和提现。
- 接入账号系统、设备指纹、限额、风控规则和完整审计日志。
- 后台管理启用 RBAC、2FA、登录限速和操作复核。
- 所有资金相关接口使用整数分单位，补全幂等键和账变流水。
- 使用反向代理启用 HTTPS、CSP、安全 Cookie 和请求限流。
