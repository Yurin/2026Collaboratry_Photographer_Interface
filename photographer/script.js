const video = document.getElementById("video");
const guide = document.getElementById("guide");
const cameraStage = document.querySelector(".camera-stage");
const gridOverlay = document.getElementById("gridOverlay");
const opacitySlider = document.getElementById("opacitySlider");
const toggleGridBtn = document.getElementById("toggleGridBtn");
const toggleGuideBtn = document.getElementById("toggleGuideBtn");
const captureBtn = document.getElementById("captureBtn");
const canvas = document.getElementById("canvas");
const thumbnailContainer = document.getElementById("thumbnailContainer");
const photoCount = document.getElementById("photoCount");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const shareLiveBtn = document.getElementById("shareLiveBtn");
const deleteSessionBtn = document.getElementById("deleteSessionBtn");
const viewGalleryBtn = document.getElementById("viewGalleryBtn");
const closeGalleryBtn = document.getElementById("closeGalleryBtn");
const gallerySummary = document.getElementById("gallerySummary");
const galleryEmptyMessage = document.getElementById("galleryEmptyMessage");
const photoPreviewOverlay = document.getElementById("photoPreviewOverlay");
const previewImage = document.getElementById("previewImage");
const closePreviewBtn = document.getElementById("closePreviewBtn");
const postSendDialog = document.getElementById("postSendDialog");
const continueCaptureBtn = document.getElementById("continueCaptureBtn");
const finishCaptureBtn = document.getElementById("finishCaptureBtn");
const capturePanel = document.getElementById("capturePanel");
const galleryPanel = document.getElementById("galleryPanel");
const errorPanel = document.getElementById("errorPanel");
const supportPanel = document.getElementById("supportPanel");
const supportMessage = document.getElementById("supportMessage");
const roleGuidancePanel = document.getElementById("roleGuidancePanel");
const roleGuidancePhoto = document.getElementById("roleGuidancePhoto");
const analysisState = document.getElementById("analysisState");
const photographerGuidanceList = document.getElementById("photographerGuidanceList");
const framingReady = document.getElementById("framingReady");
const poseReady = document.getElementById("poseReady");
const captureReady = document.getElementById("captureReady");
const experimentStatus = document.getElementById("experimentStatus");
const guideControls = document.querySelectorAll(".guide-control");
const status = document.querySelector(".status");

const API_BASE_PATH = "/api";

let selectedPhotoIndex = null;

let showGuide = true;
let showGrid = true;
let currentStream = null;
// 撮影済み写真は、表示用画像と下書きphotoId・解析状態を一体で管理する。
let photos = [];
let latestCapturedClientId = null;
let isSendingPhotos = false;
let sessionId = "";
let wsVideo = null;
let wsSession = null;
let shareActive = false;
let liveInterval = null;
let guideUrlOverride = null;
let reconnectTimer = null;
let sessionSocketClosedByUser = false;
let guideTransform = {
  offsetX: 0,
  offsetY: 0,
  scale: 1,
  opacity: 0.5,
};
let supportMessageTimer = null;
let experimentCondition = null;
let currentTrialId = null;
let currentTrialState = null;
let activeGuideId = null;
let verifiedGuideIds = new Set();
let latestRoleGuidance = null;
let captureSequence = 0;
let latestDisplayedCaptureSequence = null;
let lastDisplayedReady = {};
let eventSequence = 0;
let pendingEvents = [];
const shareCanvas = document.createElement("canvas");

function shortenSessionId(value) {
  if (!value) return "";
  if (value.length <= 18) return value;
  return `${value.slice(0, 10)}...${value.slice(-6)}`;
}

function setStatus(text) {
  status.textContent = text;
  status.title = text;
}

function setConnectionState(state) {
  const labels = {
    connecting: "接続中",
    connected: "接続済み",
    disconnected: "切断",
    reconnecting: "再接続中",
  };

  setStatus(
    sessionId
      ? `セッション: ${shortenSessionId(sessionId)} - ${labels[state]}`
      : labels[state]
  );
}

function showError(message) {
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}

function clearError() {
  errorPanel.textContent = "";
  errorPanel.hidden = true;
}

function showActionHint(message) {
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}

function showSupportMessage(message, options = {}) {
  supportMessage.textContent = message;
  supportPanel.hidden = false;

  clearTimeout(supportMessageTimer);
  if (options.autoHideMs) {
    supportMessageTimer = setTimeout(() => {
      supportPanel.hidden = true;
      supportMessage.textContent = "";
    }, options.autoHideMs);
  }
}

function photographerGuidanceEnabled() {
  return experimentCondition !== "A";
}

function nowTimestamp() {
  return Date.now();
}

function captureSequenceStorageKey() {
  return `photoGuideCaptureSequence:${sessionId}`;
}

function restoreCaptureSequence() {
  const storedSequence = Number(localStorage.getItem(captureSequenceStorageKey()));
  captureSequence = Number.isSafeInteger(storedSequence) && storedSequence >= 0
    ? storedSequence
    : 0;
}

function nextCaptureSequence() {
  captureSequence += 1;
  localStorage.setItem(captureSequenceStorageKey(), String(captureSequence));
  return captureSequence;
}

function recordForAnalysisPayload(payload) {
  return photos.find((item) =>
    (payload.photoId && item.draftPhotoId === payload.photoId) ||
    (payload.clientId && item.clientId === payload.clientId) ||
    (Number.isFinite(Number(payload.captureSequence)) &&
      item.captureSequence === Number(payload.captureSequence))
  );
}

function latestActiveCaptureSequence() {
  return photos.reduce(
    (latest, item) => item.deleted ? latest : Math.max(latest, item.captureSequence),
    -1
  );
}

function shouldDisplayAnalysisPayload(payload, record) {
  const payloadSequence = Number(payload.captureSequence ?? record?.captureSequence);
  return Boolean(
    record &&
    !record.deleted &&
    Number.isFinite(payloadSequence) &&
    payloadSequence >= latestActiveCaptureSequence() &&
    (latestDisplayedCaptureSequence === null || payloadSequence >= latestDisplayedCaptureSequence) &&
    (!currentTrialId || !record.trialId || record.trialId === currentTrialId) &&
    (!payload.guideId || payload.guideId === activeGuideId)
  );
}

