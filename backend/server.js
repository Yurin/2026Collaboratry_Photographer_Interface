const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { createServer } = require("http");
const { execFileSync } = require("child_process");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const port = process.env.PORT || 3000;
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 6);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS || 1000 * 60 * 10);

// backend/uploads に保存する
const uploadRoot = path.join(__dirname, "uploads");

// ../photographer の index.html / script.js / style.css / guide.png を配信する
const photographerDir = path.join(__dirname, "..", "photographer");

fs.mkdirSync(uploadRoot, { recursive: true });

function safeSessionId(value, fallback = "default") {
  return ((value || fallback).trim() || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const sessionId = safeSessionId(req.body.sessionId || req.params?.sessionId);

    const sessionDir = path.join(uploadRoot, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });

    cb(null, sessionDir);
  },

  filename(req, file, cb) {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

    const isGuide = file.fieldname === "guide";
    const isReference = file.fieldname === "reference";
    const namePrefix = isGuide ? "guide_" : isReference ? "reference_" : "";

    cb(null, `${namePrefix}${timestamp}_${safeName}`);
  },
});

const upload = multer({ storage });

// 画像URLは絶対URLではなく相対URLで返す
// Cloudflare Tunnel / HTTPS 経由でも mixed content を避けやすくするため
function makeFileUrl(sessionId, filename) {
  return `/uploads/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}`;
}

function getSessionDir(sessionId) {
  return path.join(uploadRoot, safeSessionId(sessionId));
}

function runPythonGuideGenerator(inputPath, outputPath, guideType, cropParams = null) {
  const scriptPath = path.join(__dirname, "guide_processor", "generate_guide.py");
  const pythonCommand = process.env.PYTHON || "python3";

  const args = [scriptPath, "--input", inputPath, "--output", outputPath, "--type", guideType];
  
  if (cropParams && cropParams.cropX !== undefined && cropParams.cropY !== undefined && 
      cropParams.cropWidth !== undefined && cropParams.cropHeight !== undefined) {
    args.push("--crop-x", String(cropParams.cropX));
    args.push("--crop-y", String(cropParams.cropY));
    args.push("--crop-width", String(cropParams.cropWidth));
    args.push("--crop-height", String(cropParams.cropHeight));
  }

  execFileSync(pythonCommand, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseCropParams(body) {
  const cropParams = {};
  if (body.cropX !== undefined) cropParams.cropX = parseFloat(body.cropX);
  if (body.cropY !== undefined) cropParams.cropY = parseFloat(body.cropY);
  if (body.cropWidth !== undefined) cropParams.cropWidth = parseFloat(body.cropWidth);
  if (body.cropHeight !== undefined) cropParams.cropHeight = parseFloat(body.cropHeight);

  const hasCropParams =
    cropParams.cropX !== undefined &&
    cropParams.cropY !== undefined &&
    cropParams.cropWidth !== undefined &&
    cropParams.cropHeight !== undefined;

  return hasCropParams ? cropParams : null;
}

app.use(cors());
app.use(express.json());

// アップロード画像を配信
app.use("/uploads", express.static(uploadRoot));

// photographer の静的ファイルを配信
app.use(express.static(photographerDir));

// QRで /?sessionId=... にアクセスされたとき index.html を返す
app.get("/", (req, res) => {
  res.sendFile(path.join(photographerDir, "index.html"));
});

const server = createServer(app);

// sessionId ごとに sender / receiver を管理
const sessions = new Map();

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      senders: new Set(),
      receivers: new Set(),
      watchers: new Set(),
    });
  }

  return sessions.get(sessionId);
}

function cleanupSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  if (session.senders.size === 0 && session.receivers.size === 0 && session.watchers.size === 0) {
    sessions.delete(sessionId);
  }
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function notifySession(sessionId, payload) {
  const session = sessions.get(sessionId);
  if (!session) return;

  for (const watcher of session.watchers) {
    sendJson(watcher, payload);
  }
}

function removeSessionFiles(sessionId) {
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) return false;

  fs.rmSync(sessionDir, { recursive: true, force: true });
  return true;
}

