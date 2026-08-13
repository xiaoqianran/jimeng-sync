const clients = new Set();

function subscribe(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(":\n\n");
  clients.add(res);
  req.on("close", () => {
    clients.delete(res);
  });
}

function emit(event, data) {
  if (!clients.size) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch (_) {
      clients.delete(res);
    }
  }
}

function size() {
  return clients.size;
}

module.exports = { subscribe, emit, size };
