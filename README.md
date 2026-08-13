# jimeng-sync

即梦（Jimeng）提示词同步服务：油猴脚本采集页面数据，本地 Express API 写入 MySQL。

## 组成

- `server.js` — 同步 API（健康检查、批量写入、断点校准、NDJSON 流式写入）
- `油猴/jimeng-prompt-collector.mysql-sync.resumable.user.js` — 即梦页面采集与上传脚本

## 启动 API

```bash
npm install
copy .env.example .env
# 编辑 .env，填入 MySQL 连接信息
node server.js
```

默认监听 `http://127.0.0.1:3001`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 探活，并检查数据库连接 |
| POST | `/api/jimeng/prompts/batch` | JSON 批量 upsert |
| POST | `/api/jimeng/prompts/existing` | 按 `work_id` 校准已存在记录 |
| POST | `/api/jimeng/prompts/stream` | NDJSON 流式写入 |

环境变量见 `.env.example`。不要把真实密码提交进仓库。

## 打包 Windows 可执行文件

```bash
npm run build
```

输出：`dist/jimeng-sync-api.exe`
