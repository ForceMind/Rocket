# Rocket Crash Platform

Rocket Crash Platform 是一个本地开发版 Rocket / Crash 多人实时下注演示项目，包含玩家端、后台管理、机器人、奖池、爆点算法、WebSocket 事件推送和 OpenCloudOS 部署脚本。

当前版本是积分币 / 演示币系统，不包含真实资金、支付通道、KYC、AML、地区合规、风控审核或后台权限系统。真实资金上线前必须补齐合规、审计、安全和风控能力。

## 文档目录

- [产品文档](docs/PRODUCT_SPEC.md)：产品定位、用户角色、页面功能、流程、需求范围和验收标准。
- [技术设计](docs/TECHNICAL_DESIGN.md)：系统架构、回合状态机、爆点算法、飞行公式、奖池规则和机器人调度。
- [接口文档](docs/API_REFERENCE.md)：HTTP API、WebSocket 事件、请求响应和错误口径。
- [后台运营指南](docs/OPERATIONS_GUIDE.md)：后台指标、参数说明、机器人、奖池、玩家管理和常见问题。
- [部署文档](docs/DEPLOYMENT.md)：本地启动、Linux 启动、OpenCloudOS systemd 部署和端口自增。

## 当前能力

- 玩家端：英文界面、登录、余额、下注、手动 Cash Out、可选 Auto Cashout、本人下注历史、爆点历史、实时玩家列表。
- 直播间布局：玩家列表在左侧，火箭画面在中间，下注区在底部，目标适配 750 x 750 画面。
- 后台端：本地 MVP 免密码，支持运营指标、当前回合、参数配置、玩家余额调整、强制爆炸、暂停恢复和回合记录。
- 机器人：按后台配置的数量和下注间隔陆续下注，按自动提现倍率实时跳出。机器人金额不计入平台盈亏和回合金额，只统计人数。
- 奖池：真实玩家下注进入奖池，真实玩家提现从奖池扣除；真实玩家局的最大爆点受奖池承受能力限制。
- 实时通信：玩家端使用 WebSocket 事件推送。飞行中不持续推送倍率，前端根据 `launchAt` 本地计算显示，服务端仍负责权威结算。
- 公平性：每局开始公开 `serverSeedHash`，爆炸后公开 `serverSeed` 和 HMAC，便于复算随机爆点。后台强制爆炸的回合会标记为 `forced`。

## 快速启动

Windows 双击：

```text
start-rocket.bat
```

手动启动：

```bash
npm start
```

或：

```bash
node server.js
```

指定端口：

```powershell
$env:PORT="3001"
node server.js
```

访问地址：

- 玩家端：http://localhost:3000/
- 后台端：http://localhost:3000/admin

如果 3000 已被其他服务占用，本地手动启动需要自己换端口；Linux 脚本支持端口自增。

## OpenCloudOS 部署

在服务器项目目录执行：

```bash
sudo bash deploy-opencloudos.sh
```

脚本会尝试自动拉取 Git 更新、部署到 `/opt/rocket-crash-platform`、创建 `rocket-crash` systemd 服务，并在 `BASE_PORT` 到 `MAX_PORT` 范围内自动选择可用端口。
部署完成时会优先使用公网 IP 打印玩家端和后台端 URL；如果需要指定域名或公网 IP，可以传 `PUBLIC_HOST`：

```bash
sudo PUBLIC_HOST=rocket.example.com bash deploy-opencloudos.sh
```

默认端口范围：

```text
BASE_PORT=3000
MAX_PORT=3050
```

常用命令：

```bash
sudo systemctl status rocket-crash
sudo systemctl restart rocket-crash
sudo journalctl -u rocket-crash -f
sudo cat /opt/rocket-crash-platform/data/runtime.env
```

更多部署细节见 [部署文档](docs/DEPLOYMENT.md)。

## 重要口径

- 后台当前不需要密码，这是本地 MVP 设计，不适合公网生产环境。
- 玩家端不提前显示爆点，也不显示 Hash；爆炸后才通过 `crash` 事件公开验证数据。
- 机器人下注、提现、输赢不计入平台金额指标；只记录机器人数量和展示效果。
- 下注金额必须命中后台配置的筹码档位，例如 `10,50,100,500,1000`。
- `1000` 筹码在玩家端显示为 `1K`。
- Auto Cashout 默认关闭，只有用户主动勾选后才提交自动提现倍率。
- 飞行倍率公式是 `exp(elapsedMs / 6500)`，显示时向下保留两位小数。

## 项目结构

```text
Rocket/
  server.js                 Node.js 原生 HTTP + WebSocket 服务
  public/
    index.html              玩家端页面
    app.js                  玩家端逻辑
    admin.html              后台页面
    admin.js                后台逻辑
    styles.css              前后台样式
  data/
    db.json                 本地数据，运行时生成
    runtime.env             Linux 启动脚本写入的运行端口
  docs/                     产品、技术、接口、运营、部署文档
  start-rocket.bat          Windows 一键启动
  start-linux.sh            Linux 前台启动，端口自增
  deploy-opencloudos.sh     OpenCloudOS systemd 部署
```

## 生产化待办

- 后台启用账号体系、RBAC、2FA、操作审计和登录限速。
- JSON 持久化替换为 PostgreSQL / MySQL，并使用事务锁保护下注、扣款、提现和结算。
- 补齐真实资金合规、KYC、AML、地区限制、支付审计和风控规则。
- 接入 HTTPS、CSP、安全 Cookie、反向代理限流和日志监控。
- 增加完整自动化测试、压测、异常恢复和备份策略。
