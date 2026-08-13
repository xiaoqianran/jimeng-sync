const { spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3002);
const url = `http://127.0.0.1:${port}`;
const configPath = path.join(root, "data", "config.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function ensureToken() {
  if (process.env.SYNC_TOKEN) return process.env.SYNC_TOKEN;
  const persisted = readJson(configPath, {});
  if (persisted.sync_token) return persisted.sync_token;
  const token = "local-" + crypto.randomBytes(12).toString("hex");
  persisted.sync_token = token;
  writeJson(configPath, persisted);
  return token;
}

function pointGalleryAtRemote(token) {
  const persisted = readJson(configPath, {});
  persisted.sync_token = token;
  persisted.remote_url = persisted.remote_url || url;
  persisted.remote_token = persisted.remote_token || token;
  writeJson(configPath, persisted);
}

function health(pathname) {
  return new Promise((resolve) => {
    const req = http.get(url + pathname, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    req.on("error", () => resolve(null));
  });
}

function waitHealth(tries = 50) {
  return new Promise((resolve, reject) => {
    const tick = async (left) => {
      const hit = await health("/health");
      if (hit && hit.status === 200) return resolve(hit);
      if (left <= 0) return reject(new Error("3002 没有起来，请看上面的报错（常见是 MySQL 没开）"));
      setTimeout(() => tick(left - 1), 250);
    };
    tick(tries);
  });
}

async function main() {
  const token = ensureToken();
  pointGalleryAtRemote(token);

  const already = await health("/health");
  if (already && already.status === 200) {
    console.log("远程同步服务已在运行");
    console.log("  地址: " + url);
    console.log("  Token: " + token);
    console.log("画廊设置里远程地址填上面这一行即可。");
    return;
  }

  const env = {
    ...process.env,
    MODE: "remote",
    PORT: String(port),
    BIND: process.env.BIND || "127.0.0.1",
    SYNC_TOKEN: token,
    DB_HOST: process.env.DB_HOST || "127.0.0.1",
    DB_PORT: process.env.DB_PORT || "3306",
    DB_USER: process.env.DB_USER || "root",
    DB_PASSWORD: process.env.DB_PASSWORD || "",
    DB_NAME: process.env.DB_NAME || "jimeng",
  };

  console.log("启动本地 3002 同步服务（连本机 MySQL）...");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    stdio: "inherit",
    env,
  });
  child.on("exit", (code) => process.exit(code || 0));

  try {
    await waitHealth();
    console.log("");
    console.log("3002 已启动");
    console.log("  地址: " + url);
    console.log("  Token: " + token);
    console.log("  库:   " + env.DB_USER + "@" + env.DB_HOST + ":" + env.DB_PORT + "/" + env.DB_NAME);
    console.log("画廊（3001）设置里已自动写入该远程地址和 token。");
    console.log("不要关这个窗口，关掉就等于停掉 3002。");
  } catch (err) {
    console.error(err.message);
  }
}

main();
