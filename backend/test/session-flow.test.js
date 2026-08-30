const assert = require("node:assert/strict");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { WebSocket } = require("ws");

const backendDir = path.resolve(__dirname, "..");

function availablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timeout = setTimeout(() => reject(new Error(`WebSocket open timeout: ${url}`)), 5000);
    socket.once("open", () => {
      clearTimeout(timeout);
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

function waitForMessage(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("WebSocket message timeout"));
    }, 5000);
    const onMessage = (data, isBinary) => {
      let value = data;
      if (!isBinary) {
        try {
          value = JSON.parse(data.toString());
        } catch {
          value = data.toString();
        }
      }
      if (predicate(value, isBinary)) {
        cleanup();
        resolve(value);
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("message", onMessage);
    };
    socket.on("message", onMessage);
  });
}

async function waitForServer(baseUrl) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The child process may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Backend did not become ready");
}

async function run() {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const wsBaseUrl = `ws://127.0.0.1:${port}`;
  const sessionId = `flow-${randomUUID()}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: backendDir,
    env: { ...process.env, HOST: "127.0.0.1", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serverError = "";
  server.stderr.on("data", (chunk) => { serverError += chunk.toString(); });

  const sockets = [];
  try {
    await waitForServer(baseUrl);

    const watcher = await openSocket(`${wsBaseUrl}/ws/session?sessionId=${sessionId}`);
    const receiver = await openSocket(`${wsBaseUrl}/ws/video?sessionId=${sessionId}&role=receiver`);
    const sender = await openSocket(`${wsBaseUrl}/ws/video?sessionId=${sessionId}&role=sender`);
    sockets.push(watcher, receiver, sender);

    const frame = Buffer.from("same-session-video-frame");
    const receivedFrame = waitForMessage(
      receiver,
      (value, isBinary) => isBinary && Buffer.compare(value, frame) === 0
    );
    sender.send(frame);
    await receivedFrame;

    const guideUpdated = waitForMessage(
      watcher,
      (value) => value?.type === "guide-updated" && value.sessionId === sessionId
    );
    const guideForm = new FormData();
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64"
    );
    guideForm.append("guide", new Blob([png], { type: "image/png" }), "guide.png");
    const guideResponse = await fetch(`${baseUrl}/api/session/${sessionId}/guide`, {
      method: "POST",
      body: guideForm,
    });
    assert.equal(guideResponse.ok, true, await guideResponse.text());
    await guideUpdated;

    const sessionEnded = waitForMessage(
      watcher,
      (value) => value?.type === "session-ended" && value.sessionId === sessionId
    );
    const endResponse = await fetch(`${baseUrl}/api/session/${sessionId}/end`, { method: "POST" });
    assert.equal(endResponse.ok, true, await endResponse.text());
    await sessionEnded;

    const reconnectedWatcher = new WebSocket(`${wsBaseUrl}/ws/session?sessionId=${sessionId}`);
    sockets.push(reconnectedWatcher);
    const replayedEnd = waitForMessage(
      reconnectedWatcher,
      (value) => value?.type === "session-ended" && value.sessionId === sessionId
    );
    await new Promise((resolve, reject) => {
      reconnectedWatcher.once("open", resolve);
      reconnectedWatcher.once("error", reject);
    });
    await replayedEnd;

    console.log("session flow passed: video relay, guide update, end notification, reconnect replay");
  } finally {
    sockets.forEach((socket) => socket.close());
    try {
      await fetch(`${baseUrl}/api/session/${sessionId}`, { method: "DELETE" });
    } catch {
      // The server may already have exited after a failed assertion.
    }
    if (server.exitCode === null) {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    if (serverError) process.stderr.write(serverError);
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