function cleanupExpiredSessions() {
  const now = Date.now();
  if (!fs.existsSync(uploadRoot)) return;

  for (const entry of fs.readdirSync(uploadRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;

    const sessionDir = path.join(uploadRoot, entry.name);
    let stat;
    try {
      stat = fs.statSync(sessionDir);
    } catch {
      continue;
    }

    if (now - stat.mtimeMs >= sessionTtlMs) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      notifySession(entry.name, {
        type: "session-deleted",
        sessionId: entry.name,
        reason: "expired",
      });
      console.log(`expired session deleted: ${entry.name}`);
    }
  }
}

// WebSocket: 撮影者Web → 被写体iOS に映像フレームを送る
const wss = new WebSocketServer({
  server,
  path: "/ws/video",
});

const sessionWss = new WebSocketServer({
  server,
  path: "/ws/session",
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  const sessionId = safeSessionId(url.searchParams.get("sessionId"), "");
  const role = url.searchParams.get("role");

  if (!sessionId || !["sender", "receiver"].includes(role)) {
    ws.close(1008, "sessionId and role are required");
    return;
  }

  const session = getOrCreateSession(sessionId);

  if (role === "sender") {
    session.senders.add(ws);
    console.log(`sender connected: ${sessionId}`);
  } else {
    session.receivers.add(ws);
    console.log(`receiver connected: ${sessionId}`);
  }

  ws.on("message", (message) => {
    if (role === "receiver") {
      try {
        const payload = JSON.parse(message.toString());
        if (payload.type === "guide-transform") {
          notifySession(sessionId, {
            type: "guide-transform",
            sessionId,
            transform: {
              offsetX: Number(payload.offsetX) || 0,
              scale: Number(payload.scale) || 1,
              opacity: Number(payload.opacity) || 0.5,
            },
          });
        }
      } catch {
        // receiver normally does not send video frames; ignore non-JSON messages.
      }
      return;
    }

    // sender から来た画像フレームを receiver 全員に送る
    for (const receiver of session.receivers) {
      if (receiver.readyState === WebSocket.OPEN) {
        receiver.send(message);
      }
    }
  });

  ws.on("close", () => {
    if (role === "sender") {
      session.senders.delete(ws);
      console.log(`sender disconnected: ${sessionId}`);
    } else {
      session.receivers.delete(ws);
      console.log(`receiver disconnected: ${sessionId}`);
    }

    cleanupSession(sessionId);
  });

  ws.on("error", (error) => {
    console.error("WebSocket error:", error);
  });
});

// WebSocket: ガイド更新やセッション削除を撮影者Webへ通知する
sessionWss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = safeSessionId(url.searchParams.get("sessionId"), "");

  if (!sessionId) {
    ws.close(1008, "sessionId is required");
    return;
  }

  const session = getOrCreateSession(sessionId);
  session.watchers.add(ws);
  sendJson(ws, {
    type: "connected",
    sessionId,
  });

  ws.on("close", () => {
    session.watchers.delete(ws);
    cleanupSession(sessionId);
  });

  ws.on("error", (error) => {
    console.error("session WebSocket error:", error);
  });
});

// 撮影者Webから写真を送信
app.post("/api/photos", upload.array("photos"), (req, res) => {
  const sessionId = safeSessionId(req.body.sessionId);

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: "photos are required",
    });
  }

  const files = req.files.map((file) => ({
    filename: file.filename,
    url: makeFileUrl(sessionId, file.filename),
  }));

  res.json({
    success: true,
    sessionId,
    files,
  });

  notifySession(sessionId, {
    type: "photos-updated",
    sessionId,
    files,
  });
});

// iOS側などからガイド画像をアップロード
app.post("/api/session/:sessionId/guide", upload.single("guide"), (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId, "");

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "guide file is required",
    });
  }

  const url = makeFileUrl(sessionId, req.file.filename);

  const payload = {
    success: true,
    sessionId,
    guide: {
      filename: req.file.filename,
      url,
    },
  };

  res.json(payload);
  notifySession(sessionId, {
    type: "guide-updated",
    sessionId,
    guide: payload.guide,
  });
});

