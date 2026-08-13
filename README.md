# jimeng-sync

即梦发现页采集器：油猴只负责抓作品，本机 Node 助手做备份和画廊。可选再开一层同步服务，把数据双向同步到 MySQL。

需要 **Node.js 22+**（用内置 `node:sqlite`）。Windows / macOS / Linux 同一套命令。

## 3001 和 3002 是什么

| 进程 | 默认地址 | 干什么 | 什么时候开 |
| --- | --- | --- | --- |
| **3001 本机助手** | http://127.0.0.1:3001/ | 收油猴数据、写 `data/jimeng.db`、打开画廊 | 采集、看图时必须开 |
| **3002 同步门** | http://127.0.0.1:3002/ | 连 MySQL，做 push/pull，不是数据库本身 | 只要「和 MySQL 双向同步」时才开 |

```text
即梦页面
  └─ 油猴 v3.1+
        │  POST /v1/ingest
        ▼
   3001 本机助手          data/jimeng.db
   画廊 / 收藏 / 导出         │
                              │ 可选
                              ▼
                         3002 同步服务
                              │
                              ▼
                           MySQL
```

- 双击 `JimengSync.exe` / `start.bat` / `start.sh` **只会起 3001**，不会起 3002。
- 3002 是另一道门：前面是 HTTP + token，后面才是 MySQL。设置页里的「远程地址」填的是这道门，不是 `主机:3306`。
- 只在自己电脑上看图、备份：开 3001 就够。
- 要和本机或服务器上的 MySQL 互相同步：再开 3002（或把 3002 部署到库所在的机器）。

## 各系统如何构建

先装 [Node.js 22+](https://nodejs.org/)，然后：

```bash
git clone https://github.com/xiaoqianran/jimeng-sync.git
cd jimeng-sync
npm install
cp .env.example .env          # Windows: copy .env.example .env
```

改 `.env` 里的 MySQL 账号（只在要用 3002 时才必须填）。`npm install` 没有原生编译步骤。

Windows 可选：再编译两个小启动器（只是调用 `node`，不是把整个服务打进 exe）：

```bat
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /out:JimengSync.exe scripts\JimengSync.cs
%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe /nologo /optimize /out:JimengSyncRemote.exe scripts\JimengSyncRemote.cs
```

不要用 `npm run build`（旧的 `pkg` 目标是 Node 18，没有 `node:sqlite`）。

## 如何启动 3001（画廊）

先进入项目目录。

**Windows**

- 双击 `start.bat`，或已编译的 `JimengSync.exe`
- 或：`npm run app`

**macOS / Linux**

```bash
chmod +x start.sh start-remote.sh
./start.sh
# 或
npm run app
```

浏览器打开 http://127.0.0.1:3001/ 。这个窗口不要关。

油猴：把 `油猴/jimeng-prompt-collector.mysql-sync.resumable.user.js` 整份装进 Tampermonkey（**v3.1.0+**），打开 https://jimeng.jianying.com/ 的发现/首页，点「持续采集」。

## 如何启动 3002（同步门）

先让 MySQL 在跑，并有库 `jimeng`（没有的话建一个空库即可，表会自动补）。

**Windows**

- 双击 `start-remote.bat` 或 `JimengSyncRemote.exe`
- 或：`npm run start:remote`

**macOS / Linux**

```bash
./start-remote.sh
# 或
npm run start:remote
```

启动器会：

- 监听 `127.0.0.1:3002`
- 默认连 `127.0.0.1:3306`，用户 `root`，库 `jimeng`（可用环境变量或 `.env` 改）
- 没有 `SYNC_TOKEN` 就自动生成，写进 `data/config.json`
- 顺手把画廊的远程地址写成 `http://127.0.0.1:3002`

这个窗口也不要关。然后再开 3001。画廊点「同步」就会和 MySQL 互相同步。

本机试跑时两个端口：

| 谁 | 端口 |
| --- | --- |
| 画廊 / 油猴写入 | 3001 |
| 同步门 / MySQL | 3002 |

## 把 3002 放到真正的服务器上

MySQL 在别的机器上时，在**那台机器**跑同一份代码：

```bash
export MODE=remote
export BIND=0.0.0.0
export PORT=3002
export SYNC_TOKEN='换成很长的随机串'
export DB_HOST=127.0.0.1
export DB_PORT=3306
export DB_USER=root
export DB_PASSWORD='你的密码'
export DB_NAME=jimeng
node scripts/launch-remote.js
```

前面建议再挂 Nginx / Caddy 做成 HTTPS。本机画廊设置里填：

- 远程地址：`https://你的域名` 或 `http://服务器:3002`
- Token：与服务器上的 `SYNC_TOKEN` 相同

不要把 MySQL 的 3306 暴露到公网。

## 画廊功能

分页、搜索、收藏、备注、大图、复制提示词、导出 JSONL、下载 `jimeng.db`。采集时新图会实时出现。

## 本机如何保存图片

画廊不能只靠 CDN 链接，过期就空白。3001 会在**本机**把原图字节写到 `data/images/`：

- 优先下 `image_high`（通常是 2048 webp/png），**不转码、不压缩**
- 一条一条下，默认间隔约 2.8 秒，遇到 403/429 会停 5 分钟
- 新采集的立刻排队；库里已有但还没落盘的也会慢慢补，不会对服务器做批量下载
- 画廊优先读本地文件 `/v1/media/:workId`

可用 `.env` 调整：`IMAGE_DELAY_MS`、`IMAGE_BACKFILL=0`（关掉对旧数据补下）。图片只存在跑 3001 的那台电脑上，不同步进 MySQL。

## 同步规则

| 字段 | 策略 |
| --- | --- |
| 提示词 / 图片 URL / 作者 / 模型 | 按字段补全，空值不覆盖 |
| 收藏 / 标签 / 备注 / 删除 | 客户端带 `base_rev`；不落后于服务器则接受 |
| 拉取 | 更高 `remote_rev` 赢；刚推上去的行不会再拉回来 |
| 新设备 / 拷贝库 | 先拉活数据快照；设置里可「标记为新设备」 |
| 删除 | 墓碑；默认 90 天后清理 |

## 接口摘要

**3001（本地）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/v1/health` | 探活 + 库统计 |
| POST | `/v1/ingest` | 油猴写入 |
| GET | `/v1/items` | 画廊列表 |
| GET | `/v1/events` | 实时入库 |
| POST | `/local/sync` | 立刻与 3002 同步 |

**3002（同步门，需要 `Authorization: Bearer <token>`）**

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/sync/pull` | 拉取变更 |
| POST | `/sync/push` | 推送变更 |
| GET | `/sync/snapshot` | 新设备快照 |
| GET | `/health` | 不带 token 只返回 `{ ok, mode }` |

## 开发

```bash
npm test
```
