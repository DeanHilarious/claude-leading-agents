# 指挥台（远程模式）部署指南

把本地的 `dashboard/` 部署到一台公网服务器，接收本机 reporter 上报的任务数据并展示。
全程零依赖，只需要 Node ≥18、nginx 和 systemd。

> 原则：**新增站点不得影响服务器上已有的其他 nginx 站点**；每次改 nginx 配置前先 `nginx -t` 验证，通过后再 `systemctl reload nginx`。
> 服务名统一用 `claude-leading-agents-dashboard`（而不是 `dashboard`），避免和服务器上已有的同名 systemd 服务冲突。

## 1. 建系统用户与数据目录

```bash
sudo useradd --system --home /var/lib/claude-leading-agents --shell /usr/sbin/nologin dashboard
sudo mkdir -p /var/lib/claude-leading-agents
sudo chown dashboard:dashboard /var/lib/claude-leading-agents
sudo chmod 750 /var/lib/claude-leading-agents
```

## 2. 拷贝代码与 node 可执行文件

```bash
sudo mkdir -p /opt/claude-leading-agents
sudo cp -r dashboard /opt/claude-leading-agents/dashboard
```

只需 `server.js`、`lib/`、`public/`；`test/`、`node_modules`（本来也没有）不需要。

把 node 可执行文件统一复制到 `/opt/claude-leading-agents/bin/node`（systemd 单元里的 `ExecStart` 指向这里）：

```bash
sudo install -m 755 "$(command -v node)" /opt/claude-leading-agents/bin/node
/opt/claude-leading-agents/bin/node --version    # 应 ≥ v18
```

### Node 装在 `/root/.nvm` 等主目录下时

如果服务器上的 node 是用 nvm（或其它装在某个用户主目录下的方式）安装的（如 `/root/.nvm/versions/node/v20.x.x/bin/node`），有两个问题叠加：

- systemd 单元以 `dashboard` 用户运行，无权进入 `/root`；
- 单元开了 `ProtectHome=true`，**任何**用户（包括 root）在服务进程里都访问不到 `/root`、`/home` 下的路径。

处理办法就是上面那一步：把 node 可执行文件复制到主目录之外的 `/opt/claude-leading-agents/bin/node`（`install -m 755`），单元里的 `ExecStart` 指向它。node 是静态链接的自包含可执行文件，复制后不依赖 nvm 的目录也能跑（`command -v node` 给出哪个版本就复制哪个）。

## 3. 写环境文件

```bash
sudo mkdir -p /etc/claude-leading-agents
sudo cp dashboard/deploy/dashboard.env.example /etc/claude-leading-agents/dashboard.env
sudo nano /etc/claude-leading-agents/dashboard.env   # 填入 DASHBOARD_PASSWORD / DASHBOARD_INGEST_TOKEN / DASHBOARD_HOST
sudo chmod 600 /etc/claude-leading-agents/dashboard.env
sudo chown root:root /etc/claude-leading-agents/dashboard.env
```

> 环境文件属主用 `root:root`、权限 `600`：systemd 以 root 身份读取 `EnvironmentFile`，再注入服务进程，`dashboard` 用户本身不需要读它的权限。

- `DASHBOARD_INGEST_TOKEN`：至少 24 字符的随机串，例如 `openssl rand -hex 24`。
- `DASHBOARD_HOST`：对外域名，与 nginx 的 `server_name` 一致。
- 缺 `DASHBOARD_PASSWORD` 或 `DASHBOARD_INGEST_TOKEN`（或令牌太短）时服务会拒绝启动并给出中文提示。

## 4. 安装 systemd 单元

```bash
sudo cp dashboard/deploy/dashboard.service /etc/systemd/system/claude-leading-agents-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now claude-leading-agents-dashboard
systemctl status claude-leading-agents-dashboard   # 应为 active (running)
journalctl -u claude-leading-agents-dashboard -n 20  # 看启动日志，不应有报错
```

## 5. 配 nginx

把 `deploy/nginx.conf.example` **整个文件**复制为 `/etc/nginx/conf.d/claude-leading-agents.conf`（`conf.d` 下的文件都在 `http {}` 内被 include，文件顶部的两个 `limit_req_zone` 因此只需要这一处；若服务器上已有同名 zone，改名复用，勿重复定义）。替换 `server_name` 与证书路径。**不要动其他站点。**

反代所需的 `proxy_*` 指令（SSE 必需的 `proxy_buffering off`、长超时等）直接写在 `server {}` 级，各 `location` 只写 `proxy_pass`，不依赖外部的 `proxy_params` 文件。限流被触发时返回 `429`（`limit_req_status`）。

证书还没签发时，先按第 6 步的「两段式」只启用 80 端口的 ACME 站点；拿到证书后再放开 443 配置。验证并生效：

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 6. 申请证书

**先建只应答 ACME 验证的 80 端口站点，拿到证书后再换成完整 HTTPS 配置**（直接上 443 配置会因证书文件不存在而 `nginx -t` 失败）。示例配置见 `deploy/nginx.conf.example`：80 端口的 `server` 块里 `/.well-known/acme-challenge/` 指向 webroot `/var/www/acme`，其余请求先注释掉跳转；443 的 `server` 块整块先注释掉。

```bash
sudo mkdir -p /var/www/acme
sudo nginx -t && sudo systemctl reload nginx   # 启用只有 ACME 的 80 端口站点
```

方式一：certbot（webroot 模式）

```bash
sudo certbot certonly --webroot -w /var/www/acme -d dashboard.example.com
# 证书在 /etc/letsencrypt/live/dashboard.example.com/；certbot 自带续期定时任务
```

方式二：acme.sh（ECC 证书）

```bash
curl https://get.acme.sh | sh -s email=you@example.com
~/.acme.sh/acme.sh --issue -d dashboard.example.com -w /var/www/acme --server letsencrypt --keylength ec-256
sudo mkdir -p /etc/nginx/claude-leading-agents
sudo ~/.acme.sh/acme.sh --install-cert -d dashboard.example.com --ecc \
  --fullchain-file /etc/nginx/claude-leading-agents/fullchain.pem \
  --key-file /etc/nginx/claude-leading-agents/privkey.pem \
  --reloadcmd "systemctl reload nginx"
# install-cert 会装一个续期任务，续期后自动执行 reloadcmd
```

拿到证书后，取消注释 / 换上完整的 443 配置（示例里两个 `limit_req_zone` 保持在文件顶部不动），再 `nginx -t && systemctl reload nginx`。

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
sudo systemctl restart claude-leading-agents-dashboard  # 改环境文件后重启生效
sudo systemctl status claude-leading-agents-dashboard
journalctl -u claude-leading-agents-dashboard -f        # 跟日志（日志里不会出现密码/令牌）
```

数据都在 `/var/lib/claude-leading-agents/`，备份该目录即可。
