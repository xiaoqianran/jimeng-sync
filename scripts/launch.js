const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const { exec } = require("child_process");

const root = path.resolve(__dirname, "..");
const port = Number(process.env.PORT || 3001);
const url = `http://127.0.0.1:${port}/`;

function openBrowser(target) {
  const cmd = process.platform === "win32"
    ? `start "" "${target}"`
    : process.platform === "darwin"
      ? `open "${target}"`
      : `xdg-open "${target}"`;
  exec(cmd);
}

function waitHealth(tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = (left) => {
      const req = http.get(url + "health", (res) => {
        res.resume();
        if (res.statusCode === 200) resolve();
        else if (left <= 0) reject(new Error("health failed"));
        else setTimeout(() => tick(left - 1), 250);
      });
      req.on("error", () => {
        if (left <= 0) reject(new Error("helper not ready"));
        else setTimeout(() => tick(left - 1), 250);
      });
    };
    tick(tries);
  });
}

function healthOk() {
  return new Promise((resolve) => {
    const req = http.get(url + "health", (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
  });
}

async function main() {
  if (await healthOk()) {
    openBrowser(url);
    console.log(`助手已在运行，已打开 ${url}`);
    return;
  }
  const child = spawn(process.execPath, ["server.js"], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code || 0));
  try {
    await waitHealth();
    openBrowser(url);
    console.log(`画廊已打开 ${url}`);
  } catch (err) {
    console.error(err.message);
  }
}

main();