function logReadyTransitions(record, payload, timestamp) {
  const nextReady = payload.ready || {};
  ["framingReady", "poseReady", "captureReady"].forEach((readyKey) => {
    const previousValue = lastDisplayedReady[readyKey];
    const newValue = nextReady[readyKey];
    if (typeof previousValue === "boolean" &&
        typeof newValue === "boolean" &&
        previousValue !== newValue) {
      logExperimentEvent("ready_state_changed", {
        type: "ready_state_changed",
        sessionId,
        trialId: record.trialId,
        analysisId: payload.analysisId || record.analysisId,
        photoId: record.draftPhotoId,
        captureSequence: record.captureSequence,
        readyKey,
        previousValue,
        newValue,
        timestamp,
      }, record.trialId);
    }
    if (typeof newValue === "boolean") lastDisplayedReady[readyKey] = newValue;
  });
}

function displayCompletedAnalysis(record, payload) {
  if (!shouldDisplayAnalysisPayload(payload, record)) return false;
  const timestamp = nowTimestamp();
  const analysisId = payload.analysisId || record.analysisId || null;
  const isFirstDisplay = record.displayedAnalysisId !== analysisId;
  latestDisplayedCaptureSequence = record.captureSequence;
  record.displayTimestamp = record.displayTimestamp || timestamp;
  record.webGuidanceDisplayTimestamp = record.webGuidanceDisplayTimestamp || timestamp;
  record.displayedAnalysisId = analysisId;
  renderRoleGuidance(payload);
  if (isFirstDisplay) {
    logReadyTransitions(record, payload, timestamp);
    logAnalysisEvent(record, "photographer_guidance_displayed", {
      analysisId,
      webGuidanceDisplayTimestamp: record.webGuidanceDisplayTimestamp,
      photographerGuidance: payload.photographerGuidance || [],
      ready: payload.ready || {},
    });
  }
  return true;
}

function updateReadyChip(element, label, value) {
  const known = typeof value === "boolean";
  element.textContent = `${label} ${known ? (value ? "OK" : "調整中") : "—"}`;
  element.classList.toggle("is-ready", value === true);
}

function renderRoleGuidance(payload = latestRoleGuidance) {
  latestRoleGuidance = payload || null;
  if (!payload || !photographerGuidanceEnabled()) {
    roleGuidancePanel.hidden = true;
    return;
  }

  roleGuidancePanel.hidden = false;
  roleGuidancePhoto.textContent = payload.photoId ? `写真: ${payload.photoId}` : "";
  analysisState.textContent = payload.analysisState || "解析済み";
  photographerGuidanceList.innerHTML = "";

  const guidance = Array.isArray(payload.photographerGuidance)
    ? payload.photographerGuidance
    : [];
  const messages = guidance.length > 0
    ? guidance
    : [{ message: payload.errorMessage || "解析できませんでした", severity: "low" }];
  messages.forEach((item) => {
    const row = document.createElement("li");
    row.textContent = item.message;
    row.dataset.severity = item.severity || "low";
    photographerGuidanceList.appendChild(row);
  });

  updateReadyChip(framingReady, "構図", payload.ready?.framingReady);
  updateReadyChip(poseReady, "ポーズ", payload.ready?.poseReady);
  updateReadyChip(captureReady, "撮影", payload.ready?.captureReady);
}

function showAnalysisProgress(photoId = null) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [{ message: "撮影した写真を解析しています…", severity: "low" }],
    ready: {},
    analysisState: "解析中",
  });
}

function showAnalysisWaiting(photoId = null) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [{ message: "解析の準備をしています…", severity: "low" }],
    ready: {},
    analysisState: "解析待ち",
  });
}

function showAnalysisSkipped(photoId, message) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [{ message, severity: "low" }],
    ready: {},
    analysisState: "解析スキップ",
  });
}

function showAnalysisFailure(photoId = null, errorReason = null) {
  renderRoleGuidance({
    photoId,
    photographerGuidance: [],
    ready: {},
    analysisState: "解析失敗",
    errorMessage: errorReason ? `解析できませんでした: ${errorReason}` : "解析できませんでした",
  });
}

function applySessionGuide(guideState) {
  if (!guideState) return;
  const nextGuideId = guideState.guideId || null;
  if (activeGuideId !== nextGuideId) {
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
    verifiedGuideIds.clear();
    lastDisplayedReady = {};
  }
  activeGuideId = nextGuideId;
  if (guideState.url) applyGuideUrl(guideState.url);
}

function applyExperimentState(experiment) {
  if (!experiment) {
    experimentCondition = null;
    currentTrialId = null;
    currentTrialState = null;
    experimentStatus.hidden = true;
    guideControls.forEach((element) => {
      element.hidden = false;
    });
    renderRoleGuidance();
    return;
  }

  experimentCondition = experiment.conditionId;
  currentTrialId = experiment.currentTrial?.trialId || experiment.currentTrialId || null;
  currentTrialState = experiment.currentTrial?.state || experiment.status || null;
  experimentStatus.textContent = currentTrialId
    ? `実験撮影・試行 ${currentTrialState || "準備中"}`
    : "実験撮影・試行準備中";
  experimentStatus.hidden = false;

  const photographerSupportEnabled =
    experimentCondition === "B" || experimentCondition === "C";
  guideControls.forEach((element) => {
    element.hidden = !photographerSupportEnabled;
  });

  if (!photographerSupportEnabled) {
    guide.hidden = true;
    supportPanel.hidden = true;
    roleGuidancePanel.hidden = true;
  } else if (showGuide && guideUrlOverride) {
    guide.hidden = false;
  }
  renderRoleGuidance();
}

