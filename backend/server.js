const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const cors = require("cors");
const { createServer } = require("http");
const { execFileSync } = require("child_process");
const { randomUUID } = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const port = process.env.PORT || 3000;
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 6);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS || 1000 * 60 * 10);
const uploadFileSizeLimit = Number(process.env.UPLOAD_FILE_SIZE_LIMIT || 20 * 1024 * 1024);

// backend/uploads に保存する
const uploadRoot = path.join(__dirname, "uploads");
const dataDirectories = {
  photos: "photos",
  references: "references",
  guides: "guides",
};
const experimentConditions = new Set(["A", "B", "C"]);
const trialStates = new Set([
  "configured",
  "ready",
  "running",
  "captured",
  "completed",
  "aborted",
]);

// ../photographer の index.html / script.js / style.css / guide.png を配信する
const photographerDir = path.join(__dirname, "..", "photographer");

fs.mkdirSync(uploadRoot, { recursive: true });

function safeSessionId(value, fallback = "default") {
  return ((value || fallback).trim() || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const sessionId = safeSessionId(req.body.sessionId || req.params?.sessionId);
    const dataType =
      file.fieldname === "guide"
        ? "guides"
        : file.fieldname === "reference"
          ? "references"
          : "photos";
    const destinationDir = getDataDir(sessionId, dataType);
    fs.mkdirSync(destinationDir, { recursive: true });
    cb(null, destinationDir);
  },

  filename(req, file, cb) {
    const timestamp = Date.now();
    const safeName = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");

    const isGuide = file.fieldname === "guide";
    const isReference = file.fieldname === "reference";
    const namePrefix = isGuide ? "guide_" : isReference ? "reference_" : "";

    const uniqueSuffix = Math.random().toString(36).slice(2, 8);
    cb(null, `${namePrefix}${timestamp}_${uniqueSuffix}_${safeName}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: uploadFileSizeLimit,
    files: 50,
  },
  fileFilter(req, file, cb) {
    if (!file.mimetype.startsWith("image/")) {
      cb(new Error("Only image uploads are allowed"));
      return;
    }
    cb(null, true);
  },
});

// 画像URLは絶対URLではなく相対URLで返す
// Cloudflare Tunnel / HTTPS 経由でも mixed content を避けやすくするため
function makeFileUrl(sessionId, filename, dataType = null) {
  const encodedParts = [
    encodeURIComponent(sessionId),
    dataType ? encodeURIComponent(dataDirectories[dataType]) : null,
    encodeURIComponent(filename),
  ].filter(Boolean);
  return `/uploads/${encodedParts.join("/")}`;
}

function getSessionDir(sessionId) {
  return path.join(uploadRoot, safeSessionId(sessionId));
}

function getDataDir(sessionId, dataType) {
  const directoryName = dataDirectories[dataType];
  if (!directoryName) {
    throw new Error(`Unknown data type: ${dataType}`);
  }
  return path.join(getSessionDir(sessionId), directoryName);
}

function getExperimentDir(sessionId) {
  return path.join(getSessionDir(sessionId), "experiment");
}

function getExperimentSessionPath(sessionId) {
  return path.join(getExperimentDir(sessionId), "session.json");
}

function getTrialDir(sessionId, trialId) {
  return path.join(getExperimentDir(sessionId), "trials", safeIdentifier(trialId));
}

function getTrialPath(sessionId, trialId) {
  return path.join(getTrialDir(sessionId, trialId), "trial.json");
}

function getTrialEventsPath(sessionId, trialId) {
  return path.join(getTrialDir(sessionId, trialId), "events.jsonl");
}

function safeIdentifier(value, fallback = "") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, "_");
}

function requiredString(value, fieldName) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    const error = new Error(`${fieldName} is required`);
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function normalizeCondition(value) {
  const conditionId = String(value || "").trim().toUpperCase();
  if (!experimentConditions.has(conditionId)) {
    const error = new Error("conditionId must be A, B, or C");
    error.statusCode = 400;
    throw error;
  }
  return conditionId;
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function appendJsonLines(filePath, values) {
  if (values.length === 0) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = values.map((value) => JSON.stringify(value)).join("\n");
  fs.appendFileSync(filePath, `${lines}\n`, "utf8");
}

function readJsonLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function loadExperimentSession(sessionId) {
  return readJsonFile(getExperimentSessionPath(sessionId));
}

function loadTrial(sessionId, trialId) {
  return readJsonFile(getTrialPath(sessionId, trialId));
}

function saveExperimentSession(session) {
  writeJsonFile(getExperimentSessionPath(session.sessionId), session);
}

function saveTrial(sessionId, trial) {
  writeJsonFile(getTrialPath(sessionId, trial.trialId), trial);
}

function publicExperimentState(sessionId) {
  const experiment = loadExperimentSession(sessionId);
  if (!experiment) return null;
  const currentTrial = experiment.currentTrialId
    ? loadTrial(sessionId, experiment.currentTrialId)
    : null;
  return {
    ...experiment,
    currentTrial,
  };
}

function appendTrialEvents(sessionId, trialId, events, defaults = {}) {
  const trial = loadTrial(sessionId, trialId);
  if (!trial) {
    const error = new Error("trial not found");
    error.statusCode = 404;
    throw error;
  }

  const serverTimestamp = new Date().toISOString();
  const eventsPath = getTrialEventsPath(sessionId, trialId);
  const existingEventIds = new Set(
    readJsonLines(eventsPath).map((event) => event.eventId)
  );
  const normalizedEvents = events.map((event, index) => ({
    schemaVersion: "1.0",
    eventId: safeIdentifier(event.eventId) || randomUUID(),
    participantId: trial.participantId,
    pairId: trial.pairId,
    sessionId,
    conditionId: trial.conditionId,
    trialId,
    role: event.role || defaults.role || "system",
    eventType: requiredString(event.eventType, "eventType"),
    clientTimestamp: event.clientTimestamp || null,
    serverTimestamp,
    sequenceNumber: Number.isFinite(Number(event.sequenceNumber))
      ? Number(event.sequenceNumber)
      : null,
    payload: event.payload && typeof event.payload === "object" ? event.payload : {},
    batchIndex: index,
  })).filter((event) => !existingEventIds.has(event.eventId));
  appendJsonLines(eventsPath, normalizedEvents);
  return normalizedEvents;
}

function listFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => {
      const filePath = path.join(directory, entry.name);
      return {
        filename: entry.name,
        mtimeMs: fs.statSync(filePath).mtimeMs,
      };
    });
}

function listLegacyFiles(sessionId, predicate) {
  const sessionDir = getSessionDir(sessionId);
  if (!fs.existsSync(sessionDir)) return [];
  return fs
    .readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && predicate(entry.name))
    .map((entry) => {
      const filePath = path.join(sessionDir, entry.name);
      return {
        filename: entry.name,
        mtimeMs: fs.statSync(filePath).mtimeMs,
        legacy: true,
      };
    });
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
  noServer: true,
  perMessageDeflate: false,
});

const sessionWss = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

// A single HTTP server must route each upgrade request to exactly one
// WebSocketServer. Attaching multiple WebSocketServer instances directly to
// the same server makes the non-matching instance reject an already accepted
// connection.
server.on("upgrade", (req, socket, head) => {
  let pathname;

  try {
    pathname = new URL(req.url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    socket.destroy();
    return;
  }

  const targetServer =
    pathname === "/ws/video"
      ? wss
      : pathname === "/ws/session"
        ? sessionWss
        : null;

  if (!targetServer) {
    socket.destroy();
    return;
  }

  targetServer.handleUpgrade(req, socket, head, (ws) => {
    targetServer.emit("connection", ws, req);
  });
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
  const experiment = publicExperimentState(sessionId);
  if (experiment) {
    sendJson(ws, {
      type: "experiment-configured",
      sessionId,
      experiment,
    });
  }

  ws.on("close", () => {
    session.watchers.delete(ws);
    cleanupSession(sessionId);
  });

  ws.on("error", (error) => {
    console.error("session WebSocket error:", error);
  });
});

// MARK: - Experiment session API

app.post("/api/experiments/sessions", (req, res, next) => {
  try {
    const participantId = requiredString(req.body.participantId, "participantId");
    const pairId = requiredString(req.body.pairId, "pairId");
    const conditionId = normalizeCondition(req.body.conditionId);
    const sessionId = safeSessionId(req.body.sessionId || randomUUID(), "");
    const now = new Date().toISOString();

    if (loadExperimentSession(sessionId)) {
      return res.status(409).json({
        success: false,
        error: "experiment session already exists",
      });
    }

    const experiment = {
      schemaVersion: "1.0",
      sessionId,
      participantId,
      pairId,
      conditionId,
      referenceImageId: String(req.body.referenceImageId || "").trim() || null,
      supportLevel: Number(req.body.supportLevel || 1),
      status: "configured",
      currentTrialId: null,
      createdAt: now,
      updatedAt: now,
    };

    saveExperimentSession(experiment);
    res.status(201).json({
      success: true,
      experiment,
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/sessions/:sessionId", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const experiment = publicExperimentState(sessionId);
    if (!experiment) {
      return res.status(404).json({
        success: false,
        error: "experiment session not found",
      });
    }
    res.json({
      success: true,
      experiment,
    });
  } catch (error) {
    next(error);
  }
});

app.patch("/api/experiments/sessions/:sessionId/condition", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const experiment = loadExperimentSession(sessionId);
    if (!experiment) {
      return res.status(404).json({
        success: false,
        error: "experiment session not found",
      });
    }

    const currentTrial = experiment.currentTrialId
      ? loadTrial(sessionId, experiment.currentTrialId)
      : null;
    if (currentTrial && ["running", "captured"].includes(currentTrial.state)) {
      return res.status(409).json({
        success: false,
        error: "condition cannot be changed during a trial",
      });
    }

    experiment.conditionId = normalizeCondition(req.body.conditionId);
    experiment.updatedAt = new Date().toISOString();
    saveExperimentSession(experiment);
    notifySession(sessionId, {
      type: "experiment-configured",
      sessionId,
      experiment: publicExperimentState(sessionId),
    });
    res.json({
      success: true,
      experiment: publicExperimentState(sessionId),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/experiments/sessions/:sessionId/trials", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const experiment = loadExperimentSession(sessionId);
    if (!experiment) {
      return res.status(404).json({
        success: false,
        error: "experiment session not found",
      });
    }

    const activeTrial = experiment.currentTrialId
      ? loadTrial(sessionId, experiment.currentTrialId)
      : null;
    if (activeTrial && !["completed", "aborted"].includes(activeTrial.state)) {
      return res.status(409).json({
        success: false,
        error: "active trial already exists",
      });
    }

    const now = new Date().toISOString();
    const trialId = safeIdentifier(req.body.trialId) || randomUUID();
    const trial = {
      schemaVersion: "1.0",
      trialId,
      sessionId,
      participantId: experiment.participantId,
      pairId: experiment.pairId,
      conditionId: experiment.conditionId,
      referenceImageId:
        String(req.body.referenceImageId || experiment.referenceImageId || "").trim() || null,
      selectedGuideType: String(req.body.selectedGuideType || "").trim() || null,
      supportLevel: Number(req.body.supportLevel || experiment.supportLevel || 1),
      isPractice: Boolean(req.body.isPractice),
      state: "configured",
      startTime: null,
      endTime: null,
      finalPhotoId: null,
      abortReason: null,
      createdAt: now,
      updatedAt: now,
    };

    saveTrial(sessionId, trial);
    experiment.currentTrialId = trialId;
    experiment.status = "configured";
    experiment.referenceImageId = trial.referenceImageId;
    experiment.updatedAt = now;
    saveExperimentSession(experiment);
    notifySession(sessionId, {
      type: "experiment-configured",
      sessionId,
      experiment: publicExperimentState(sessionId),
    });
    res.status(201).json({
      success: true,
      trial,
      experiment: publicExperimentState(sessionId),
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/experiments/trials/:trialId/start", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.body.sessionId, "");
    const trialId = safeIdentifier(req.params.trialId);
    const experiment = loadExperimentSession(sessionId);
    const trial = loadTrial(sessionId, trialId);
    if (!experiment || !trial) {
      return res.status(404).json({
        success: false,
        error: "experiment session or trial not found",
      });
    }
    if (!["configured", "ready"].includes(trial.state)) {
      return res.status(409).json({
        success: false,
        error: `trial cannot start from ${trial.state}`,
      });
    }

    const now = new Date().toISOString();
    trial.state = "running";
    trial.startTime = now;
    trial.updatedAt = now;
    saveTrial(sessionId, trial);
    experiment.status = "running";
    experiment.currentTrialId = trialId;
    experiment.updatedAt = now;
    saveExperimentSession(experiment);
    appendTrialEvents(sessionId, trialId, [{
      role: "experimenter",
      eventType: "trial_started",
      clientTimestamp: req.body.clientTimestamp || null,
      payload: {},
    }]);
    notifySession(sessionId, {
      type: "trial-state-changed",
      sessionId,
      trial,
    });
    res.json({ success: true, trial });
  } catch (error) {
    next(error);
  }
});

app.post("/api/experiments/trials/:trialId/end", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.body.sessionId, "");
    const trialId = safeIdentifier(req.params.trialId);
    const experiment = loadExperimentSession(sessionId);
    const trial = loadTrial(sessionId, trialId);
    if (!experiment || !trial) {
      return res.status(404).json({
        success: false,
        error: "experiment session or trial not found",
      });
    }
    if (["completed", "aborted"].includes(trial.state)) {
      return res.status(409).json({
        success: false,
        error: "trial is already closed",
      });
    }

    const requestedState = req.body.state === "aborted" ? "aborted" : "completed";
    const now = new Date().toISOString();
    trial.state = requestedState;
    trial.endTime = now;
    trial.finalPhotoId = String(req.body.finalPhotoId || "").trim() || null;
    trial.abortReason =
      requestedState === "aborted"
        ? requiredString(req.body.abortReason, "abortReason")
        : null;
    trial.updatedAt = now;
    saveTrial(sessionId, trial);
    experiment.status = requestedState;
    experiment.updatedAt = now;
    saveExperimentSession(experiment);
    appendTrialEvents(sessionId, trialId, [{
      role: "experimenter",
      eventType: requestedState === "aborted" ? "trial_aborted" : "trial_completed",
      clientTimestamp: req.body.clientTimestamp || null,
      payload: {
        finalPhotoId: trial.finalPhotoId,
        abortReason: trial.abortReason,
      },
    }]);
    notifySession(sessionId, {
      type: "trial-state-changed",
      sessionId,
      trial,
    });
    res.json({ success: true, trial });
  } catch (error) {
    next(error);
  }
});

app.post("/api/experiments/trials/:trialId/events", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.body.sessionId, "");
    const trialId = safeIdentifier(req.params.trialId);
    const sourceEvents = Array.isArray(req.body.events)
      ? req.body.events
      : req.body.event
        ? [req.body.event]
        : [];
    if (sourceEvents.length === 0) {
      return res.status(400).json({
        success: false,
        error: "events are required",
      });
    }
    if (sourceEvents.length > 100) {
      return res.status(400).json({
        success: false,
        error: "a maximum of 100 events can be sent at once",
      });
    }
    const events = appendTrialEvents(sessionId, trialId, sourceEvents, {
      role: req.body.role,
    });
    res.status(201).json({
      success: true,
      accepted: events.length,
      eventIds: events.map((event) => event.eventId),
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/experiments/trials/:trialId/events", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.query.sessionId, "");
    const trialId = safeIdentifier(req.params.trialId);
    if (!loadTrial(sessionId, trialId)) {
      return res.status(404).json({
        success: false,
        error: "trial not found",
      });
    }
    res.json({
      success: true,
      events: readJsonLines(getTrialEventsPath(sessionId, trialId)),
    });
  } catch (error) {
    next(error);
  }
});

// 撮影者Webから写真を送信
app.post("/api/photos", upload.array("photos"), (req, res, next) => {
  const sessionId = safeSessionId(req.body.sessionId);

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({
      success: false,
      error: "photos are required",
    });
  }

  const files = req.files.map((file) => ({
    filename: file.filename,
    url: makeFileUrl(sessionId, file.filename, "photos"),
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

  const trialId = safeIdentifier(req.body.trialId);
  if (trialId) {
    try {
      appendTrialEvents(sessionId, trialId, [{
        role: "photographer",
        eventType: "photos_uploaded",
        clientTimestamp: req.body.clientTimestamp || null,
        payload: {
          photoCount: files.length,
          photoIds: files.map((file) => file.filename),
        },
      }]);
    } catch (error) {
      console.error("photo upload event logging failed:", error);
    }
  }
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

  const url = makeFileUrl(sessionId, req.file.filename, "guides");

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
  const guideDir = getDataDir(sessionId, "guides");
  fs.mkdirSync(guideDir, { recursive: true });
  const outputPath = path.join(guideDir, outputFilename);

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

  const url = makeFileUrl(sessionId, outputFilename, "guides");

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
  const guideDir = getDataDir(sessionId, "guides");
  fs.mkdirSync(guideDir, { recursive: true });

  try {
    for (const guideType of guideTypes) {
      const outputFilename = `guide_${guideType}_${batchId}.png`;
      const outputPath = path.join(guideDir, outputFilename);

      if (cropParams) {
        runPythonGuideGenerator(req.file.path, outputPath, guideType, cropParams);
      } else {
        runPythonGuideGenerator(req.file.path, outputPath, guideType);
      }

      guides[guideType] = {
        filename: outputFilename,
        url: makeFileUrl(sessionId, outputFilename, "guides"),
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

  const guideFiles = [
    ...listFiles(getDataDir(sessionId, "guides")),
    ...listLegacyFiles(sessionId, (filename) => filename.startsWith("guide_")),
  ].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const guideFile = guideFiles[0];

  if (!guideFile) {
    return res.json({
      success: true,
      guide: null,
    });
  }

  const url = makeFileUrl(
    sessionId,
    guideFile.filename,
    guideFile.legacy ? null : "guides"
  );

  res.json({
    success: true,
    guide: {
      filename: guideFile.filename,
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

  const files = [
    ...listFiles(getDataDir(sessionId, "photos")).map((file) => ({
      ...file,
      url: makeFileUrl(sessionId, file.filename, "photos"),
    })),
    ...listLegacyFiles(
      sessionId,
      (filename) =>
        !filename.startsWith("guide_") &&
        !filename.startsWith("reference_")
    ).map((file) => ({
      ...file,
      url: makeFileUrl(sessionId, file.filename),
    })),
  ]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(({ filename, url }) => ({ filename, url }));

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

app.use((error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof multer.MulterError) {
    const statusCode = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    res.status(statusCode).json({
      success: false,
      error: error.code,
    });
    return;
  }

  console.error("request failed:", error);
  res.status(error.statusCode || 400).json({
    success: false,
    error: error.message || "request failed",
  });
});

server.listen(port, "0.0.0.0", () => {
  cleanupExpiredSessions();
  setInterval(cleanupExpiredSessions, cleanupIntervalMs).unref();

  console.log(`Photo backend listening on http://0.0.0.0:${port}`);
  console.log(`Local page: http://localhost:${port}/?sessionId=test`);
  console.log(`Session TTL: ${Math.round(sessionTtlMs / 60000)} minutes`);
  console.log(`Upload file limit: ${Math.round(uploadFileSizeLimit / 1024 / 1024)} MB`);
});