app.post("/api/session/:sessionId/generate-guide", upload.single("reference"), (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);
  const guideType = ((req.body.guideType || "rectangle") || "rectangle").trim();

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "reference image is required",
    });
  }

  const cropParams = parseCropParams(req.body);

  const allowedTypes = new Set(["rectangle", "keypoints", "silhouette"]);
  const safeGuideType = allowedTypes.has(guideType) ? guideType : "rectangle";
  const outputFilename = `guide_${safeGuideType}_${Date.now()}.png`;
  const outputPath = path.join(path.dirname(req.file.path), outputFilename);

  try {
    if (cropParams) {
      runPythonGuideGenerator(req.file.path, outputPath, safeGuideType, cropParams);
    } else {
      runPythonGuideGenerator(req.file.path, outputPath, safeGuideType);
    }
  } catch (error) {
    console.error("guide generation failed:", error);
    return res.status(500).json({
      success: false,
      error: "guide generation failed",
    });
  }

  const url = makeFileUrl(sessionId, outputFilename);

  const payload = {
    success: true,
    sessionId,
    guide: {
      filename: outputFilename,
      url,
    },
  };

  res.json(payload);
  notifySession(sessionId, {
    type: "guide-updated",
    sessionId,
    guide: payload.guide,
  });
});

app.post("/api/session/:sessionId/generate-guide-set", upload.single("reference"), (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);

  if (!req.file) {
    return res.status(400).json({
      success: false,
      error: "reference image is required",
    });
  }

  const cropParams = parseCropParams(req.body);
  const guideTypes = ["rectangle", "keypoints", "silhouette"];
  const batchId = Date.now();
  const guides = {};

  try {
    for (const guideType of guideTypes) {
      const outputFilename = `guide_${guideType}_${batchId}.png`;
      const outputPath = path.join(path.dirname(req.file.path), outputFilename);

      if (cropParams) {
        runPythonGuideGenerator(req.file.path, outputPath, guideType, cropParams);
      } else {
        runPythonGuideGenerator(req.file.path, outputPath, guideType);
      }

      guides[guideType] = {
        filename: outputFilename,
        url: makeFileUrl(sessionId, outputFilename),
      };
    }
  } catch (error) {
    console.error("guide set generation failed:", error);
    return res.status(500).json({
      success: false,
      error: "guide set generation failed",
    });
  }

  res.json({
    success: true,
    sessionId,
    guides,
  });
});

// 撮影者Webがセッションの最新ガイド画像を取得
app.get("/api/session/:sessionId/guide", (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId);

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const sessionDir = getSessionDir(sessionId);

  if (!fs.existsSync(sessionDir)) {
    return res.json({
      success: true,
      guide: null,
    });
  }

  const guideFile = fs
    .readdirSync(sessionDir)
    .filter((file) => !file.startsWith(".") && file.startsWith("guide_"))
    .sort()
    .pop();

  if (!guideFile) {
    return res.json({
      success: true,
      guide: null,
    });
  }

  const url = makeFileUrl(sessionId, guideFile);

  res.json({
    success: true,
    guide: {
      filename: guideFile,
      url,
    },
  });
});

// セッションごとの保存済み写真一覧
app.get("/api/photos", (req, res) => {
  const sessionId = safeSessionId(req.query.sessionId, "");

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const sessionDir = getSessionDir(sessionId);

  if (!fs.existsSync(sessionDir)) {
    return res.json({
      success: true,
      files: [],
    });
  }

  const files = fs
    .readdirSync(sessionDir)
    .filter((file) => !file.startsWith(".") && !file.includes("guide_"))
    .map((file) => ({
      filename: file,
      url: makeFileUrl(sessionId, file),
    }));

  res.json({
    success: true,
    files,
  });
});

app.delete("/api/session/:sessionId", (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId, "");

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const deleted = removeSessionFiles(sessionId);
  notifySession(sessionId, {
    type: "session-deleted",
    sessionId,
    reason: "manual",
  });

  res.json({
    success: true,
    sessionId,
    deleted,
  });
});

// 動作確認用
app.get("/health", (req, res) => {
  res.json({
    success: true,
    message: "server is running",
  });
});

server.listen(port, "0.0.0.0", () => {
  cleanupExpiredSessions();
  setInterval(cleanupExpiredSessions, cleanupIntervalMs).unref();

  console.log(`Photo backend listening on http://0.0.0.0:${port}`);
  console.log(`Local page: http://localhost:${port}/?sessionId=test`);
  console.log(`LAN page: http://192.168.50.100:${port}/?sessionId=test`);
  console.log(`Session TTL: ${Math.round(sessionTtlMs / 60000)} minutes`);
});