async function fetchExperimentState() {
  if (!sessionId) return;
  try {
    const response = await fetch(
      `${API_BASE_PATH}/experiments/sessions/${encodeURIComponent(sessionId)}`
    );
    if (response.status === 404) {
      applyExperimentState(null);
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    applyExperimentState(data.experiment);
    await flushPendingEvents();
  } catch (error) {
    console.error("experiment state fetch error", error);
  }
}

function makeEvent(eventType, payload = {}, trialId = currentTrialId) {
  eventSequence += 1;
  return {
    eventId:
      crypto.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    trialId,
    eventType,
    role: "photographer",
    clientTimestamp: new Date().toISOString(),
    sequenceNumber: eventSequence,
    payload,
  };
}

function restorePendingEvents() {
  if (!sessionId) return;
  try {
    pendingEvents = JSON.parse(
      localStorage.getItem(`photoGuideEvents:${sessionId}`) || "[]"
    );
    eventSequence = pendingEvents.reduce(
      (maximum, event) => Math.max(maximum, Number(event.sequenceNumber) || 0),
      0
    );
  } catch {
    pendingEvents = [];
  }
}

function persistPendingEvents() {
  if (!sessionId) return;
  localStorage.setItem(
    `photoGuideEvents:${sessionId}`,
    JSON.stringify(pendingEvents)
  );
}

async function logExperimentEvent(eventType, payload = {}, trialId = currentTrialId) {
  const event = makeEvent(eventType, payload, trialId);
  if (!trialId) {
    try {
      const key = `photoGuideLocalLogs:${sessionId || "no-session"}`;
      const localEvents = JSON.parse(localStorage.getItem(key) || "[]");
      localEvents.push(event);
      localStorage.setItem(key, JSON.stringify(localEvents.slice(-1000)));
    } catch (error) {
      console.error("local experiment log persistence failed", error);
    }
    console.info("ExperimentLog", event);
    return;
  }
  pendingEvents.push(event);
  persistPendingEvents();
  await flushPendingEvents();
}

async function flushPendingEvents() {
  if (!sessionId || pendingEvents.length === 0) return;
  const targetTrialId = pendingEvents[0].trialId;
  if (!targetTrialId) return;
  const batch = pendingEvents
    .filter((event) => event.trialId === targetTrialId)
    .slice(0, 100);
  if (batch.length === 0) return;
  try {
    const response = await fetch(
      `${API_BASE_PATH}/experiments/trials/${encodeURIComponent(targetTrialId)}/events`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          role: "photographer",
          events: batch.map(({ trialId, ...event }) => event),
        }),
      }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const acceptedIds = new Set(batch.map((event) => event.eventId));
    pendingEvents = pendingEvents.filter(
      (event) => !acceptedIds.has(event.eventId)
    );
    persistPendingEvents();
    if (pendingEvents.length > 0) {
      await flushPendingEvents();
    }
  } catch (error) {
    console.error("experiment event upload error", error);
  }
}

function makeWsUrl(path, params) {
  const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const query = new URLSearchParams(params).toString();
  return `${wsProtocol}//${window.location.host}${path}?${query}`;
}

function loadSessionFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const sessionParam = params.get("sessionId")?.trim();

  if (sessionParam) {
    sessionId = sessionParam;
    restorePendingEvents();
    restoreCaptureSequence();
    setConnectionState("connecting");
    connectSessionSocket();
    fetchExperimentState().then(updateSessionGuide);
    updatePhotoCount();
  } else {
    setStatus("セッションIDがありません");
    showError("セッションIDがありません。被写体側のQRコードから開いてください。");
  }
}

function connectSessionSocket(isReconnect = false) {
  if (!sessionId) return;
  if (wsSession && [WebSocket.CONNECTING, WebSocket.OPEN].includes(wsSession.readyState)) return;

  clearTimeout(reconnectTimer);
  sessionSocketClosedByUser = false;
  setConnectionState(isReconnect ? "reconnecting" : "connecting");

  wsSession = new WebSocket(makeWsUrl("/ws/session", { sessionId }));

  wsSession.addEventListener("open", () => {
    clearError();
    setConnectionState("connected");
    logExperimentEvent("session_socket_connected");
  });

  wsSession.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === "guide-updated" && payload.guide?.url) {
        if (experimentCondition !== "A") {
          applySessionGuide(payload.guide);
        }
      }

      if (payload.type === "guide-transform" && payload.transform) {
        if (experimentCondition !== "A") {
          applyGuideTransform(payload.transform);
          showSupportMessage("ガイドが調整されました。", { autoHideMs: 2500 });
        }
      }

      if (payload.type === "experiment-configured" && payload.experiment) {
        applyExperimentState(payload.experiment);
        flushPendingEvents();
      }

      if (payload.type === "trial-state-changed" && payload.trial) {
        currentTrialId = payload.trial.trialId;
        currentTrialState = payload.trial.state;
        fetchExperimentState();
      }

      if (payload.type === "analysisStarted") {
        const record = recordForAnalysisPayload(payload);
        if (record) {
          record.analysisId = payload.analysisId || record.analysisId;
          record.analysisStatus = "analyzing";
          record.analysisStartTimestamp = payload.analysisStartTimestamp || record.analysisStartTimestamp;
          record.analysisStartedReceivedTimestamp = nowTimestamp();
          logAnalysisEvent(record, "analysis_started_received", {
            analysisStartedReceivedTimestamp: record.analysisStartedReceivedTimestamp,
          });
          if (shouldDisplayAnalysisPayload(payload, record)) {
            showAnalysisProgress(record.draftPhotoId);
          }
        }
      }

      if (payload.type === "roleGuidanceUpdated") {
        const record = recordForAnalysisPayload(payload);
        if (record) {
          record.analysisId = payload.analysisId || record.analysisId;
          record.analysisPayload = payload;
          record.analysisStatus = payload.analysisStatus || "completed";
          record.analysisStartTimestamp = payload.analysisStartTimestamp || record.analysisStartTimestamp;
          record.analysisEndTimestamp = payload.analysisEndTimestamp || record.analysisEndTimestamp;
          record.analysisCompletedReceivedTimestamp = nowTimestamp();
          logAnalysisEvent(record, "analysis_completed_received", {
            analysisCompletedReceivedTimestamp: record.analysisCompletedReceivedTimestamp,
          });
          displayCompletedAnalysis(record, payload);
        }
      }

      if (payload.type === "analysisFailed") {
        const record = recordForAnalysisPayload(payload);
        if (record) {
          record.analysisId = payload.analysisId || record.analysisId;
          record.analysisStatus = "failed";
          record.analysisStartTimestamp = payload.analysisStartTimestamp || record.analysisStartTimestamp;
          record.analysisEndTimestamp = payload.analysisEndTimestamp || record.analysisEndTimestamp;
          record.analysisFailedReceivedTimestamp = nowTimestamp();
          record.errorReason = payload.errorReason || "analysis failed";
          logAnalysisEvent(record, "analysis_failed_received", {
            analysisFailedReceivedTimestamp: record.analysisFailedReceivedTimestamp,
          });
          if (shouldDisplayAnalysisPayload(payload, record)) {
            showAnalysisFailure(record.draftPhotoId, record.errorReason);
          }
        }
      }

      if (payload.type === "session-deleted") {
        guideUrlOverride = null;
        activeGuideId = null;
        verifiedGuideIds.clear();
        latestRoleGuidance = null;
        latestDisplayedCaptureSequence = null;
        lastDisplayedReady = {};
        roleGuidancePanel.hidden = true;
        guide.removeAttribute("src");
        guide.hidden = true;
        guideTransform = {
          offsetX: 0,
          offsetY: 0,
          scale: 1,
          opacity: 0.5,
        };
        applyGuideTransform(guideTransform);
        showSupportMessage("セッションの保存データが削除されました。", { autoHideMs: 3000 });
        photos = [];
        updateThumbnails();
        updatePhotoCount();
        showError("このセッションの保存データは削除されました。");
      }
    } catch (error) {
      console.error("session message parse error", error);
    }
  });

  wsSession.addEventListener("close", () => {
    wsSession = null;
    if (sessionSocketClosedByUser) {
      setConnectionState("disconnected");
      return;
    }

    setConnectionState("disconnected");
    logExperimentEvent("session_socket_disconnected");
    showError("サーバーとの接続が切断されました。再接続を試みます。");
    reconnectTimer = setTimeout(() => {
      connectSessionSocket(true);
    }, 2000);
  });

  wsSession.addEventListener("error", () => {
    showError("サーバーに接続できません。ネットワークまたはサーバーの起動状態を確認してください。");
  });
}

