const express = require("express");
const cors = require("cors");
const { load } = require("./lib/config");

async function main() {
  const config = load();
  const app = express();

  app.use(cors({
    origin: [
      "https://jimeng.jianying.com",
      "http://127.0.0.1:" + config.port,
      "http://localhost:" + config.port,
    ],
  }));
  app.use(express.json({ limit: config.jsonLimit }));

  let sqlite = null;
  let mysqlDb = null;
  let syncEngine = null;
  let imageStore = null;

  if (config.mode === "remote") {
    const mysql = require("./lib/db-mysql");
    mysqlDb = await mysql.create(config.mysql);
    app.use(require("./routes/sync").create(mysqlDb, config));
    app.get("/health", async (req, res) => {
      try {
        const ok = await mysqlDb.ping();
        const header = String(req.headers.authorization || "");
        const bearer = header.startsWith("Bearer ") ? header.slice(7) : "";
        const token = bearer || String(req.headers["x-sync-token"] || "");
        if (!config.syncToken || token !== config.syncToken) {
          return res.json({ ok, mode: "remote" });
        }
        const status = await mysqlDb.status();
        res.json({ ok, mode: "remote", ...status });
      } catch (err) {
        res.status(500).json({ ok: false, mode: "remote", message: err.message });
      }
    });
  } else {
    sqlite = require("./lib/db-sqlite").create(config.dbPath);
    const binding = sqlite.ensureDeviceBinding(config.deviceId);
    if (binding.rebound) {
      console.log(`  检测到库与设备身份不一致，已按新设备重新绑定（旧 ${binding.previous}）`);
    }
    syncEngine = require("./lib/sync-engine").create(sqlite, config);
    imageStore = require("./lib/image-store").create(sqlite, config);
    app.use(require("./routes/local").create(sqlite, config, syncEngine, imageStore));
    app.use(require("./routes/admin").create(config));
    app.get("/health", (req, res) => {
      res.json({
        ok: true,
        mode: "local",
        dbPath: sqlite.path,
        deviceId: config.deviceId,
        ...sqlite.stats(),
        sync: syncEngine.snapshot(),
      });
    });
    app.get("/v1/health", (req, res) => {
      res.json({
        ok: true,
        mode: "local",
        ...sqlite.stats(),
        sync: syncEngine.snapshot(),
      });
    });
    syncEngine.start();
    imageStore.start();
  }

  const server = app.listen(config.port, config.bind, () => {
    console.log(`Jimeng sync (${config.mode}) http://${config.bind}:${config.port}`);
    if (config.mode === "local") {
      console.log(`  本地库: ${config.dbPath}`);
      console.log(`  配置页: http://127.0.0.1:${config.port}/`);
      console.log(`  设备:   ${config.deviceName} (${config.deviceId})`);
      console.log(`  图片:   ${config.imageDir}（间隔约 ${config.imageDelayMs}ms，不重编码）`);
      if (config.remoteUrl) console.log(`  远程:   ${config.remoteUrl}`);
      else console.log("  远程:   未配置，仅本地备份");
    } else {
      console.log("  远程同步: GET/POST /sync/pull /sync/push");
    }
  });

  function shutdown() {
    server.close(() => {
      if (imageStore) imageStore.stop();
      if (syncEngine) syncEngine.stop();
      if (sqlite) sqlite.close();
      if (mysqlDb) mysqlDb.close().finally(() => process.exit(0));
      else process.exit(0);
    });
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
