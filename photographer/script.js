const video = document.getElementById("video");
const guide = document.getElementById("guide");
const opacitySlider = document.getElementById("opacitySlider");
const toggleGuideBtn = document.getElementById("toggleGuideBtn");
const captureBtn = document.getElementById("captureBtn");
const canvas = document.getElementById("canvas");
const thumbnailContainer = document.getElementById("thumbnailContainer");
const photoCount = document.getElementById("photoCount");
const sendBtn = document.getElementById("sendBtn");
const clearBtn = document.getElementById("clearBtn");
const shareLiveBtn = document.getElementById("shareLiveBtn");
const deleteSessionBtn = document.getElementById("deleteSessionBtn");
const errorPanel = document.getElementById("errorPanel");
const supportPanel = document.getElementById("supportPanel");
const supportMessage = document.getElementById("supportMessage");
const status = document.querySelector(".status");

const API_BASE_URL = window.location.origin;

let showGuide = true;
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
  scale: 1,
  opacity: 0.5,
};
let supportMessageTimer = null;
const shareCanvas = document.createElement("canvas");

function setStatus(text) {
  status.textContent = text;
}

function setConnectionState(state) {
  const labels = {
    connecting: "接続中",
    connected: "接続済み",
    disconnected: "切断",
    reconnecting: "再接続中",
  };

  setStatus(sessionId ? `セッション: ${sessionId} - ${labels[state]}` : labels[state]);
}

function showError(message) {
  errorPanel.textContent = message;
  errorPanel.hidden = false;
}

function clearError() {
  errorPanel.textContent = "";
  errorPanel.hidden = true;
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
    setConnectionState("connecting");
    connectSessionSocket();
    updateSessionGuide();
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
  });

  wsSession.addEventListener("message", (event) => {
    try {
      const payload = JSON.parse(event.data);

      if (payload.type === "guide-updated" && payload.guide?.url) {
        applyGuideUrl(payload.guide.url);
      }

      if (payload.type === "guide-transform" && payload.transform) {
        applyGuideTransform(payload.transform);
        showSupportMessage("ガイドが調整されました。", { autoHideMs: 2500 });
      }

      if (payload.type === "session-deleted") {
        guideUrlOverride = null;
        guide.removeAttribute("src");
        guideTransform = {
          offsetX: 0,
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
    showError("セッションIDがありません。被写体側のQRコードから開いてください。");
    return;
  }

  if (!video.srcObject) {
    showError("カメラが起動していません。ブラウザのカメラ許可を確認してください。");
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
  } catch (error) {
    console.error(error);
    showError("カメラを起動できませんでした。ブラウザの権限、HTTPS接続、別アプリでのカメラ使用状況を確認してください。");
  }
}

opacitySlider.addEventListener("input", (e) => {
  guideTransform.opacity = Number(e.target.value);
  applyGuideTransform(guideTransform);
});

toggleGuideBtn.addEventListener("click", () => {
  showGuide = !showGuide;
  guide.style.display = showGuide ? "block" : "none";
});

shareLiveBtn.addEventListener("click", () => {
  if (shareActive) {
    stopLiveShare();
    shareLiveBtn.textContent = "ライブ共有";
    setConnectionState(wsSession?.readyState === WebSocket.OPEN ? "connected" : "disconnected");
  } else {
    startLiveShare();
  }
});

captureBtn.addEventListener("click", () => {
  if (!video.videoWidth || !video.videoHeight) {
    showError("カメラ映像がまだ準備できていません。少し待ってから撮影してください。");
    return;
  }

  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const imageUrl = canvas.toDataURL("image/png");
  photos.push(imageUrl);
  updateThumbnails();
  updatePhotoCount();
});

function updatePhotoCount() {
  photoCount.textContent = `${photos.length}枚`;
  sendBtn.disabled = photos.length === 0 || !sessionId;
}

function applyGuideUrl(url) {
  if (guideUrlOverride === url) return;

  guideUrlOverride = url;
  guide.src = url;
  applyGuideTransform(guideTransform);
  clearError();
  setStatus(`セッション: ${sessionId} - ガイド更新`);
}

function applyGuideTransform(transform) {
  const offsetX = Number(transform.offsetX ?? 0);
  const scale = Number(transform.scale ?? 1);
  const opacity = Number(transform.opacity ?? guideTransform.opacity);

  guideTransform = {
    offsetX: Math.max(-0.5, Math.min(0.5, offsetX)),
    scale: Math.max(0.5, Math.min(1.8, scale)),
    opacity: Math.max(0, Math.min(1, opacity)),
  };

  opacitySlider.value = guideTransform.opacity;
  guide.style.opacity = String(guideTransform.opacity);
  guide.style.transform = `translateX(${guideTransform.offsetX * 100}%) scale(${guideTransform.scale})`;
}

async function updateSessionGuide() {
  if (!sessionId) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/session/${encodeURIComponent(sessionId)}/guide`);
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

  photos.forEach((imageUrl, index) => {
    const thumbnail = document.createElement("div");
    thumbnail.className = "thumbnail";

    const img = document.createElement("img");
    img.src = imageUrl;

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "thumbnail-delete";
    deleteBtn.textContent = "×";
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      photos.splice(index, 1);
      updateThumbnails();
      updatePhotoCount();
    });

    thumbnail.appendChild(img);
    thumbnail.appendChild(deleteBtn);
    thumbnailContainer.appendChild(thumbnail);
  });
}

clearBtn.addEventListener("click", () => {
  if (photos.length === 0) return;
  if (confirm("すべての写真を削除しますか？")) {
    photos = [];
    updateThumbnails();
    updatePhotoCount();
  }
});

deleteSessionBtn.addEventListener("click", async () => {
  if (!sessionId) {
    showError("削除するセッションIDがありません。");
    return;
  }
  if (!confirm("このセッションのサーバー保存データを削除しますか？")) return;

  try {
    const response = await fetch(`${API_BASE_URL}/api/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    photos = [];
    guideUrlOverride = null;
    guide.removeAttribute("src");
    guideTransform = {
      offsetX: 0,
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
  if (photos.length === 0) return;
  if (!sessionId) {
    showError("セッションIDがありません。被写体側のQRコードから開いてください。");
    return;
  }

  sendBtn.disabled = true;
  sendBtn.textContent = "送信中...";

  try {
    const formData = new FormData();
    formData.append("sessionId", sessionId);
    photos.forEach((imageUrl, index) => {
      const blob = dataURLtoBlob(imageUrl);
      formData.append("photos", blob, `photo_${index}.png`);
    });

    const response = await fetch(`${API_BASE_URL}/api/photos`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    clearError();
    alert("写真を送信しました！");
    photos = [];
    updateThumbnails();
    updatePhotoCount();
  } catch (error) {
    console.error(error);
    showError("写真の送信に失敗しました。サーバー接続とセッションIDを確認してください。");
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
loadSessionFromUrl();
startCamera();