function disconnectSessionSocket() {
  sessionSocketClosedByUser = true;
  clearTimeout(reconnectTimer);
  if (wsSession) {
    wsSession.close(1000);
    wsSession = null;
  }
}

function connectVideoSocket() {
  if (!sessionId) return;
  if (wsVideo && wsVideo.readyState === WebSocket.OPEN) return;

  wsVideo = new WebSocket(makeWsUrl("/ws/video", {
    sessionId,
    role: "sender",
  }));
  wsVideo.binaryType = "arraybuffer";

  wsVideo.addEventListener("open", () => {
    clearError();
    setStatus(`セッション: ${sessionId} - ライブ接続済み`);
  });

  wsVideo.addEventListener("close", () => {
    wsVideo = null;
    shareActive = false;
    stopLiveShare(false);
    shareLiveBtn.textContent = "ライブ共有";
    setConnectionState(wsSession?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  });

  wsVideo.addEventListener("error", () => {
    wsVideo = null;
    shareActive = false;
    stopLiveShare(false);
    shareLiveBtn.textContent = "ライブ共有";
    showError("ライブ共有用の接続に失敗しました。サーバーとの接続を確認してください。");
  });
}

function disconnectVideoSocket() {
  if (wsVideo) {
    wsVideo.close(1000);
    wsVideo = null;
  }
}

function sendVideoFrame() {
  if (!wsVideo || wsVideo.readyState !== WebSocket.OPEN) {
    if (shareActive) {
      stopLiveShare();
      showError("ライブ共有の接続が切断されました。");
    }
    return;
  }
  if (!video.videoWidth || !video.videoHeight) return;

  try {
    const width = 320;
    const height = Math.round(width * 4 / 3);
    const sourceRect = centeredSourceRect(video.videoWidth, video.videoHeight, 3 / 4);

    shareCanvas.width = width;
    shareCanvas.height = height;

    const ctx = shareCanvas.getContext("2d");
    ctx.drawImage(
      video,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      0,
      0,
      width,
      height
    );

    shareCanvas.toBlob((blob) => {
      if (!blob || !wsVideo || wsVideo.readyState !== WebSocket.OPEN) return;
      blob.arrayBuffer()
        .then((buffer) => wsVideo.send(buffer))
        .catch((error) => {
          console.error("ArrayBuffer conversion error:", error);
          showError("ライブ映像の送信準備に失敗しました。");
        });
    }, "image/jpeg", 0.6);
  } catch (error) {
    console.error("Error in sendVideoFrame:", error);
    showError("ライブ映像の送信に失敗しました。");
  }
}

function centeredSourceRect(sourceWidth, sourceHeight, targetAspect) {
  const sourceAspect = sourceWidth / sourceHeight;

  if (sourceAspect > targetAspect) {
    const width = sourceHeight * targetAspect;
    return {
      x: (sourceWidth - width) / 2,
      y: 0,
      width,
      height: sourceHeight,
    };
  }

  const height = sourceWidth / targetAspect;
  return {
    x: 0,
    y: (sourceHeight - height) / 2,
    width: sourceWidth,
    height,
  };
}

function startLiveShare() {
  if (!sessionId) {
    showActionHint(
      "『ライブ共有』は、被写体側のセッションにカメラ映像を送るボタンです。まずは被写体側のQRコードからこの画面を開いてください。"
    );
    return;
  }

  if (!video.srcObject) {
    showActionHint(
      "『ライブ共有』を使うには、まずカメラを起動してください。端末のカメラ権限を許可すると、ここでライブ共有を開始できます。"
    );
    return;
  }

  clearError();
  connectVideoSocket();
  shareActive = true;
  shareLiveBtn.textContent = "停止";

  if (liveInterval) {
    clearInterval(liveInterval);
  }
  liveInterval = setInterval(sendVideoFrame, 250);
}

function stopLiveShare(shouldCloseSocket = true) {
  shareActive = false;
  if (liveInterval) {
    clearInterval(liveInterval);
    liveInterval = null;
  }
  if (shouldCloseSocket) {
    disconnectVideoSocket();
  }
}

function resetCapturedPhotos({ preserveGuidance = true } = {}) {
  photos = [];
  selectedPhotoIndex = null;
  if (!preserveGuidance) {
    latestCapturedClientId = null;
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
  }
  updateThumbnails();
  updatePhotoCount();
}

async function removeDraftFromServer(record) {
  if (!record.draftPhotoId || record.draftStatus === "shared") return;
  try {
    await fetch(
      `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/draft-photos/${encodeURIComponent(record.draftPhotoId)}`,
      { method: "DELETE" }
    );
  } catch (error) {
    console.error("draft photo deletion failed", {
      photoId: record.draftPhotoId,
      error,
    });
  }
}

async function deleteDraftPhoto(record) {
  record.deleted = true;
  await removeDraftFromServer(record);
}

function discardCapturedPhotos(records) {
  records.forEach((record) => {
    record.deleted = true;
    void deleteDraftPhoto(record);
  });
}

function refreshLatestGuidance() {
  const latest = photos[photos.length - 1] || null;
  latestCapturedClientId = latest?.clientId || null;
  if (latest && latest.guideId !== activeGuideId) {
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
    return;
  }
  if (latest?.analysisPayload) {
    renderRoleGuidance(latest.analysisPayload);
  } else if (latest?.analysisStatus === "waiting") {
    showAnalysisWaiting(latest.draftPhotoId);
  } else if (latest?.analysisStatus === "analyzing") {
    showAnalysisProgress(latest.draftPhotoId);
  } else if (latest?.analysisStatus === "failed") {
    showAnalysisFailure(latest.draftPhotoId);
  } else if (latest?.analysisStatus === "skippedMissingGuide") {
    showAnalysisSkipped(latest.draftPhotoId, "guideIdがないため解析をスキップしました");
  } else if (latest?.analysisStatus === "skippedMissingReferenceGuide") {
    showAnalysisSkipped(
      latest.draftPhotoId,
      "ReferenceGuideがないため解析をスキップしました"
    );
  } else if (!latest) {
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
  } else {
    roleGuidancePanel.hidden = true;
  }
}

function finishCaptureAfterSend() {
  stopLiveShare();
  shareLiveBtn.textContent = "ライブ共有";
  setConnectionState(wsSession?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  showSupportMessage("撮影を終了しました。", { autoHideMs: 3000 });
}

function askPostSendAction() {
  return new Promise((resolve) => {
    postSendDialog.hidden = false;

    const cleanup = (action) => {
      postSendDialog.hidden = true;
      continueCaptureBtn.removeEventListener("click", continueHandler);
      finishCaptureBtn.removeEventListener("click", finishHandler);
      resolve(action);
    };

    const continueHandler = () => cleanup("continue");
    const finishHandler = () => cleanup("finish");

    continueCaptureBtn.addEventListener("click", continueHandler);
    finishCaptureBtn.addEventListener("click", finishHandler);
  });
}

async function startCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
      },
      audio: false,
    });

    currentStream = stream;
    video.srcObject = stream;
    logExperimentEvent("camera_started");
  } catch (error) {
    console.error(error);
    showActionHint(
      "カメラを起動できませんでした。権限を許可してから、画面上の『ライブ共有』や『撮影』をお試しください。"
    );
    logExperimentEvent("camera_failed", { message: error.message });
  }
}

