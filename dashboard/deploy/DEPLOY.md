# 指挥台（远程模式）部署指南

把本地的 `dashboard/` 部署到一台公网服务器，接收本机 reporter 上报的任务数据并展示。
全程零依赖，只需要 Node ≥18、nginx 和 systemd。

> 原则：**新增站点不得影响服务器上已有的其他 nginx 站点**；每次改 nginx 配置前先 `nginx -t` 验证，通过后再 `systemctl reload nginx`。

## 1. 建系统用户与数据目录

```bash
sudo useradd --system --home /var/lib/claude-leading-agents --shell /usr/sbin/nologin dashboard
sudo mkdir -p /var/lib/claude-leading-agents
sudo chown dashboard:dashboard /var/lib/claude-leading-agents
sudo chmod 750 /var/lib/claude-leading-agents
```

## 2. 拷贝代码

```bash
sudo mkdir -p /opt/claude-leading-agents
sudo cp -r dashboard /opt/claude-leading-agents/dashboard
```

只需 `server.js`、`lib/`、`public/`；`test/`、`node_modules`（本来也没有）不需要。

## 3. 写环境文件

```bash
sudo mkdir -p /etc/claude-leading-agents
sudo cp dashboard/deploy/dashboard.env.example /etc/claude-leading-agents/dashboard.env
sudo nano /etc/claude-leading-agents/dashboard.env   # 填入 DASHBOARD_PASSWORD / DASHBOARD_INGEST_TOKEN / DASHBOARD_HOST
sudo chmod 600 /etc/claude-leading-agents/dashboard.env
sudo chown root:dashboard /etc/claude-leading-agents/dashboard.env
```

- `DASHBOARD_INGEST_TOKEN`：至少 24 字符的随机串，例如 `openssl rand -hex 24`。
- `DASHBOARD_HOST`：对外域名，与 nginx 的 `server_name` 一致。
- 缺 `DASHBOARD_PASSWORD` 或 `DASHBOARD_INGEST_TOKEN`（或令牌太短）时服务会拒绝启动并给出中文提示。

## 4. 安装 systemd 单元

```bash
sudo cp dashboard/deploy/dashboard.service /etc/systemd/system/dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now dashboard
systemctl status dashboard          # 应为 active (running)
journalctl -u dashboard -n 20       # 看启动日志，不应有报错
```

## 5. 配 nginx

1. 建公共反代参数文件（SSE 必需的设置都在里面）：

```bash
sudo mkdir -p /etc/nginx/claude-leading-agents
# 内容见 deploy/nginx.conf.example 末尾注释块的 proxy_params
sudo nano /etc/nginx/claude-leading-agents/proxy_params
```

2. 在 `http {}` 级别加两个 `limit_req_zone`（如果已有同名的就复用，别重复定义）。
3. 参照 `deploy/nginx.conf.example` 新增一个 `server` 块，替换 `server_name` 与证书路径。**不要动其他站点。**
4. 验证并生效：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 6. 申请证书（Let's Encrypt 示例）

```bash
sudo certbot --nginx -d dashboard.example.com
# certbot 会自动改写 80/443 的跳转与证书行；改完再跑一次 nginx -t 确认
```

## 7. 验证

在服务器上：

```bash
curl -s http://127.0.0.1:4177/healthz            # {"ok":true}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4177/api/overview   # 401（未登录）
curl -s -H "Authorization: Bearer <令牌>" https://dashboard.example.com/ingest/v1/ping
# {"ok":true,"time":"…","limits":{"maxFileBytes":2097152}}
```

在浏览器打开 `https://dashboard.example.com`：应跳到登录页，输入 `DASHBOARD_PASSWORD` 后进入指挥台。

reporter 侧配好 `BASE=https://dashboard.example.com` 与同一个 `DASHBOARD_INGEST_TOKEN`，上报一两条数据后刷新页面即可看到任务。

## 日常运维

```bash
sudo systemctl restart dashboard     # 改环境文件后重启生效
sudo systemctl status dashboard
journalctl -u dashboard -f           # 跟日志（日志里不会出现密码/令牌）
```

数据都在 `/var/lib/claude-leading-agents/`，备份该目录即可。
