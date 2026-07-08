const video = document.getElementById("video");
const guide = document.getElementById("guide");
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
const capturePanel = document.getElementById("capturePanel");
const galleryPanel = document.getElementById("galleryPanel");
const errorPanel = document.getElementById("errorPanel");
const supportPanel = document.getElementById("supportPanel");
const supportMessage = document.getElementById("supportMessage");
const experimentStatus = document.getElementById("experimentStatus");
const guideControls = document.querySelectorAll(".guide-control");
const status = document.querySelector(".status");

const API_BASE_PATH = "/api";

let selectedPhotoIndex = null;

let showGuide = true;
let showGrid = true;
let currentStream = null;
let photos = [];
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

function applyExperimentState(experiment) {
  if (!experiment) {
    experimentCondition = null;
    currentTrialId = null;
    currentTrialState = null;
    experimentStatus.hidden = true;
    guideControls.forEach((element) => {
      element.hidden = false;
    });
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
  } else if (showGuide && guideUrlOverride) {
    guide.hidden = false;
  }
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

function makeEvent(eventType, payload = {}) {
  eventSequence += 1;
  return {
    eventId:
      crypto.randomUUID?.() ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    trialId: currentTrialId,
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

async function logExperimentEvent(eventType, payload = {}) {
  if (!currentTrialId) return;
  pendingEvents.push(makeEvent(eventType, payload));
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
          applyGuideUrl(payload.guide.url);
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

      if (payload.type === "session-deleted") {
        guideUrlOverride = null;
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
    const height = Math.round((video.videoHeight / video.videoWidth) * width);

    shareCanvas.width = width;
    shareCanvas.height = height;

    const ctx = shareCanvas.getContext("2d");
    ctx.drawImage(video, 0, 0, width, height);

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
  const sourceAspect = video.videoWidth / video.videoHeight;
  const targetAspect = outputWidth / outputHeight;
  let sourceX = 0;
  let sourceY = 0;
  let sourceWidth = video.videoWidth;
  let sourceHeight = video.videoHeight;

  if (sourceAspect > targetAspect) {
    sourceWidth = video.videoHeight * targetAspect;
    sourceX = (video.videoWidth - sourceWidth) / 2;
  } else {
    sourceHeight = video.videoWidth / targetAspect;
    sourceY = (video.videoHeight - sourceHeight) / 2;
  }

  ctx.drawImage(
    video,
    sourceX,
    sourceY,
    sourceWidth,
    sourceHeight,
    0,
    0,
    outputWidth,
    outputHeight
  );

  const imageUrl = canvas.toDataURL("image/jpeg", 0.92);
  photos.push(imageUrl);
  updateThumbnails();
  updatePhotoCount();
  logExperimentEvent("photo_captured", {
    shotCount: photos.length,
  });
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
  guide.style.transform = `translate(${guideTransform.offsetX * 100}%, ${guideTransform.offsetY * 100}%) scale(${guideTransform.scale})`;
}

async function updateSessionGuide() {
  if (!sessionId || experimentCondition === "A") return;

  try {
    const response = await fetch(`${API_BASE_PATH}/session/${encodeURIComponent(sessionId)}/guide`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (data.success && data.guide?.url) {
      applyGuideUrl(data.guide.url);
    }
  } catch (error) {
    console.error("guide fetch error", error);
    showError("ガイド画像を取得できませんでした。サーバーとの接続を確認してください。");
  }
}

function updateThumbnails() {
  thumbnailContainer.innerHTML = "";
  thumbnailContainer.hidden = photos.length === 0;

  photos.forEach((imageUrl, index) => {
    const thumbnail = document.createElement("button");
    thumbnail.type = "button";
    thumbnail.className = "thumbnail";
    if (selectedPhotoIndex === index) {
      thumbnail.classList.add("selected");
    }
    thumbnail.setAttribute("aria-label", `写真 ${index + 1} をプレビュー`);

    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = `撮影した写真 ${index + 1}`;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "thumbnail-delete";
    deleteBtn.textContent = "×";
    deleteBtn.type = "button";
    deleteBtn.setAttribute("aria-label", `写真 ${index + 1} を削除`);
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectedPhotoIndex === index) {
        selectedPhotoIndex = null;
      } else if (selectedPhotoIndex !== null && selectedPhotoIndex > index) {
        selectedPhotoIndex -= 1;
      }
      photos.splice(index, 1);
      updateThumbnails();
      updatePhotoCount();
      logExperimentEvent("photo_deleted", {
        deletedIndex: index,
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
  previewImage.src = photos[index];
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
  if (confirm("すべての写真を削除しますか？")) {
    photos = [];
    updateThumbnails();
    updatePhotoCount();
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

    photos = [];
    guideUrlOverride = null;
    guide.removeAttribute("src");
    guide.hidden = true;
    guideTransform = {
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      opacity: 0.5,
    };
    applyGuideTransform(guideTransform);
    updateThumbnails();
    updatePhotoCount();
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

  sendBtn.disabled = true;
  sendBtn.textContent = "送信中...";

  try {
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    if (currentTrialId) {
      formData.append("trialId", currentTrialId);
      formData.append("clientTimestamp", new Date().toISOString());
    }
    photos.forEach((imageUrl, index) => {
      const blob = dataURLtoBlob(imageUrl);
      formData.append("photos", blob, `photo_${index}.jpg`);
    });

    const response = await fetch(`${API_BASE_PATH}/photos`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const result = await response.json();
    clearError();
    await logExperimentEvent("photos_sent", {
      photoCount: result.files?.length || photos.length,
      photoIds: result.files?.map((file) => file.filename) || [],
    });
    alert("写真を送信しました！");
    photos = [];
    updateThumbnails();
    updatePhotoCount();
  } catch (error) {
    console.error(error);
    showError("写真の送信に失敗しました。サーバー接続とセッションIDを確認してください。");
    logExperimentEvent("photos_send_failed", { message: error.message });
  } finally {
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