opacitySlider.addEventListener("input", (e) => {
  guideTransform.opacity = Number(e.target.value);
  applyGuideTransform(guideTransform);
  logExperimentEvent("guide_opacity_changed", {
    opacity: guideTransform.opacity,
  });
});

toggleGuideBtn.addEventListener("click", () => {
  showGuide = !showGuide;
  guide.hidden = !showGuide || !guideUrlOverride;
  logExperimentEvent("guide_visibility_changed", { visible: showGuide });
});

toggleGridBtn.addEventListener("click", () => {
  showGrid = !showGrid;
  gridOverlay.hidden = !showGrid;
  toggleGridBtn.textContent = showGrid ? "▦" : "□";
  const label = showGrid ? "グリッド線を消す" : "グリッド線を出す";
  toggleGridBtn.setAttribute("aria-label", label);
  toggleGridBtn.title = label;
  logExperimentEvent("grid_visibility_changed", { visible: showGrid });
});

shareLiveBtn.addEventListener("click", () => {
  if (shareActive) {
    stopLiveShare();
    shareLiveBtn.textContent = "ライブ共有";
    setConnectionState(wsSession?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
    logExperimentEvent("live_share_stopped");
  } else {
    startLiveShare();
    logExperimentEvent("live_share_started");
  }
});

captureBtn.addEventListener("click", () => {
  if (!video.videoWidth || !video.videoHeight) {
    showActionHint(
      "『撮影』はカメラ映像が見えてから使えます。映像が表示されるまで少し待ってから、もう一度押してください。"
    );
    return;
  }

  const outputWidth = 900;
  const outputHeight = 1200;
  canvas.width = outputWidth;
  canvas.height = outputHeight;

  const ctx = canvas.getContext("2d");
  const targetAspect = outputWidth / outputHeight;
  const sourceRect = centeredSourceRect(video.videoWidth, video.videoHeight, targetAspect);

  ctx.drawImage(
    video,
    sourceRect.x,
    sourceRect.y,
    sourceRect.width,
    sourceRect.height,
    0,
    0,
    outputWidth,
    outputHeight
  );

  const imageUrl = canvas.toDataURL("image/jpeg", 0.92);
  const captureTimestamp = nowTimestamp();
  const record = {
    clientId:
      crypto.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    imageUrl,
    captureSequence: nextCaptureSequence(),
    captureTimestamp,
    draftPhotoId: null,
    draftStatus: "uploading",
    deleted: false,
    uploadPromise: null,
    analysisPromise: null,
    analysisStatus: photographerGuidanceEnabled() ? "waiting" : "skippedCondition",
    analysisStartTimestamp: null,
    analysisEndTimestamp: null,
    analysisId: null,
    draftSaveStartTimestamp: null,
    draftSaveEndTimestamp: null,
    analysisStartedReceivedTimestamp: null,
    analysisCompletedReceivedTimestamp: null,
    analysisFailedReceivedTimestamp: null,
    displayTimestamp: null,
    webGuidanceDisplayTimestamp: null,
    displayedAnalysisId: null,
    analysisPayload: null,
    errorReason: null,
    guideId: activeGuideId,
    trialId: currentTrialId,
    guideTransform: {
      translationX: guideTransform.offsetX,
      translationY: guideTransform.offsetY,
      scale: guideTransform.scale,
    },
  };
  photos.push(record);
  latestCapturedClientId = record.clientId;
  updateThumbnails();
  updatePhotoCount();

  if (photographerGuidanceEnabled()) {
    if (record.guideId) {
      showAnalysisWaiting();
    } else {
      record.analysisStatus = "skippedMissingGuide";
      record.errorReason = "guideIdMissing";
      showAnalysisSkipped(null, "guideIdがないため解析をスキップしました");
    }
  }

  logExperimentEvent("photo_captured", {
    shotCount: photos.length,
    clientPhotoId: record.clientId,
    clientId: record.clientId,
    captureSequence: record.captureSequence,
    captureTimestamp,
    guideId: record.guideId,
    guideTransform: record.guideTransform,
  });
  record.uploadPromise = uploadDraftAndAnalyze(record);
});

function updatePhotoCount() {
  photoCount.textContent = `${photos.length}枚`;
  sendBtn.disabled = photos.length === 0 || !sessionId;
  gallerySummary.textContent = `撮影済み写真 ${photos.length}枚`;
  updateGalleryButton();
  galleryEmptyMessage.hidden = photos.length > 0;
}

function updateGalleryButton() {
  if (photos.length === 0) {
    viewGalleryBtn.textContent = "撮影済み写真はありません";
    viewGalleryBtn.disabled = true;
    viewGalleryBtn.classList.add("disabled");
  } else {
    viewGalleryBtn.textContent = `撮影済み写真 ${photos.length}枚`;
    viewGalleryBtn.disabled = false;
    viewGalleryBtn.classList.remove("disabled");
  }
}

function showCaptureView() {
  galleryPanel.hidden = true;
  capturePanel.hidden = false;
  photoPreviewOverlay.hidden = true;
}

function openGallery() {
  updateThumbnails();
  gallerySummary.textContent = `撮影済み写真 ${photos.length}枚`;
  galleryEmptyMessage.hidden = photos.length > 0;
  capturePanel.hidden = true;
  galleryPanel.hidden = false;
  window.scrollTo(0, 0);
}

function closeGallery() {
  galleryPanel.hidden = true;
  capturePanel.hidden = false;
}

function applyGuideUrl(url) {
  if (guideUrlOverride === url) return;

  guideUrlOverride = url;
  guide.src = url;
  guide.hidden = !showGuide;
  applyGuideTransform(guideTransform);
  clearError();
  setStatus(`セッション: ${sessionId} - ガイド更新`);
}

function applyGuideTransform(transform) {
  const offsetX = Number(transform.offsetX ?? 0);
  const offsetY = Number(transform.offsetY ?? 0);
  const scale = Number(transform.scale ?? 1);
  const opacity = Number(transform.opacity ?? guideTransform.opacity);

  guideTransform = {
    offsetX: Math.max(-0.5, Math.min(0.5, offsetX)),
    offsetY: Math.max(-0.5, Math.min(0.5, offsetY)),
    scale: Math.max(0.5, Math.min(1.8, scale)),
    opacity: Math.max(0, Math.min(1, opacity)),
  };

  opacitySlider.value = guideTransform.opacity;
  guide.style.opacity = String(guideTransform.opacity);
  const stageWidth = cameraStage?.clientWidth || guide.clientWidth || 0;
  const stageHeight = cameraStage?.clientHeight || guide.clientHeight || 0;
  const translateX = guideTransform.offsetX * stageWidth;
  const translateY = guideTransform.offsetY * stageHeight;
  guide.style.transform = `translate(${translateX}px, ${translateY}px) scale(${guideTransform.scale})`;
}

window.addEventListener("resize", () => {
  applyGuideTransform(guideTransform);
});

async function updateSessionGuide() {
  if (!sessionId || experimentCondition === "A") return;

  try {
    const response = await fetch(`${API_BASE_PATH}/session/${encodeURIComponent(sessionId)}/guide`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (data.success && data.guide?.url) {
      applySessionGuide(data.guide);
    }
  } catch (error) {
    console.error("guide fetch error", error);
    showError("ガイド画像を取得できませんでした。サーバーとの接続を確認してください。");
  }
}

async function ensureReferenceGuide(guideId) {
  if (!guideId) {
    return false;
  }
  if (verifiedGuideIds.has(guideId)) return true;

  try {
    const response = await fetch(
      `${API_BASE_PATH}/guides/${encodeURIComponent(guideId)}/features?sessionId=${encodeURIComponent(sessionId)}`
    );
    if (!response.ok) {
      console.info("Role-Aware analysis skipped: ReferenceGuide is not available", {
        guideId,
        status: response.status,
      });
      return false;
    }
    verifiedGuideIds.add(guideId);
    return true;
  } catch (error) {
    console.info("Role-Aware analysis skipped: ReferenceGuide lookup failed", error);
    return false;
  }
}

function displayForLatestRecord(record, callback) {
  if (
    !record.deleted &&
    record.captureSequence >= latestActiveCaptureSequence() &&
    record.guideId === activeGuideId
  ) {
    callback();
  }
}

function logAnalysisEvent(record, eventType, extra = {}) {
  logExperimentEvent(eventType, {
    trialId: record.trialId,
    guideId: record.guideId,
    photoId: record.draftPhotoId,
    clientId: record.clientId,
    captureSequence: record.captureSequence,
    captureTimestamp: record.captureTimestamp,
    draftSaveStartTimestamp: record.draftSaveStartTimestamp,
    draftSaveEndTimestamp: record.draftSaveEndTimestamp,
    analysisId: record.analysisId,
    analysisStartTimestamp: record.analysisStartTimestamp,
    analysisEndTimestamp: record.analysisEndTimestamp,
    analysisStartedReceivedTimestamp: record.analysisStartedReceivedTimestamp,
    analysisCompletedReceivedTimestamp: record.analysisCompletedReceivedTimestamp,
    analysisFailedReceivedTimestamp: record.analysisFailedReceivedTimestamp,
    displayTimestamp: record.displayTimestamp,
    webGuidanceDisplayTimestamp: record.webGuidanceDisplayTimestamp,
    guideTransform: record.guideTransform,
    analysisStatus: record.analysisStatus,
    errorReason: record.errorReason,
    ...extra,
  }, record.trialId);
}

async function analyzeCapturedRecord(record) {
  if (!record.guideId) {
    record.analysisStatus = "skippedMissingGuide";
    record.errorReason = "guideIdMissing";
    logAnalysisEvent(record, "photo_analysis_skipped");
    return;
  }

  if (!(await ensureReferenceGuide(record.guideId))) {
    record.analysisStatus = "skippedMissingReferenceGuide";
    record.errorReason = "referenceGuideMissing";
    displayForLatestRecord(record, () => {
      showAnalysisSkipped(record.draftPhotoId, "ReferenceGuideがないため解析をスキップしました");
    });
    logAnalysisEvent(record, "photo_analysis_skipped");
    return;
  }

  record.analysisStatus = "analyzing";
  record.analysisStartTimestamp = nowTimestamp();
  displayForLatestRecord(record, () => showAnalysisProgress(record.draftPhotoId));

  try {
    const response = await fetch(
      `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/photos/${encodeURIComponent(record.draftPhotoId)}/analyze`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guideId: record.guideId,
          trialId: record.trialId,
          clientId: record.clientId,
          captureSequence: record.captureSequence,
          captureTimestamp: record.captureTimestamp,
          guideTransform: record.guideTransform,
        }),
      }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    record.analysisId = result.analysisId || record.analysisId;
    record.analysisStartTimestamp = result.analysisStartTimestamp || record.analysisStartTimestamp;
    record.analysisEndTimestamp = result.analysisEndTimestamp || nowTimestamp();
    record.analysisStatus = result.analysisStatus || "completed";
    record.analysisPayload = result;
    displayCompletedAnalysis(record, result);
    logAnalysisEvent(record, "photo_analysis_completed", {
      alignmentError: result.alignmentError,
      photographerGuidance: result.photographerGuidance,
      subjectGuidance: result.subjectGuidance,
      ready: result.ready,
    });
  } catch (error) {
    record.analysisEndTimestamp = nowTimestamp();
    record.analysisStatus = "failed";
    record.errorReason = record.errorReason || error.message;
    console.error("Role-Aware photo analysis failed", {
      photoId: record.draftPhotoId,
      error,
    });
    displayForLatestRecord(record, () => showAnalysisFailure(record.draftPhotoId));
    logAnalysisEvent(record, "photo_analysis_failed");
  }
}

