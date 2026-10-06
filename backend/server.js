const { ExperimentFlow } = require("./experiment_flow");
const { PROTOCOL, referenceFromPose, compareGuidance } = require("./research_guidance");
const express = require("express");
const multer = require("multer");
const path = require("path");
const guidanceConfigPath = process.env.GUIDANCE_CONFIG || path.join(__dirname, "guide_processor", "guidance_config.json");
const fs = require("fs");
const cors = require("cors");
const { createServer } = require("http");
const {shouldExpire,writeQuality,retained}=require("./research_data");
const {referenceForPlan}=require("./experiment_validation");
const { execFileSync } = require("child_process");
const { randomUUID } = require("crypto");
const { WebSocket, WebSocketServer } = require("ws");

const app = express();
const port = process.env.PORT || 3000;
const host = process.env.HOST || "127.0.0.1";
const sessionTtlMs = Number(process.env.SESSION_TTL_MS || 1000 * 60 * 60 * 6);
const cleanupIntervalMs = Number(process.env.CLEANUP_INTERVAL_MS || 1000 * 60 * 10);
const uploadFileSizeLimit = Number(process.env.UPLOAD_FILE_SIZE_LIMIT || 20 * 1024 * 1024);

// backend/uploads に保存する
const uploadRoot = path.join(__dirname, "uploads");
const referenceGuideRoot = path.join(__dirname, "data", "reference_guides");
const dataDirectories = {
  photos: "photos",
  drafts: "drafts",
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
fs.mkdirSync(referenceGuideRoot, { recursive: true });

function safeSessionId(value, fallback = "default") {
  return ((value || fallback).trim() || fallback).replace(/[^a-zA-Z0-9._-]/g, "_");
}

const storage = multer.diskStorage({
  destination(req, file, cb) {
    const sessionId = safeSessionId(req.flowCapture ? req.params.sessionId : req.body.sessionId || req.params?.sessionId);
    const dataType =
      file.fieldname === "guide"
        ? "guides"
        : file.fieldname === "reference"
          ? "references"
          : file.fieldname === "draft"
            ? "drafts"
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
    const isDraft = file.fieldname === "draft";
    const draftClientId = isDraft ? safeIdentifier(req.flowCapture?.clientId || req.body.clientId) : "";
    if (draftClientId) {
      cb(null, `draft_${draftClientId}.jpg`);
      return;
    }

    const namePrefix = isGuide
      ? "guide_"
      : isReference
        ? "reference_"
        : isDraft
          ? "draft_"
          : "";

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

function makeSessionRelativeFileUrl(sessionId, relativePath) {
  const encodedPath = String(relativePath)
    .split(path.sep)
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `/uploads/${encodeURIComponent(sessionId)}/${encodedPath}`;
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

function getReferencePoseDir(sessionId, referenceImageId) {
  return path.join(
    getExperimentDir(sessionId),
    "references",
    safeIdentifier(referenceImageId)
  );
}

function getReferencePosePath(sessionId, referenceImageId) {
  return path.join(getReferencePoseDir(sessionId, referenceImageId), "current.json");
}

function getGuideFeaturesDir(sessionId) {
  return path.join(getDataDir(sessionId, "guides"), "features");
}

function getGuideFeaturesPath(sessionId, guideId) {
  return path.join(getGuideFeaturesDir(sessionId), `${safeIdentifier(guideId)}.json`);
}

function getCanonicalGuideFeaturesPath(guideId) {
  return path.join(referenceGuideRoot, `${safeIdentifier(guideId)}.json`);
}

function getSessionGuideStatePath(sessionId) {
  return path.join(getSessionDir(sessionId), "current-guide.json");
}

function getSessionLifecyclePath(sessionId) {
  return path.join(getSessionDir(sessionId), "session-lifecycle.json");
}

function getAnalysisDir(sessionId) {
  return path.join(getSessionDir(sessionId), "analysis");
}

function getObservationPath(sessionId, photoId) {
  return path.join(getAnalysisDir(sessionId), "observations", `${safeIdentifier(photoId)}.json`);
}

function getRoleGuidancePath(sessionId, photoId) {
  return path.join(getAnalysisDir(sessionId), "role_guidance", `${safeIdentifier(photoId)}.json`);
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
    guidanceProtocolVersion: trial.guidanceProtocolVersion || "legacy-v1",
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

  try {
    execFileSync(pythonCommand, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = String(error.stderr || "");
    const userError = stderr.match(/GUIDE_USER_ERROR:([^\r\n]+)/);
    if (userError) {
      const guideError = new Error(userError[1].trim());
      guideError.statusCode = 422;
      throw guideError;
    }
    throw error;
  }
}

function sendGuideGenerationError(res, error, fallbackMessage) {
  const statusCode = error.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: error.statusCode ? error.message : fallbackMessage,
  });
}

function runReferencePoseExtractor(inputPath, outputPath, imageOutputPath, maskOutputPath) {
  const scriptPath = path.join(
    __dirname,
    "guide_processor",
    "extract_reference_pose.py"
  );
  const pythonCommand = process.env.PYTHON || "python3";
  execFileSync(
    pythonCommand,
    [
      scriptPath,
      "--input",
      inputPath,
      "--output",
      outputPath,
      "--image-output",
      imageOutputPath,
      "--mask-output",
      maskOutputPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

function runReferenceFeaturesExtractor(inputPath, outputPath, guideId, referencePhotoId, cropParams = null) {
  const scriptPath = path.join(
    __dirname,
    "guide_processor",
    "extract_reference_features.py"
  );
  const pythonCommand = process.env.PYTHON || "python3";
  const args = [
    scriptPath,
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--guide-id",
    guideId,
    "--reference-photo-id",
    referencePhotoId,
  ];
  if (cropParams) {
    args.push("--crop-x", String(cropParams.cropX));
    args.push("--crop-y", String(cropParams.cropY));
    args.push("--crop-width", String(cropParams.cropWidth));
    args.push("--crop-height", String(cropParams.cropHeight));
  }
  execFileSync(pythonCommand, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runLiveFeaturesExtractor(inputPath, outputPath, sessionId, trialId = "", source = "capturedPhoto") {
  const scriptPath = path.join(
    __dirname,
    "guide_processor",
    "extract_live_features.py"
  );
  const pythonCommand = process.env.PYTHON || "python3";
  const args = [
    scriptPath,
    "--input",
    inputPath,
    "--output",
    outputPath,
    "--session-id",
    sessionId,
    "--source",
    source,
  ];
  if (trialId) {
    args.push("--trial-id", trialId);
  }
  execFileSync(pythonCommand, args, {
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runRoleGuidance(referencePath, observationPath, outputPath, guideTransform = {}, condition = "B", configPath = guidanceConfigPath) {
  const scriptPath = path.join(__dirname, "guide_processor", "role_guidance.py");
  const pythonCommand = process.env.PYTHON || "python3";
  execFileSync(
    pythonCommand,
    [
      scriptPath,
      "--reference",
      referencePath,
      "--observation",
      observationPath,
      "--output",
      outputPath,
      "--guide-transform",
      JSON.stringify(guideTransform || {}),
      "--condition", condition,
      "--config", configPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
}

function validateReferencePose(body) {
  if (!body || !Array.isArray(body.keypoints) || body.keypoints.length === 0) {
    const error = new Error("keypoints are required");
    error.statusCode = 400;
    throw error;
  }
  const keypoints = body.keypoints.map((point) => {
    const name = requiredString(point.name, "keypoint name");
    const x = Number(point.x);
    const y = Number(point.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const error = new Error(`invalid coordinates for ${name}`);
      error.statusCode = 400;
      throw error;
    }
    return {
      name,
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
      confidence: Math.max(0, Math.min(1, Number(point.confidence) || 0)),
      isEnabled: point.isEnabled !== false,
    };
  });
  return {
    ...body,
    source: body.source || "manual-corrected",
    keypoints,
  };
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

function parseGuideTransform(value) {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return {};
    }
  }
  if (typeof value !== "object") return {};
  return value;
}

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseOptionalInteger(value) {
  const number = parseOptionalNumber(value);
  return number !== null && Number.isSafeInteger(number) && number >= 0
    ? number
    : null;
}

function parseTimestamp(value) {
  const numeric = parseOptionalNumber(value);
  if (numeric !== null) return numeric;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function analysisEventPayload(context, extra = {}) {
  return {
    analysisId: context.analysisId,
    sessionId: context.sessionId,
    trialId: context.trialId || null,
    photoId: context.photoId || null,
    clientId: context.clientId || null,
    captureSequence: context.captureSequence,
    captureTimestamp: context.captureTimestamp,
    analysisStartTimestamp: context.analysisStartTimestamp,
    guideId: context.guideId || null,
    ...extra,
  };
}

function findPhotoPath(sessionId, photoId) {
  const safePhotoId = safeIdentifier(photoId);
  const candidates = [
    path.join(getDataDir(sessionId, "photos"), safePhotoId),
    path.join(getDataDir(sessionId, "drafts"), safePhotoId),
    path.join(getSessionDir(sessionId), safePhotoId),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function latestGuideFeaturesPath(sessionId) {
  const featureFiles = listFiles(getGuideFeaturesDir(sessionId))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (featureFiles.length === 0) return null;
  return path.join(getGuideFeaturesDir(sessionId), featureFiles[0].filename);
}

function findGuideFeaturesAcrossSessions(guideId) {
  if (!guideId || !fs.existsSync(uploadRoot)) return null;
  for (const entry of fs.readdirSync(uploadRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = getGuideFeaturesPath(entry.name, guideId);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findGuideFeaturesPath(sessionId, guideId) {
  if (guideId) {
    if (sessionId) {
      const exactPath = getGuideFeaturesPath(sessionId, guideId);
      if (fs.existsSync(exactPath)) return exactPath;
    }
    const canonicalPath = getCanonicalGuideFeaturesPath(guideId);
    if (fs.existsSync(canonicalPath)) return canonicalPath;
    return findGuideFeaturesAcrossSessions(guideId);
  }
  return sessionId ? latestGuideFeaturesPath(sessionId) : null;
}

function publicFeatureFile(sessionId, guideId) {
  const filePath = findGuideFeaturesPath(sessionId, guideId);
  if (!filePath) return null;
  return readJsonFile(filePath);
}

function persistCanonicalGuideFeatures(featuresPath, guideId) {
  const features = readJsonFile(featuresPath);
  if (!features) return false;
  writeJsonFile(getCanonicalGuideFeaturesPath(guideId), features);
  return true;
}

function featuresPathFromUrl(featuresUrl, guideId) {
  if (!featuresUrl || !guideId) return null;
  try {
    const url = new URL(featuresUrl, "http://local");
    const expectedPath = `/api/guides/${encodeURIComponent(guideId)}/features`;
    if (url.pathname !== expectedPath) return null;
    const sourceSessionId = safeSessionId(url.searchParams.get("sessionId"), "");
    if (!sourceSessionId) return null;
    const sourcePath = getGuideFeaturesPath(sourceSessionId, guideId);
    return fs.existsSync(sourcePath) ? sourcePath : null;
  } catch {
    return null;
  }
}

function copyGuideFeaturesToSession(sessionId, guideId, featuresUrl) {
  if (!sessionId || !guideId) return false;
  const targetPath = getGuideFeaturesPath(sessionId, guideId);
  if (fs.existsSync(targetPath)) return true;
  const sourcePath =
    featuresPathFromUrl(featuresUrl, guideId) ||
    findGuideFeaturesPath("", guideId);
  const features = sourcePath ? readJsonFile(sourcePath) : null;
  if (!features) return false;
  writeJsonFile(targetPath, features);
  writeJsonFile(getCanonicalGuideFeaturesPath(guideId), features);
  return true;
}

function freezeTrialReference(sessionId, trial, referencePose) {
  const trialId = trial.trialId;
  if (!referencePose) throw new Error("参照姿勢を保存してから試行を作成してください");
  trial.guideId = `trial_${trialId}`;
  const reference = referenceFromPose(referencePose, trial.guideId);
  const referencePath = getGuideFeaturesPath(sessionId, trial.guideId);
  writeJsonFile(referencePath, reference);
  trial.guidanceConfig = readJsonFile(guidanceConfigPath);
  const trialConfigPath = path.join(getTrialDir(sessionId, trialId), "guidance-config.json");
  writeJsonFile(trialConfigPath, trial.guidanceConfig);
  const overlayName = `${trial.guideId}.png`;
  const overlayPath = path.join(getDataDir(sessionId, "guides"), overlayName);
  fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
  execFileSync(process.env.PYTHON || "python3", [path.join(__dirname, "guide_processor", "render_reference_guide.py"), referencePath, overlayPath, trialConfigPath], { stdio: ["ignore", "pipe", "pipe"] });
  trial.guideUrl = makeFileUrl(sessionId, overlayName, "guides");
  trial.referenceImageUrl = referencePose.image.url;
}

const validatedReferenceRenders=new Set();
function preparePlanReference(item, sessionId) {
  const config=readJsonFile(guidanceConfigPath);
  const {pose,source,reference}=referenceForPlan(uploadRoot,item,config);
  if (!sessionId) {
    const key=JSON.stringify({reference,config,python:process.env.PYTHON});
    if(!validatedReferenceRenders.has(key)){
      const temp=fs.mkdtempSync(path.join(require("node:os").tmpdir(),"plan-render-"));
      try {const input=path.join(temp,"reference.json"),output=path.join(temp,"guide.png");writeJsonFile(input,reference);
        execFileSync(process.env.PYTHON||"python3",[path.join(__dirname,"guide_processor/render_reference_guide.py"),input,output,guidanceConfigPath],{timeout:30000,stdio:["ignore","pipe","pipe"]});
        if(!fs.existsSync(output)||fs.statSync(output).size===0)throw Error("empty guide");
        validatedReferenceRenders.add(key);
      } catch {throw Object.assign(new Error("ReferenceGuideを生成できません。Pythonと設定を確認してください"),{code:"reference_guide_render_failed"});}
      finally{fs.rmSync(temp,{recursive:true,force:true});}
    }
    return pose;
  }
  const filename = `${randomUUID()}.jpg`;
  const target = path.join(getDataDir(sessionId,"references"),filename);
  fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);
  return {...pose,image:{filename,url:makeFileUrl(sessionId,filename,"references")}};
}

const participantFlow = new ExperimentFlow({
  sessionDir:getSessionDir,read:readJsonFile,write:writeJsonFile,loadTrial,saveTrial,loadSession:loadExperimentSession,
  saveSession:saveExperimentSession,log:appendTrialEvents,notify:notifySession,
  planDir:process.env.EXPERIMENT_PLAN_DIR || path.join(__dirname,"experiment_plans"),
  config:readJsonFile(process.env.EXPERIMENT_FLOW_CONFIG || path.join(__dirname,"experiment_flow_config.json")),
  prepareReference:preparePlanReference,
  createTrial(sessionId,item,index,totalTrials) {
    const session=loadExperimentSession(sessionId),pose=preparePlanReference(item,sessionId);
    const trial={schemaVersion:"1.0",guidanceProtocolVersion:PROTOCOL,flowProtocolVersion:"participant-flow-v1",trialId:randomUUID(),sessionId,
      participantId:session.participantId,pairId:session.pairId,conditionId:item.condition,referenceImageId:item.referenceImageId,
      referencePoseVersion:pose.versionId,isPractice:item.isPractice,trialIndex:index,totalTrials,maximumCaptureCount:item.maximumCaptureCount,
      supportLevel:2,state:"configured",startTime:null,endTime:null,finalPhotoId:null};
    freezeTrialReference(sessionId,trial,pose);saveTrial(sessionId,trial);return trial;
  },
  quality:s=>writeQuality(getSessionDir(s)),
  analysis:(s,id)=>readJsonFile(path.join(getAnalysisDir(s),"history",`${safeIdentifier(id)}.json`)),
  photoUrl(s,id) { return makeFileUrl(s,id,fs.existsSync(path.join(getDataDir(s,"photos"),id))?"photos":"drafts"); },
  sharePhoto(s,id) {
    const destination=path.join(getDataDir(s,"photos"),id);fs.mkdirSync(path.dirname(destination),{recursive:true});
    if(!fs.existsSync(destination))fs.copyFileSync(path.join(getDataDir(s,"drafts"),id),destination);
    notifySession(s,{type:"photos-updated",sessionId:s});
  },
  runAnalysis(s,t,c) {
    const request={flowInternal:true,params:{sessionId:s,photoId:c.photoId},body:{trialId:t.trialId,guideId:t.guideId,clientId:c.clientId,captureSequence:c.captureSequence,captureTimestamp:c.captureTimestamp}};
    const response={status(code){this.statusCode=code;return this;},json(value){if(value.success===false)participantFlow.analysisDone(s,{...request.body,analysisStatus:"failed",errorReason:value.error});return this;}};
    analyzeCapturedPhoto(request,response,error=>participantFlow.analysisDone(s,{...request.body,analysisId:error.analysisId,analysisStatus:"failed",errorReason:error.message}));
  }
});

app.use(cors());
app.use(express.json());

participantFlow.register(app);
// Researcher-only details; disabled unless an administrator secret is configured.
app.use("/api/research",(req,res,next)=>{
  if(!process.env.RESEARCH_ADMIN_TOKEN||req.get("X-Research-Token")!==process.env.RESEARCH_ADMIN_TOKEN)return res.sendStatus(403);
  res.set("Cache-Control","no-store");next();
});
app.get("/api/research/plans/validation",(req,res,next)=>{try{res.json({plans:participantFlow.planReports()});}catch(e){next(e);}});
app.get("/api/research/sessions/:sessionId/summary",(req,res,next)=>{try{if(!participantFlow.load(req.params.sessionId))return res.sendStatus(404);res.json(writeQuality(getSessionDir(req.params.sessionId)));}catch(e){next(e);}});
app.post("/api/research/sessions/:sessionId/terminate",(req,res,next)=>{try{const f=participantFlow.load(req.params.sessionId);if(!f)return res.sendStatus(404);if(!["technical_failure","researcher_terminated"].includes(req.body.status))return res.sendStatus(400);participantFlow.terminate(f,req.body.status,req.body.status);res.json({success:true});}catch(e){next(e);}});
// Managed participant sessions only accept their flow API and reserved draft uploads.
app.use("/api",(req,res,next)=>{
  const match=req.path.match(/^\/(?:session|sessions|experiments\/sessions)\/([^/]+)/);
  const sid=match?.[1] || req.body?.sessionId || req.query.sessionId;
  if(sid && retained(getSessionDir(sid))) {
    const draft=req.method==="POST" && /^\/sessions\/[^/]+\/draft-photos$/.test(req.path);
    if(req.path.endsWith("/events") || (req.method!=="GET" && !draft)) return res.status(403).json({success:false,error:"参加者用の実験画面から操作してください"});
  }
  next();
});

// アップロード画像を配信
app.use("/uploads", (req,res,next)=>{
  const parts=decodeURIComponent(req.path).split("/").filter(Boolean);
  if(parts[0] && retained(getSessionDir(parts[0])) && ["experiment","analysis"].includes(parts[1])) return res.sendStatus(403);
  next();
}, express.static(uploadRoot));

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

    if (shouldExpire(sessionDir,now,sessionTtlMs)) {
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
              offsetY: Number(payload.offsetY) || 0,
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
  const lifecycle = readJsonFile(getSessionLifecyclePath(sessionId));
  if (lifecycle?.status === "ended") {
    sendJson(ws, {
      type: "session-ended",
      sessionId,
      endedAt: lifecycle.endedAt,
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
      guidanceProtocolVersion: PROTOCOL,
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
    if (loadTrial(sessionId, trialId)) return res.status(409).json({ success: false, error: "trialId already exists" });
    const referenceImageId =
      String(req.body.referenceImageId || experiment.referenceImageId || "").trim() || null;
    const referencePose = referenceImageId
      ? readJsonFile(getReferencePosePath(sessionId, referenceImageId))
      : null;
    if (referenceImageId && !referencePose) {
      return res.status(409).json({
        success: false,
        error: "reference pose must be extracted and confirmed before creating a trial",
      });
    }
    if (
      referencePose &&
      Number(referencePose.personCount) !== 1 &&
      referencePose.personCountApproved !== true
    ) {
      return res.status(409).json({
        success: false,
        error: "reference pose person count must be approved before creating a trial",
      });
    }
    const trial = {
      guidanceProtocolVersion: experiment.guidanceProtocolVersion || "legacy-v1",
      schemaVersion: "1.0",
      trialId,
      sessionId,
      participantId: experiment.participantId,
      pairId: experiment.pairId,
      conditionId: experiment.conditionId,
      referenceImageId,
      referencePoseVersion: referencePose?.versionId || null,
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

    if (trial.guidanceProtocolVersion === PROTOCOL) {
      freezeTrialReference(sessionId, trial, referencePose);
    }
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

app.post(
  "/api/experiments/sessions/:sessionId/references/:referenceImageId/extract-pose",
  upload.single("reference"),
  (req, res, next) => {
    try {
      const sessionId = safeSessionId(req.params.sessionId, "");
      const referenceImageId = safeIdentifier(req.params.referenceImageId);
      if (!loadExperimentSession(sessionId)) {
        return res.status(404).json({
          success: false,
          error: "experiment session not found",
        });
      }
      if (!referenceImageId || !req.file) {
        return res.status(400).json({
          success: false,
          error: "referenceImageId and reference image are required",
        });
      }

      const poseDir = getReferencePoseDir(sessionId, referenceImageId);
      const versionsDir = path.join(poseDir, "versions");
      fs.mkdirSync(versionsDir, { recursive: true });
      const versionId = `auto-${Date.now()}`;
      const extractedPath = path.join(versionsDir, `${versionId}.json`);
      const processedFilename = `${referenceImageId}_processed.jpg`;
      const maskFilename = `${referenceImageId}_mask.png`;
      const processedPath = path.join(poseDir, processedFilename);
      const maskPath = path.join(poseDir, maskFilename);

      runReferencePoseExtractor(
        req.file.path,
        extractedPath,
        processedPath,
        maskPath
      );
      const extracted = readJsonFile(extractedPath);
      const now = new Date().toISOString();
      const pose = {
        ...extracted,
        schemaVersion: "1.0",
        sessionId,
        referenceImageId,
        versionId,
        parentVersionId: null,
        personCountApproved: extracted.personCount === 1,
        personCountApprovedBy: extracted.personCount === 1 ? "system" : null,
        personCountApprovedAt: extracted.personCount === 1 ? now : null,
        createdAt: now,
        updatedAt: now,
        image: {
          filename: processedFilename,
          url: makeSessionRelativeFileUrl(
            sessionId,
            path.relative(getSessionDir(sessionId), processedPath)
          ),
        },
        originalImage: {
          filename: req.file.filename,
          url: makeFileUrl(sessionId, req.file.filename, "references"),
        },
        silhouette: fs.existsSync(maskPath)
          ? {
              filename: maskFilename,
              url: makeSessionRelativeFileUrl(
                sessionId,
                path.relative(getSessionDir(sessionId), maskPath)
              ),
            }
          : null,
      };
      writeJsonFile(extractedPath, pose);
      writeJsonFile(getReferencePosePath(sessionId, referenceImageId), pose);

      const experiment = loadExperimentSession(sessionId);
      experiment.referenceImageId = referenceImageId;
      experiment.updatedAt = now;
      saveExperimentSession(experiment);
      notifySession(sessionId, {
        type: "reference-pose-updated",
        sessionId,
        referenceImageId,
        versionId,
      });
      res.status(201).json({ success: true, pose });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/experiments/sessions/:sessionId/references/:referenceImageId/pose",
  (req, res, next) => {
    try {
      const sessionId = safeSessionId(req.params.sessionId, "");
      const referenceImageId = safeIdentifier(req.params.referenceImageId);
      const pose = readJsonFile(getReferencePosePath(sessionId, referenceImageId));
      if (!pose) {
        return res.status(404).json({
          success: false,
          error: "reference pose not found",
        });
      }
      res.json({ success: true, pose });
    } catch (error) {
      next(error);
    }
  }
);

app.get(
  "/api/experiments/sessions/:sessionId/references/:referenceImageId/pose/versions/:versionId",
  (req, res, next) => {
    try {
      const sessionId = safeSessionId(req.params.sessionId, "");
      const referenceImageId = safeIdentifier(req.params.referenceImageId);
      const versionId = safeIdentifier(req.params.versionId);
      const pose = readJsonFile(
        path.join(
          getReferencePoseDir(sessionId, referenceImageId),
          "versions",
          `${versionId}.json`
        )
      );
      if (!pose) {
        return res.status(404).json({
          success: false,
          error: "reference pose version not found",
        });
      }
      res.json({ success: true, pose });
    } catch (error) {
      next(error);
    }
  }
);

app.put(
  "/api/experiments/sessions/:sessionId/references/:referenceImageId/pose",
  (req, res, next) => {
    try {
      const sessionId = safeSessionId(req.params.sessionId, "");
      const referenceImageId = safeIdentifier(req.params.referenceImageId);
      const current = readJsonFile(getReferencePosePath(sessionId, referenceImageId));
      if (!current) {
        return res.status(404).json({
          success: false,
          error: "extract a reference pose before saving corrections",
        });
      }

      const requiresPersonCountApproval = Number(current.personCount) !== 1;
      const personCountApproved =
        current.personCountApproved === true || req.body.personCountApproved === true;
      if (requiresPersonCountApproval && !personCountApproved) {
        return res.status(409).json({
          success: false,
          error: "person count approval is required before saving this reference pose",
        });
      }

      const corrected = validateReferencePose(req.body);
      const now = new Date().toISOString();
      const versionId = `manual-${Date.now()}`;
      const pose = {
        ...current,
        ...corrected,
        schemaVersion: "1.0",
        sessionId,
        referenceImageId,
        source: "manual-corrected",
        versionId,
        parentVersionId: current.versionId,
        createdAt: current.createdAt,
        updatedAt: now,
        correctedBy: String(req.body.correctedBy || "").trim() || null,
        personCountApproved:
          Number(current.personCount) === 1 || personCountApproved,
        personCountApprovedBy:
          Number(current.personCount) === 1
            ? current.personCountApprovedBy || "system"
            : current.personCountApprovedBy ||
              String(req.body.correctedBy || "").trim() ||
              null,
        personCountApprovedAt:
          Number(current.personCount) === 1
            ? current.personCountApprovedAt || current.createdAt || now
            : current.personCountApprovedAt || now,
      };
      const versionsDir = path.join(
        getReferencePoseDir(sessionId, referenceImageId),
        "versions"
      );
      writeJsonFile(path.join(versionsDir, `${versionId}.json`), pose);
      writeJsonFile(getReferencePosePath(sessionId, referenceImageId), pose);
      notifySession(sessionId, {
        type: "reference-pose-updated",
        sessionId,
        referenceImageId,
        versionId,
      });
      res.json({ success: true, pose });
    } catch (error) {
      next(error);
    }
  }
);

// 撮影直後解析用の下書き写真。iOSへはまだ共有しない。
app.post(
  "/api/sessions/:sessionId/draft-photos",
  (req,res,next)=>participantFlow.uploadGuard(req,res,next),
  upload.single("draft"),
  (req, res, next) => {
    try {
      const sessionId = safeSessionId(req.params.sessionId, "");
      if (!sessionId || !req.file) {
        return res.status(400).json({
          success: false,
          error: "sessionId and draft photo are required",
        });
      }

      const photoId = req.file.filename;
      const trialId = req.flowCapture?.trialId ?? safeIdentifier(req.body.trialId);
      const clientId = req.flowCapture?.clientId ?? safeIdentifier(req.body.clientId);
      const captureSequence = req.flowCapture?.captureSequence ?? parseOptionalInteger(req.body.captureSequence);
      const captureTimestamp = req.flowCapture?.captureTimestamp ?? parseTimestamp(req.body.captureTimestamp);
      const guideId = req.flowCapture?.guideId ?? safeIdentifier(req.body.guideId);
      const guideTransform = parseGuideTransform(req.body.guideTransform);
      participantFlow.captured(sessionId,photoId,{captureSequence,clientId});
      if (trialId) {
        try {
          appendTrialEvents(sessionId, trialId, [{
            role: "photographer",
            eventType: "photo_draft_uploaded",
            clientTimestamp: captureTimestamp
              ? new Date(captureTimestamp).toISOString()
              : null,
            payload: {
              photoId,
              clientId: clientId || null,
              captureSequence,
              captureTimestamp,
              guideId: guideId || null,
              guideTransform,
              status: "draft",
            },
          }]);
        } catch (error) {
          console.error("draft photo event logging failed:", error);
        }
      }

      res.json({
        success: true,
        sessionId,
        photo: {
          photoId,
          filename: photoId,
          status: "draft",
          clientId: clientId || null,
          captureSequence,
          captureTimestamp,
          trialId: trialId || null,
          guideId: guideId || null,
          guideTransform,
        },
      });
    } catch (error) {
      next(error);
    }
  }
);

app.delete("/api/sessions/:sessionId/draft-photos/:photoId", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const photoId = safeIdentifier(req.params.photoId);
    if (!sessionId || !photoId) {
      return res.status(400).json({ success: false, error: "sessionId and photoId are required" });
    }

    const draftPath = path.join(getDataDir(sessionId, "drafts"), photoId);
    const deleted = fs.existsSync(draftPath);
    if (deleted) fs.unlinkSync(draftPath);
    res.json({ success: true, sessionId, photoId, deleted });
  } catch (error) {
    next(error);
  }
});

// 選択中の下書きだけを正式写真へ昇格し、この時点で初めてiOSへ通知する。
app.post("/api/sessions/:sessionId/photos/share", (req, res, next) => {
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const sourcePhotoIds = Array.isArray(req.body.photoIds) ? req.body.photoIds : [];
    const photoIds = [...new Set(sourcePhotoIds.map((value) => safeIdentifier(value)).filter(Boolean))];
    if (!sessionId || photoIds.length === 0) {
      return res.status(400).json({ success: false, error: "sessionId and photoIds are required" });
    }
    if (photoIds.length > 50) {
      return res.status(400).json({ success: false, error: "a maximum of 50 photos can be shared" });
    }

    const draftDir = getDataDir(sessionId, "drafts");
    const photoDir = getDataDir(sessionId, "photos");
    fs.mkdirSync(photoDir, { recursive: true });
    const paths = photoIds.map((photoId) => ({
      photoId,
      draftPath: path.join(draftDir, photoId),
      photoPath: path.join(photoDir, photoId),
    }));
    const missingPhotoIds = paths
      .filter(({ draftPath, photoPath }) => !fs.existsSync(draftPath) && !fs.existsSync(photoPath))
      .map(({ photoId }) => photoId);
    if (missingPhotoIds.length > 0) {
      return res.status(404).json({
        success: false,
        error: "draft photos not found",
        missingPhotoIds,
      });
    }

    for (const { draftPath, photoPath } of paths) {
      if (fs.existsSync(draftPath) && !fs.existsSync(photoPath)) {
        fs.renameSync(draftPath, photoPath);
      }
    }

    const files = photoIds.map((filename) => ({
      filename,
      url: makeFileUrl(sessionId, filename, "photos"),
    }));
    const trialId = safeIdentifier(req.body.trialId);
    if (trialId) {
      try {
        appendTrialEvents(sessionId, trialId, [{
          role: "photographer",
          eventType: "photos_uploaded",
          clientTimestamp: req.body.clientTimestamp || null,
          payload: {
            photoCount: files.length,
            photoIds,
            source: "draftPromotion",
          },
        }]);
      } catch (error) {
        console.error("photo share event logging failed:", error);
      }
    }

    res.json({ success: true, sessionId, files });
    notifySession(sessionId, { type: "photos-updated", sessionId, files });
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
  const guideId = safeIdentifier(req.body.guideId);
  const sourceFeaturesUrl = String(req.body.featuresUrl || "").trim() || null;
  const featuresAvailable = guideId
    ? copyGuideFeaturesToSession(sessionId, guideId, sourceFeaturesUrl)
    : false;
  const featuresUrl = guideId
    ? `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`
    : null;

  const payload = {
    success: true,
    sessionId,
    guide: {
      guideId: guideId || null,
      filename: req.file.filename,
      url,
      featuresUrl,
      featuresAvailable,
    },
  };

  writeJsonFile(getSessionGuideStatePath(sessionId), payload.guide);

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
  const guideId = `guide_${safeGuideType}_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const outputFilename = `${guideId}.png`;
  const guideDir = getDataDir(sessionId, "guides");
  fs.mkdirSync(guideDir, { recursive: true });
  const outputPath = path.join(guideDir, outputFilename);
  const featuresPath = getGuideFeaturesPath(sessionId, guideId);

  try {
    if (cropParams) {
      runPythonGuideGenerator(req.file.path, outputPath, safeGuideType, cropParams);
    } else {
      runPythonGuideGenerator(req.file.path, outputPath, safeGuideType);
    }
    runReferenceFeaturesExtractor(
      req.file.path,
      featuresPath,
      guideId,
      req.file.filename,
      cropParams
    );
    persistCanonicalGuideFeatures(featuresPath, guideId);
  } catch (error) {
    console.error("guide generation failed:", error);
    return sendGuideGenerationError(res, error, "guide generation failed");
  }

  const url = makeFileUrl(sessionId, outputFilename, "guides");

  const payload = {
    success: true,
    sessionId,
    guide: {
      guideId,
      filename: outputFilename,
      url,
      featuresUrl: `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`,
      featuresAvailable: true,
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
  const batchId = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const guideId = `guide_set_${batchId}`;
  const guides = {};
  const guideDir = getDataDir(sessionId, "guides");
  fs.mkdirSync(guideDir, { recursive: true });
  const featuresPath = getGuideFeaturesPath(sessionId, guideId);

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
        guideId,
        filename: outputFilename,
        url: makeFileUrl(sessionId, outputFilename, "guides"),
        featuresUrl: `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`,
      };
    }
    runReferenceFeaturesExtractor(
      req.file.path,
      featuresPath,
      guideId,
      req.file.filename,
      cropParams
    );
    persistCanonicalGuideFeatures(featuresPath, guideId);
  } catch (error) {
    console.error("guide set generation failed:", error);
    return sendGuideGenerationError(res, error, "guide set generation failed");
  }

  res.json({
    success: true,
    sessionId,
    referenceGuide: {
      guideId,
      featuresUrl: `/api/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`,
    },
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

  const storedGuide = readJsonFile(getSessionGuideStatePath(sessionId));

  res.json({
    success: true,
    guide: {
      guideId: storedGuide?.guideId || null,
      filename: guideFile.filename,
      url,
      featuresUrl: storedGuide?.featuresUrl || null,
      featuresAvailable: storedGuide?.featuresAvailable === true,
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
        filename !== "current-guide.json" &&
        filename !== "session-lifecycle.json" &&
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

app.get("/api/guides/:guideId/features", (req, res) => {
  const guideId = safeIdentifier(req.params.guideId);
  const sessionId = safeSessionId(req.query.sessionId, "");

  if (!guideId) {
    return res.status(400).json({
      success: false,
      error: "guideId is required",
    });
  }
  const referenceGuide = publicFeatureFile(sessionId, guideId);
  if (!referenceGuide) {
    return res.status(404).json({
      success: false,
      error: "guide features not found",
    });
  }

  res.json({
    success: true,
    sessionId,
    guideId,
    referenceGuide,
  });
});

function analyzeCapturedPhoto(req, res, next) {
  const context = {
    analysisId: `analysis_${randomUUID()}`,
    sessionId: safeSessionId(req.params.sessionId, ""),
    trialId: safeIdentifier(req.body.trialId),
    photoId: safeIdentifier(req.params.photoId),
    clientId: safeIdentifier(req.body.clientId),
    captureSequence: parseOptionalInteger(req.body.captureSequence),
    captureTimestamp: parseTimestamp(req.body.captureTimestamp),
    analysisStartTimestamp: Date.now(),
    guideId: safeIdentifier(req.body.guideId),
  };
  const guideTransform = parseGuideTransform(req.body.guideTransform);

  const experiment = loadExperimentSession(context.sessionId);
  const trial = context.trialId ? loadTrial(context.sessionId, context.trialId) : null;
  if (experiment && (!trial || experiment.currentTrialId !== context.trialId || trial.state !== "running")) {
    return res.status(409).json({ success: false, error: "active running trial is required" });
  }
  if (trial?.guidanceProtocolVersion === PROTOCOL &&
      (context.guideId !== trial.guideId || context.captureSequence === null || context.captureTimestamp === null)) {
    return res.status(409).json({ success: false, error: "frozen trial guide and capture metadata are required" });
  }
  if (!participantFlow.load(context.sessionId)) notifySession(context.sessionId, {
    type: "analysisStarted",
    ...analysisEventPayload(context),
    guideTransform,
    analysisStatus: "started",
  });
  if (context.trialId) {
    try {
      appendTrialEvents(context.sessionId, context.trialId, [{
        role: "system",
        eventType: "role_guidance_analysis_started",
        payload: analysisEventPayload(context, { guideTransform }),
      }]);
    } catch (error) {
      console.error("analysis started event logging failed:", error);
    }
  }

  try {
    const { sessionId, photoId, guideId, trialId } = context;

    if (!sessionId || !photoId) {
      const error = new Error("sessionId and photoId are required");
      error.statusCode = 400;
      throw error;
    }

    const photoPath = findPhotoPath(sessionId, photoId);
    if (!photoPath) {
      const error = new Error("photo not found");
      error.statusCode = 404;
      throw error;
    }

    const progressive = !experiment || trial?.guidanceProtocolVersion === PROTOCOL;
    const condition = trial?.conditionId || "B";
    const referencePath = findGuideFeaturesPath(sessionId, guideId);
    if (!referencePath) {
      const error = new Error("reference guide features not found");
      error.statusCode = 404;
      throw error;
    }

    const observationPath = getObservationPath(sessionId, photoId);
    const guidancePath = getRoleGuidancePath(sessionId, photoId);
    runLiveFeaturesExtractor(photoPath, observationPath, sessionId, trialId, "capturedPhoto");
    const appliedTransform = trial?.guidanceProtocolVersion === PROTOCOL ? {} : guideTransform;
    const configPath = trial?.guidanceProtocolVersion === PROTOCOL
      ? path.join(path.dirname(getTrialPath(sessionId, trialId)), "guidance-config.json") : guidanceConfigPath;
    if (trial?.guidanceProtocolVersion === PROTOCOL) writeJsonFile(configPath, trial.guidanceConfig);
    runRoleGuidance(referencePath, observationPath, guidancePath, appliedTransform, progressive ? condition : "legacy", configPath);

    const referenceGuide = readJsonFile(referencePath);
    const liveObservation = readJsonFile(observationPath);
    const roleGuidance = readJsonFile(guidancePath);
    const analysisEndTimestamp = Date.now();
    const payload = {
      success: true,
      ...analysisEventPayload(context, {
        analysisEndTimestamp,
        guideId: referenceGuide?.guideId || guideId || null,
      }),
      ...roleGuidance,
      conditionId: condition,
      guidanceProtocolVersion: progressive ? PROTOCOL : "legacy-v1",
      referencePoseVersion: trial?.referencePoseVersion || null,
      guideTransform: appliedTransform,
      referenceGuide,
      liveObservation,
      alignmentError: roleGuidance.alignmentError,
      photographerGuidance: roleGuidance.photographerGuidance || [],
      subjectGuidance: roleGuidance.subjectGuidance || [],
      ready: roleGuidance.ready || {},
      analysisStatus: "completed",
      errorReason: null,
    };
    const statePath = path.join(getAnalysisDir(sessionId), `progress_${safeIdentifier(trialId || "normal")}_${safeIdentifier(guideId)}.json`);
    const previous = readJsonFile(statePath);
    payload.guidanceProgress = compareGuidance(previous, payload);
    payload.isLatestAnalysis = !previous || (Number.isSafeInteger(payload.captureSequence) && payload.captureSequence > previous.captureSequence);
    writeJsonFile(guidancePath, payload);
    writeJsonFile(path.join(getAnalysisDir(sessionId), "history", `${context.analysisId}.json`), payload);
    if (payload.isLatestAnalysis) writeJsonFile(statePath, payload);

    if (trialId) {
      try {
        appendTrialEvents(sessionId, trialId, [{
          role: "system",
          eventType: "role_guidance_analyzed",
          payload: {
            ...payload, referenceGuide: undefined, liveObservation: undefined,
            roleDecomposition: { photographerGuidance: payload.photographerGuidance, subjectGuidance: payload.subjectGuidance },
          },
        }]);
      } catch (error) {
        console.error("role guidance event logging failed:", error);
      }
    }

    participantFlow.analysisDone(sessionId,payload);
    if (!participantFlow.load(sessionId) && condition !== "A" && payload.isLatestAnalysis) {
      notifySession(sessionId, {
        type: "alignmentResult",
        ...analysisEventPayload(context, { analysisEndTimestamp }),
        alignmentError: roleGuidance.alignmentError,
      });
      notifySession(sessionId, {
        type: "roleGuidanceUpdated",
        ...payload,
        referenceGuide: undefined,
        liveObservation: undefined,
      });
      notifySession(sessionId, {
        type: "readyStateUpdated",
        ...analysisEventPayload(context, { analysisEndTimestamp }),
        ready: roleGuidance.ready,
      });

    }
    res.json(condition === "A" ? { ...analysisEventPayload(context), success: true, conditionId: "A", analysisStatus: "completed", guidanceSuppressed: true } : payload);
  } catch (error) {
    console.error("photo analysis failed:", error);
    const analysisEndTimestamp = Date.now();
    const failedPayload = analysisEventPayload(context, {
      analysisEndTimestamp,
      guideTransform,
      alignmentError: null,
      photographerGuidance: [],
      subjectGuidance: [],
      ready: {},
      analysisStatus: "failed",
      errorReason: error.message || "analysis failed",
    });
    participantFlow.analysisDone(context.sessionId,failedPayload);
    if (!participantFlow.load(context.sessionId)) notifySession(context.sessionId, {
      type: "analysisFailed",
      ...failedPayload,
    });
    if (context.trialId) {
      try {
        appendTrialEvents(context.sessionId, context.trialId, [{
          role: "system",
          eventType: "role_guidance_analysis_failed",
          payload: failedPayload,
        }]);
      } catch (loggingError) {
        console.error("analysis failure event logging failed:", loggingError);
      }
    }
    error.analysisId = context.analysisId;
    next(error);
  }
}
app.post("/api/sessions/:sessionId/photos/:photoId/analyze", analyzeCapturedPhoto);

app.post("/api/sessions/:sessionId/analyze-frame", upload.single("frame"), (req, res, next) => {
  let context = null;
  try {
    const sessionId = safeSessionId(req.params.sessionId, "");
    const trialId = safeIdentifier(req.body.trialId);
    const guideId = safeIdentifier(req.body.guideId);
    const guideTransform = parseGuideTransform(req.body.guideTransform);

    if (!sessionId || !req.file) {
      return res.status(400).json({
        success: false,
        error: "sessionId and frame are required",
      });
    }

    const referencePath = findGuideFeaturesPath(sessionId, guideId);
    if (!referencePath) {
      return res.status(404).json({
        success: false,
        error: "reference guide features not found",
      });
    }

    const frameId = path.parse(req.file.filename).name;
    context = {
      analysisId: `analysis_${randomUUID()}`,
      sessionId,
      trialId,
      photoId: frameId,
      clientId: safeIdentifier(req.body.clientId),
      captureSequence: parseOptionalInteger(req.body.captureSequence),
      captureTimestamp: parseTimestamp(req.body.captureTimestamp),
      analysisStartTimestamp: Date.now(),
      guideId,
    };
    notifySession(sessionId, {
      type: "analysisStarted",
      ...analysisEventPayload(context),
      analysisStatus: "started",
    });
    const observationPath = getObservationPath(sessionId, frameId);
    const guidancePath = getRoleGuidancePath(sessionId, frameId);
    runLiveFeaturesExtractor(req.file.path, observationPath, sessionId, trialId, "liveFrame");
    runRoleGuidance(referencePath, observationPath, guidancePath, guideTransform);

    const roleGuidance = readJsonFile(guidancePath);
    const analysisEndTimestamp = Date.now();
    const payload = {
      success: true,
      ...analysisEventPayload(context, {
        analysisEndTimestamp,
        guideId: guideId || readJsonFile(referencePath)?.guideId || null,
      }),
      frameId,
      guideTransform,
      liveObservation: readJsonFile(observationPath),
      alignmentError: roleGuidance.alignmentError,
      photographerGuidance: roleGuidance.photographerGuidance || [],
      subjectGuidance: roleGuidance.subjectGuidance || [],
      ready: roleGuidance.ready || {},
      analysisStatus: "completed",
      errorReason: null,
    };

    notifySession(sessionId, {
      type: "roleGuidanceUpdated",
      ...payload,
      liveObservation: undefined,
    });
    notifySession(sessionId, {
      type: "readyStateUpdated",
      sessionId,
      trialId: trialId || null,
      frameId,
      ready: roleGuidance.ready,
    });

    res.json(payload);
  } catch (error) {
    console.error("frame analysis failed:", error);
    if (context) {
      notifySession(context.sessionId, {
        type: "analysisFailed",
        ...analysisEventPayload(context, {
          analysisEndTimestamp: Date.now(),
          alignmentError: null,
          photographerGuidance: [],
          subjectGuidance: [],
          ready: {},
          analysisStatus: "failed",
          errorReason: error.message || "analysis failed",
        }),
      });
      error.analysisId = context.analysisId;
    }
    next(error);
  }
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

// iOS側から撮影終了を通知する。写真や実験ログなどの保存データは削除しない。
app.post("/api/session/:sessionId/end", (req, res) => {
  const sessionId = safeSessionId(req.params.sessionId, "");

  if (!sessionId) {
    return res.status(400).json({
      success: false,
      error: "sessionId is required",
    });
  }

  const lifecyclePath = getSessionLifecyclePath(sessionId);
  const existing = readJsonFile(lifecyclePath);
  const lifecycle = existing?.status === "ended"
    ? existing
    : {
        status: "ended",
        endedAt: new Date().toISOString(),
      };

  writeJsonFile(lifecyclePath, lifecycle);
  notifySession(sessionId, {
    type: "session-ended",
    sessionId,
    endedAt: lifecycle.endedAt,
  });

  res.json({
    success: true,
    sessionId,
    ...lifecycle,
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
    analysisId: error.analysisId || null,
  });
});

server.listen(port, host, () => {
  cleanupExpiredSessions();
  setInterval(cleanupExpiredSessions, cleanupIntervalMs).unref();

  console.log(`Photo backend listening on http://${host}:${port} (internal only)`);
  console.log(`Local page: http://${host}:${port}/?sessionId=test`);
  console.log(`Session TTL: ${Math.round(sessionTtlMs / 60000)} minutes`);
  console.log(`Upload file limit: ${Math.round(uploadFileSizeLimit / 1024 / 1024)} MB`);
});
