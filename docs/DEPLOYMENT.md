# Rocket Crash Platform 部署文档

## 1. 运行要求

- Node.js `>=18`
- Windows、Linux 或 OpenCloudOS
- 无外部 npm 运行依赖

检查 Node.js：

```bash
node -v
```

## 2. 本地 Windows 启动

方式一：双击项目根目录：

```text
start-rocket.bat
```

方式二：命令行启动：

```powershell
cd E:\Privy\Rocket
npm start
```

或：

```powershell
node server.js
```

指定端口：

```powershell
$env:PORT="3001"
node server.js
```

访问：

- 玩家端：http://localhost:3000/
- 后台端：http://localhost:3000/admin

## 3. Linux 前台启动

`start-linux.sh` 用于前台启动，不安装 systemd 服务。

```bash
BASE_PORT=3000 MAX_PORT=3050 bash start-linux.sh
```

特点：

- 自动在端口范围内选择可用端口。
- 会把选中的端口写入 `data/runtime.env`。
- 终端关闭后服务会停止。
- 适合临时调试。

## 4. OpenCloudOS systemd 部署

`deploy-opencloudos.sh` 用于服务器部署。

```bash
sudo bash deploy-opencloudos.sh
```

脚本行为：

1. 检查 Node.js。
2. 如果当前目录是 Git 仓库，默认执行 `git fetch` 和 `git pull --ff-only`。
3. 复制项目到 `/opt/rocket-crash-platform`。
4. 创建 systemd 服务 `rocket-crash`。
5. 使用 `start-linux.sh` 启动服务。
6. 在 `BASE_PORT` 到 `MAX_PORT` 之间自动选择可用端口。
7. 如果 firewalld 正在运行，尝试开放端口范围。

部署完成后会输出：

- Service 名称。
- App 目录。
- 端口范围。
- 实际选择端口。
- runtime 文件路径。
- Public host 和 Private IP。
- 玩家端 URL。
- 后台端 URL。

脚本会优先探测公网 IP 并用公网地址打印访问 URL。公网 IP 探测失败时，会回退到本机内网 IP。

如果你想指定打印出来的访问地址，例如绑定域名或云服务器公网 IP：

```bash
sudo PUBLIC_HOST=1.2.3.4 bash deploy-opencloudos.sh
```

或：

```bash
sudo PUBLIC_HOST=rocket.example.com bash deploy-opencloudos.sh
```

## 5. 端口自增规则

默认：

```text
BASE_PORT=3000
MAX_PORT=3050
```

启动时会从 `3000` 开始尝试绑定：

```text
3000 -> 3001 -> 3002 -> ... -> 3050
```

端口检测使用 Node.js 实际 bind，不只解析 `ss` 输出。因此如果 `3000` 已被其他服务占用，会跳到下一个可用端口。

实际端口写入：

```text
/opt/rocket-crash-platform/data/runtime.env
```

查看实际端口：

```bash
sudo cat /opt/rocket-crash-platform/data/runtime.env
```

自定义端口范围：

```bash
sudo BASE_PORT=3100 MAX_PORT=3150 bash deploy-opencloudos.sh
```

## 6. Git 自动更新

默认部署前会尝试从当前 Git 分支拉取最新代码：

```bash
sudo bash deploy-opencloudos.sh
```

跳过 Git 更新：

```bash
sudo UPDATE_FROM_GIT=0 bash deploy-opencloudos.sh
```

指定分支：

```bash
sudo GIT_BRANCH=main bash deploy-opencloudos.sh
```

注意：

- `git pull --ff-only` 要求远端可以快进合并。
- 如果服务器本地有未提交改动，Git 更新可能失败。
- 失败时请先处理服务器本地改动，再重新部署。

## 7. systemd 常用命令

查看状态：

```bash
sudo systemctl status rocket-crash
```

重启：

```bash
sudo systemctl restart rocket-crash
```

查看日志：

```bash
sudo journalctl -u rocket-crash -f
```

停止：

```bash
sudo systemctl stop rocket-crash
```

开机自启：

```bash
sudo systemctl enable rocket-crash
```

## 8. 数据目录

本地开发：

```text
data/db.json
data/runtime.env
```

OpenCloudOS 部署：

```text
/opt/rocket-crash-platform/data/db.json
/opt/rocket-crash-platform/data/runtime.env
```

说明：

- `db.json` 保存设置、玩家、回合、nonce 和审计日志。
- `runtime.env` 保存当前选中的端口。
- 重新部署会保留部署目录内的数据文件。

## 9. 反向代理建议

生产或公网访问建议放到 Nginx / OpenResty 后面：

- 启用 HTTPS。
- 转发 WebSocket Upgrade。
- 限制后台访问来源。
- 增加请求限速。
- 增加日志采集。

WebSocket 反代需要保留：

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
```

## 10. 故障排查

### 10.1 部署后不是 3001

如果脚本选择了 3000，说明脚本实际 bind 检测认为 3000 可用。请确认占用 3000 的服务是否在同一台机器、同一网络命名空间、同一 IP 绑定范围内。

查看监听：

```bash
sudo ss -lntp | grep ':3000'
```

### 10.2 浏览器还加载旧 JS / CSS

当前静态服务对 `.html`、`.js`、`.css` 使用 `no-store`，并且页面资源带版本号。若仍有旧资源：

- 重启服务。
- 强刷浏览器。
- 检查页面源代码中的 `?v=` 是否为最新版本。

### 10.3 `/api/ping` 404

当前代码保留 `/api/ping`。如果 404，通常说明访问的端口上跑的是旧进程或其他服务。

处理：

```bash
sudo systemctl restart rocket-crash
sudo journalctl -u rocket-crash -f
```

### 10.4 机器人最后一刻集中出现

当前版本不会在起飞前补齐机器人。如果仍出现集中刷新：

- 确认已部署最新代码。
- 强刷玩家端页面。
- 检查后台 `机器人下注最小间隔 ms` 和 `机器人下注最大间隔 ms`。
- 查看日志确认服务已重启。