async function uploadDraftAndAnalyze(record) {
  if (!sessionId) {
    record.draftStatus = "failed";
    record.analysisStatus = "failed";
    record.errorReason = "sessionIdMissing";
    displayForLatestRecord(record, () => showAnalysisFailure());
    logAnalysisEvent(record, "photo_analysis_failed");
    return;
  }

  try {
    record.draftSaveStartTimestamp = nowTimestamp();
    logAnalysisEvent(record, "photo_draft_save_started");
    const formData = new FormData();
    formData.append("trialId", record.trialId || "");
    formData.append("clientId", record.clientId);
    formData.append("captureSequence", String(record.captureSequence));
    formData.append("captureTimestamp", record.captureTimestamp);
    formData.append("guideId", record.guideId || "");
    formData.append("guideTransform", JSON.stringify(record.guideTransform));
    formData.append("draft", dataURLtoBlob(record.imageUrl), "captured_photo.jpg");
    const response = await fetch(
      `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/draft-photos`,
      { method: "POST", body: formData }
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const result = await response.json();
    record.draftSaveEndTimestamp = nowTimestamp();
    record.draftPhotoId = result.photo?.photoId || null;
    record.draftStatus = record.draftPhotoId ? "ready" : "failed";
    logAnalysisEvent(record, "photo_draft_save_completed");

    if (record.deleted) {
      await deleteDraftPhoto(record);
      return;
    }
    if (record.analysisStatus === "skippedCondition") return;
    record.analysisPromise = analyzeCapturedRecord(record);
  } catch (error) {
    record.draftSaveEndTimestamp = nowTimestamp();
    record.draftStatus = "failed";
    record.analysisStatus = "failed";
    record.errorReason = `draftUploadFailed:${error.message}`;
    console.error("captured photo draft upload failed", error);
    displayForLatestRecord(record, () => showAnalysisFailure());
    logAnalysisEvent(record, "photo_analysis_failed");
  }
}

function updateThumbnails() {
  thumbnailContainer.innerHTML = "";
  thumbnailContainer.hidden = photos.length === 0;

  photos.forEach((record, index) => {
    const thumbnail = document.createElement("button");
    thumbnail.type = "button";
    thumbnail.className = "thumbnail";
    if (selectedPhotoIndex === index) {
      thumbnail.classList.add("selected");
    }
    thumbnail.setAttribute("aria-label", `写真 ${index + 1} をプレビュー`);

    const img = document.createElement("img");
    img.src = record.imageUrl;
    img.alt = `撮影した写真 ${index + 1}`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "thumbnail-delete";
    deleteBtn.textContent = "×";
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", `写真 ${index + 1} を削除`);
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (isSendingPhotos) {
        showActionHint("写真の送信準備中は削除できません。少し待ってからお試しください。");
        return;
      }
      if (selectedPhotoIndex === index) {
        selectedPhotoIndex = null;
      } else if (selectedPhotoIndex !== null && selectedPhotoIndex > index) {
        selectedPhotoIndex -= 1;
      }
      const [deletedRecord] = photos.splice(index, 1);
      void deleteDraftPhoto(deletedRecord);
      updateThumbnails();
      updatePhotoCount();
      if (deletedRecord.clientId === latestCapturedClientId) {
        refreshLatestGuidance();
      }
      logExperimentEvent("photo_deleted", {
        deletedIndex: index,
        photoId: deletedRecord.draftPhotoId,
        remainingCount: photos.length,
      });
    });

    thumbnail.addEventListener("click", () => {
      selectedPhotoIndex = index;
      updateThumbnails();
      showPhotoPreview(index);
    });

    thumbnail.appendChild(img);
    thumbnail.appendChild(deleteBtn);
    thumbnailContainer.appendChild(thumbnail);
  });
}

