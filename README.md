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

- 玩家端：英文界面、登录、余额、下注、手动 Cash Out、可选 Auto Cashout、本人下注历史、爆点历史、规则弹窗、新手引导和实时玩家列表。
- 新手引导：首次进入自动播放，完成或跳过状态记录在服务器；玩家也可以在 `Rules` 弹窗中手动重播。
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
- 后台端：http://localhost:3000/manage

如果 3000 已被其他服务占用，本地手动启动需要自己换端口；Linux 脚本支持端口自增。

启用服务端 HTTPS / WSS：

```bash
HTTPS_CERT_PATH=/path/fullchain.pem HTTPS_KEY_PATH=/path/privkey.pem node server.js
```

启用后玩家端地址会变为 `https://host:port/`，WebSocket 会自动使用 `wss://host:port/ws`。

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

如果需要让 Node 服务本身直接提供 HTTPS / WSS：

```bash
sudo PUBLIC_HOST=rocket.example.com \
  HTTPS_CERT_PATH=/opt/rocket-crash-platform/certs/fullchain.pem \
  HTTPS_KEY_PATH=/opt/rocket-crash-platform/certs/privkey.pem \
  bash deploy-opencloudos.sh
```

如果使用 Cloudflare Tunnel，推荐不要给 Node 配 HTTPS 证书。让 Cloudflare 对外提供 HTTPS / WSS，Tunnel 到源站使用 `http://localhost:PORT` 即可。详细配置见 [部署文档](docs/DEPLOYMENT.md#11-cloudflare-tunnel)。

玩家端默认会根据当前页面地址自动连接 WebSocket：`https://域名` 会连接 `wss://域名/ws`，不会写死服务器 IP 或端口。若需要显式指定 WebSocket 地址，可以部署时传：

```bash
sudo PUBLIC_HOST=rocket.example.com \
  PUBLIC_WS_URL=wss://rocket.example.com/ws \
  bash deploy-opencloudos.sh
```

如果页面域名和 WebSocket 域名分开，例如页面是 `rocket.xincreates.com`，WebSocket 是 `rocket-api.xincreates.com/ws`，可以这样部署：

```bash
sudo PUBLIC_HOST=rocket.xincreates.com \
  PUBLIC_WS_HOST=rocket-api.xincreates.com \
  bash deploy-opencloudos.sh
```

脚本会自动生成 `PUBLIC_WS_URL=wss://rocket-api.xincreates.com/ws`，并写入玩家端的 `public/runtime-config.js`。这个值只影响浏览器要连接哪个公网 WSS 地址，不会改变 Node 服务监听的端口、协议或域名。

直接运行 `sudo bash deploy-opencloudos.sh` 时，脚本会在终端询问玩家页面域名、WebSocket 域名和后台页面路径。填写后会保存到 `/opt/rocket-crash-platform/data/deploy-config.env`，下次部署会自动复用，不需要重复输入。需要重新输入时使用：

```bash
sudo FORCE_DEPLOY_CONFIG_PROMPT=1 bash deploy-opencloudos.sh
```

需要无人值守部署时继续使用上面的环境变量；或者设置 `ASK_DEPLOY_CONFIG=0` 跳过交互。

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