function showPhotoPreview(index) {
  selectedPhotoIndex = index;
  previewImage.src = photos[index].imageUrl;
  photoPreviewOverlay.hidden = false;
}

function closePhotoPreview() {
  photoPreviewOverlay.hidden = true;
  previewImage.src = "";
}

viewGalleryBtn.addEventListener("click", () => {
  if (photos.length === 0) {
    showActionHint("まだ撮影済みの写真がありません。");
    return;
  }
  openGallery();
});
closeGalleryBtn.addEventListener("click", (event) => {
  event.preventDefault();
  closeGallery();
});
closePreviewBtn.addEventListener("click", closePhotoPreview);
photoPreviewOverlay.addEventListener("click", (event) => {
  if (event.target === photoPreviewOverlay) {
    closePhotoPreview();
  }
});

clearBtn.addEventListener("click", () => {
  if (photos.length === 0) {
    showActionHint(
      "『クリア』は撮影した写真をまとめて消すボタンです。今は削除する写真がないため、何もしません。"
    );
    return;
  }
  if (isSendingPhotos) {
    showActionHint("写真の送信準備中はクリアできません。少し待ってからお試しください。");
    return;
  }
  if (confirm("すべての写真を削除しますか？")) {
    const discardedRecords = [...photos];
    resetCapturedPhotos({ preserveGuidance: false });
    discardCapturedPhotos(discardedRecords);
    logExperimentEvent("photos_cleared");
  }
});

deleteSessionBtn.addEventListener("click", async () => {
  if (!sessionId) {
    showActionHint(
      "『削除』はこのセッションの保存データを消すボタンです。まずは被写体側のQRコードからセッションを開いてください。"
    );
    return;
  }
  if (!confirm("このセッションのサーバー保存データを削除しますか？")) return;

  try {
    const response = await fetch(`${API_BASE_PATH}/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    resetCapturedPhotos({ preserveGuidance: false });
    guideUrlOverride = null;
    activeGuideId = null;
    verifiedGuideIds.clear();
    latestRoleGuidance = null;
    roleGuidancePanel.hidden = true;
    guide.removeAttribute("src");
    guide.hidden = true;
    guideTransform = {
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      opacity: 0.5,
    };
    applyGuideTransform(guideTransform);
    showError("このセッションの保存データを削除しました。");
  } catch (error) {
    console.error(error);
    showError("セッションデータの削除に失敗しました。サーバーとの接続を確認してください。");
  }
});

sendBtn.addEventListener("click", async () => {
  if (photos.length === 0) {
    showActionHint(
      "『送信』は撮影した写真をサーバーに送るボタンです。まず『撮影』で写真を1枚以上保存してください。"
    );
    return;
  }
  if (!sessionId) {
    showActionHint(
      "『送信』にはセッションが必要です。被写体側のQRコードからこの画面を開いてください。"
    );
    return;
  }

  isSendingPhotos = true;
  sendBtn.disabled = true;
  sendBtn.textContent = "送信準備中...";

  try {
    const recordsToSend = [...photos];
    await Promise.allSettled(
      recordsToSend.map((record) => record.uploadPromise).filter(Boolean)
    );
    sendBtn.textContent = "送信中...";

    const canPromoteDrafts = recordsToSend.every(
      (record) => record.draftStatus === "ready" && record.draftPhotoId
    );
    let response;
    if (canPromoteDrafts) {
      response = await fetch(
        `${API_BASE_PATH}/sessions/${encodeURIComponent(sessionId)}/photos/share`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            photoIds: recordsToSend.map((record) => record.draftPhotoId),
            trialId: currentTrialId,
            clientTimestamp: new Date().toISOString(),
          }),
        }
      );
    } else {
      console.info("draft promotion unavailable; falling back to the existing photo upload flow");
      const formData = new FormData();
      formData.append("sessionId", sessionId);
      if (currentTrialId) {
        formData.append("trialId", currentTrialId);
        formData.append("clientTimestamp", new Date().toISOString());
      }
      recordsToSend.forEach((record, index) => {
        formData.append("photos", dataURLtoBlob(record.imageUrl), `photo_${index}.jpg`);
      });
      response = await fetch(`${API_BASE_PATH}/photos`, {
        method: "POST",
        body: formData,
      });
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    if (canPromoteDrafts) {
      recordsToSend.forEach((record) => { record.draftStatus = "shared"; });
    } else {
      recordsToSend
        .filter((record) => record.draftPhotoId)
        .forEach((record) => { void removeDraftFromServer(record); });
    }
    clearError();
    await logExperimentEvent("photos_sent", {
      photoCount: result.files?.length || photos.length,
      photoIds: result.files?.map((file) => file.filename) || [],
    });
    const nextAction = await askPostSendAction();
    resetCapturedPhotos();

    if (nextAction === "finish") {
      finishCaptureAfterSend();
    } else {
      showSupportMessage("送信済み写真をリセットしました。続けて撮影できます。", { autoHideMs: 3000 });
    }
  } catch (error) {
    console.error(error);
    showError("写真の送信に失敗しました。サーバー接続とセッションIDを確認してください。");
    logExperimentEvent("photos_send_failed", { message: error.message });
  } finally {
    isSendingPhotos = false;
    sendBtn.disabled = photos.length === 0;
    sendBtn.textContent = "送信";
  }
});

window.addEventListener("beforeunload", () => {
  stopLiveShare();
  disconnectVideoSocket();
  disconnectSessionSocket();
  currentStream?.getTracks().forEach((track) => track.stop());
});

function dataURLtoBlob(dataURL) {
  const arr = dataURL.split(",");
  const mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

updatePhotoCount();
showCaptureView();
loadSessionFromUrl();
startCamera();
