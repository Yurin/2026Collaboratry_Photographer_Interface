import SwiftUI
import Photos
import CoreImage.CIFilterBuiltins
import UIKit

enum TakePhotoPhase {
    case qrAndPreview
    case receivingPhoto
    case receivedPhoto
}

enum SessionDisplayMode: Hashable {
    case qr
    case preview
}

enum WebSocketConnectionState {
    case connecting
    case connected
    case disconnected
    case reconnecting

    var displayText: String {
        switch self {
        case .connecting:
            return "接続中"
        case .connected:
            return "接続済み"
        case .disconnected:
            return "切断"
        case .reconnecting:
            return "再接続中"
        }
    }

    var color: Color {
        switch self {
        case .connected:
            return .green
        case .connecting, .reconnecting:
            return .orange
        case .disconnected:
            return .red
        }
    }
}

struct TakePhoto: View {
    @Binding var selectedIndex: Int
    @Binding var resetID: UUID
    @Binding var sessionId: String

    let selectedGuides: [GuideItem]
    @ObservedObject var experimentState: ExperimentState

    @State private var phase: TakePhotoPhase = .qrAndPreview
    @State private var displayMode: SessionDisplayMode = .qr

    @State private var currentGuideIndex: Int = 0
    @State private var subjectGuideType: GuideType = .silhouette
    @State private var photographerGuideType: GuideType = .rectangle
    @State private var overlayOpacity: Double = 0.45
    @State private var showGridOverlay: Bool = true
    @State private var showReferencePreview: Bool = true
    @State private var sharedGuideHorizontalOffset: Double = 0.0
    @State private var sharedGuideVerticalOffset: Double = 0.0
    @State private var sharedGuideScale: Double = 1.0
    @State private var guideDragStartHorizontalOffset: Double = 0.0
    @State private var guideDragStartVerticalOffset: Double = 0.0
    @State private var guidePinchStartScale: Double = 1.0
    @State private var previewScrollRequest: Int = 0

    @State private var localSessionID: String = UUID().uuidString
    @State private var connectionState: WebSocketConnectionState = .disconnected
    @State private var remoteImage: UIImage? = nil
    @State private var wsTask: URLSessionWebSocketTask? = nil
    @State private var shouldReconnectWebSocket: Bool = false

    private let webAppBaseURL = APIConfig.appBaseURL

    private var sessionURLString: String {
        var components = URLComponents(url: webAppBaseURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "sessionId", value: localSessionID)
        ]
        return components?.url?.absoluteString ?? webAppBaseURL.absoluteString
    }

    @State private var receivedImages: [UIImage] = []
    @State private var isSavingPhotos: Bool = false
    @State private var saveErrorMessage: String? = nil
    @State private var isUploadingGuide: Bool = false
    @State private var guideShareMessage: String? = nil

    private var currentGuide: GuideItem? {
        guard !selectedGuides.isEmpty,
              currentGuideIndex >= 0,
              currentGuideIndex < selectedGuides.count else {
            return nil
        }
        return selectedGuides[currentGuideIndex]
    }

    private var isWebSocketConnected: Bool {
        connectionState == .connected
    }

    private var subjectGuideImage: UIImage? {
        currentGuide?.guideUIImage(for: subjectGuideType)
    }

    private var photographerGuideImage: UIImage? {
        currentGuide?.guideUIImage(for: photographerGuideType)
    }

    private var isExperimentMode: Bool {
        experimentState.isRunning
    }

    private var allowsPhotographerSupport: Bool {
        !isExperimentMode || experimentState.condition != .noSupport
    }

    private var allowsSubjectSupport: Bool {
        !isExperimentMode || experimentState.condition == .roleBased
    }

    var body: some View {
        ZStack {
            AppStyle.background
                .ignoresSafeArea()

            switch phase {
            case .qrAndPreview:
                qrAndPreviewView
            case .receivingPhoto:
                receivingPhotoView
            case .receivedPhoto:
                receivedPhotoView
            }
        }
        .onAppear {
            startSession()
        }
        .onDisappear {
            disconnectWebSocket()
        }
        .onChange(of: photographerGuideType) { _, _ in
            guard allowsPhotographerSupport else { return }
            Task {
                await uploadGuideToSession()
            }
        }
    }
}

// MARK: - Views
private extension TakePhoto {

    var qrAndPreviewView: some View {
        ScrollViewReader { scrollProxy in
            ScrollView(.vertical, showsIndicators: true) {
                VStack(spacing: 16) {
                    Text("PHOTO SESSION")
                        .font(.headline.weight(.black))
                        .tracking(1.2)
                        .padding(.top, 12)

                if isExperimentMode {
                    Text("実験試行: \(experimentState.trialState)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }

                Picker("表示", selection: $displayMode) {
                    Text("QR").tag(SessionDisplayMode.qr)
                    if allowsSubjectSupport {
                        Text("映像").tag(SessionDisplayMode.preview)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 20)

                    Group {
                        if displayMode == .qr {
                            qrDisplayView
                        } else {
                            remotePreviewView
                        }
                    }
                    .id("capturePreview")
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20)

                    if allowsPhotographerSupport && !selectedGuides.isEmpty {
                        guideControlsPanel
                    }

                    VStack(spacing: 8) {
                        Text(connectionState.displayText)
                            .foregroundColor(connectionState.color)
                            .bold()

                        Button(role: .destructive) {
                            endSession()
                        } label: {
                            Label("終了", systemImage: "xmark.circle.fill")
                                .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(AppCompactButtonStyle(destructive: true))
                    }
                    .padding(.horizontal, 20)
                    .padding(.bottom, 90)
                }
            }
            .onChange(of: previewScrollRequest) { _, _ in
                withAnimation(.easeInOut(duration: 0.35)) {
                    scrollProxy.scrollTo("capturePreview", anchor: .center)
                }
            }
        }
    }

    var guideSelectorView: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 10) {
                ForEach(Array(selectedGuides.enumerated()), id: \.element.id) { index, guide in
                    Button {
                        currentGuideIndex = index
                    } label: {
                        VStack(spacing: 6) {
                            if let image = guide.referenceUIImage {
                                Image(uiImage: image)
                                    .resizable()
                                    .aspectRatio(contentMode: .fill)
                                    .frame(width: 72, height: 72)
                                    .clipped()
                                    .clipShape(Circle())
                            } else {
                                RoundedRectangle(cornerRadius: 12)
                                    .fill(Color.gray.opacity(0.15))
                                    .frame(width: 72, height: 72)
                                    .overlay {
                                        Text("画像なし")
                                            .font(.caption2)
                                            .foregroundColor(.secondary)
                                    }
                            }

                            Text(guide.title)
                                .font(.caption2)
                                .lineLimit(1)
                                .frame(width: 72)
                                .foregroundColor(.primary)
                        }
                        .padding(6)
                        .background(currentGuideIndex == index ? AppStyle.elevatedSurface : Color.clear)
                        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                        .overlay {
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .stroke(currentGuideIndex == index ? Color.white : Color.clear, lineWidth: 2)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
    }

    var guideTypeControlView: some View {
        VStack(alignment: .leading, spacing: 10) {
            if allowsSubjectSupport {
                HStack {
                    Text("自分のガイド")
                        .font(.subheadline)
                        .fontWeight(.semibold)

                    Spacer()

                    Picker("自分のガイド", selection: $subjectGuideType) {
                        ForEach(GuideType.allCases) { type in
                            Text(type.displayName).tag(type)
                        }
                    }
                    .pickerStyle(.menu)
                }
            }

            HStack {
                Text("撮影者へ送るガイド")
                    .font(.subheadline)
                    .fontWeight(.semibold)

                Spacer()

                Picker("撮影者へ送るガイド", selection: $photographerGuideType) {
                    ForEach(GuideType.allCases) { type in
                        Text(type.displayName).tag(type)
                    }
                }
                .pickerStyle(.menu)
                .disabled(isUploadingGuide)
            }

        }
        .padding(12)
        .background(AppStyle.surface)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppStyle.border, lineWidth: 1)
        }
        .padding(.horizontal, 20)
    }

    var guideControlsPanel: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let currentGuide {
                Label("表示中: \(currentGuide.title)", systemImage: "photo")
                    .font(.caption.weight(.bold))
                    .foregroundColor(AppStyle.secondaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            } else {
                Label("ガイドなし", systemImage: "photo")
                    .font(.caption.weight(.bold))
                    .foregroundColor(AppStyle.secondaryText)
            }

            guideSelectionControlView

            guideTypeControlView
                .padding(.horizontal, -20)

            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("ガイド透過")
                        .font(.caption.weight(.bold))
                        .foregroundColor(AppStyle.secondaryText)

                    Slider(value: $overlayOpacity, in: 0.1...1.0)
                        .onChange(of: overlayOpacity) { _, _ in
                            sendGuideTransform()
                        }
                }

                Button {
                    resetSharedGuideTransform()
                    sendGuideTransform()
                } label: {
                    Image(systemName: "arrow.counterclockwise")
                }
                .buttonStyle(AppIconButtonStyle())
                .accessibilityLabel("位置と大きさをリセット")
            }

            Button {
                Task {
                    await uploadGuideToSession()
                }
            } label: {
                HStack(spacing: 8) {
                    if isUploadingGuide {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .white))
                    }

                    Label(isUploadingGuide ? "ガイド共有中" : "ガイド共有を開始", systemImage: "square.and.arrow.up")
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(AppCompactButtonStyle(filled: photographerGuideImage != nil && !isUploadingGuide))
            .disabled(photographerGuideImage == nil || isUploadingGuide || localSessionID.isEmpty)

            if let guideShareMessage {
                Text(guideShareMessage)
                    .font(.footnote)
                    .foregroundColor(.secondary)
            }
        }
        .appCard(padding: 12)
        .padding(.horizontal, 20)
    }

    var qrDisplayView: some View {
        VStack(spacing: 20) {
            Spacer()

            Text("相手のカメラで読み取る")
                .multilineTextAlignment(.center)
                .font(.title3.weight(.black))

            QRCodeView(text: sessionURLString)
                .frame(width: 220, height: 220)

            Text(sessionURLString)
                .font(.footnote)
                .lineLimit(2)
                .multilineTextAlignment(.center)
                .foregroundColor(.secondary)

            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(AppStyle.surface)
        .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .stroke(AppStyle.border, lineWidth: 1)
        }
    }

    var remotePreviewView: some View {
        VStack(spacing: 10) {
            GeometryReader { proxy in
                ZStack {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(Color.black.opacity(0.92))

                    if let remoteImage {
                        ZStack {
                            Image(uiImage: remoteImage)
                                .resizable()
                                .scaledToFit()
                                .frame(maxWidth: .infinity, maxHeight: .infinity)

                            if allowsSubjectSupport, let guideImage = subjectGuideImage {
                                Image(uiImage: guideImage)
                                    .resizable()
                                    .scaledToFit()
                                    .scaleEffect(sharedGuideScale)
                                    .offset(
                                        x: sharedGuideHorizontalOffset * proxy.size.width,
                                        y: sharedGuideVerticalOffset * proxy.size.height
                                    )
                                    .opacity(overlayOpacity)
                                    .padding()
                                    .contentShape(Rectangle())
                                    .gesture(
                                        guideDragGesture(in: proxy.size)
                                            .simultaneously(with: guidePinchGesture)
                                    )
                            }

                            if showGridOverlay {
                                CameraGridOverlay()
                                    .allowsHitTesting(false)
                            }

                            referencePreviewOverlay
                            gridToggleButton
                        }
                    } else {
                        VStack(spacing: 12) {
                            Image(systemName: isWebSocketConnected ? "video.fill" : "antenna.radiowaves.left.and.right")
                                .font(.system(size: 40))
                                .foregroundColor(.white)

                            Text(isWebSocketConnected ? "ライブ映像を待機中" : connectionState.displayText)
                                .foregroundColor(.white)

                            if let currentGuide {
                                Text("ガイド: \(currentGuide.title)")
                                    .font(.footnote)
                                    .foregroundColor(.white.opacity(0.8))
                            }
                        }

                        if showGridOverlay {
                            CameraGridOverlay()
                                .allowsHitTesting(false)
                        }

                        referencePreviewOverlay
                        gridToggleButton
                    }
                }
            }
            .aspectRatio(3.0 / 4.0, contentMode: .fit)
            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .stroke(AppStyle.border, lineWidth: 1)
            }

            if isWebSocketConnected {
                Text("ライブ受信中")
                    .font(.subheadline)
                    .foregroundColor(AppStyle.success)
            } else {
                Text(connectionState.displayText)
                    .font(.subheadline)
                    .foregroundColor(connectionState.color)
            }
        }
    }

    var guideSelectionControlView: some View {
        HStack {
            Text("表示するガイド")
                .font(.subheadline)
                .fontWeight(.semibold)

            Spacer()

            if selectedGuides.count > 1 {
                Picker("表示するガイド", selection: $currentGuideIndex) {
                    ForEach(Array(selectedGuides.enumerated()), id: \.element.id) { index, guide in
                        Text(guide.title).tag(index)
                    }
                }
                .pickerStyle(.menu)
            } else {
                Text(currentGuide?.title ?? "ガイドなし")
                    .font(.subheadline.weight(.bold))
                    .foregroundColor(AppStyle.secondaryText)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .padding(12)
        .background(AppStyle.surface)
        .clipShape(RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(AppStyle.border, lineWidth: 1)
        }
    }

    var referencePreviewOverlay: some View {
        VStack {
            HStack(alignment: .top) {
                if showReferencePreview, let guide = currentGuide, let image = guide.referenceUIImage {
                    VStack(alignment: .leading, spacing: 6) {
                        HStack(spacing: 6) {
                            Image(systemName: "photo")
                                .font(.caption2.weight(.black))

                            Text(guide.title)
                                .font(.caption2.weight(.black))
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)

                            Button {
                                showReferencePreview = false
                            } label: {
                                Image(systemName: "xmark")
                                    .font(.caption2.weight(.black))
                                    .frame(width: 22, height: 22)
                            }
                            .accessibilityLabel("元画像を隠す")
                        }
                        .foregroundColor(.white)

                        Image(uiImage: image)
                            .resizable()
                            .aspectRatio(contentMode: .fill)
                            .frame(width: 86, height: 112)
                            .clipped()
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .padding(8)
                    .frame(width: 126, alignment: .leading)
                    .background(Color.black.opacity(0.54))
                    .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .stroke(Color.white.opacity(0.18), lineWidth: 1)
                    }
                } else if currentGuide?.referenceUIImage != nil {
                    Button {
                        showReferencePreview = true
                    } label: {
                        Image(systemName: "photo")
                            .font(.system(size: 14, weight: .bold))
                            .foregroundStyle(.white)
                            .frame(width: 34, height: 34)
                            .background(Color.black.opacity(0.48))
                            .clipShape(Circle())
                            .overlay {
                                Circle().stroke(Color.white.opacity(0.18), lineWidth: 1)
                            }
                    }
                    .accessibilityLabel("元画像を表示")
                }

                Spacer()
            }

            Spacer()
        }
        .padding(10)
    }

    var gridToggleButton: some View {
        VStack {
            HStack {
                Spacer()

                Button {
                    showGridOverlay.toggle()
                } label: {
                    Image(systemName: showGridOverlay ? "square.grid.3x3.fill" : "square.grid.3x3")
                        .font(.system(size: 14, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(Color.black.opacity(0.48))
                        .clipShape(Circle())
                        .overlay {
                            Circle().stroke(Color.white.opacity(0.18), lineWidth: 1)
                        }
                }
                .accessibilityLabel(showGridOverlay ? "グリッド線を消す" : "グリッド線を出す")
            }

            Spacer()
        }
        .padding(10)
    }

    var receivingPhotoView: some View {
        VStack(spacing: 20) {
            Spacer()

            ProgressView()
                .scaleEffect(1.2)

            Text("相手が撮った写真を受信しています")
                .font(.title3)
                .bold()

            Text("少しお待ちください")
                .foregroundColor(.secondary)

            Spacer()
        }
        .padding()
    }

    var receivedPhotoView: some View {
        VStack(spacing: 20) {
            Spacer()

            Text("受信した写真")
                .font(.title2)
                .bold()

            if receivedImages.isEmpty {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(AppStyle.surface)
                    .frame(height: 300)
                    .overlay {
                        Text("写真がありません")
                            .foregroundColor(.secondary)
                    }
                    .padding(.horizontal, 20)
            } else {
                TabView {
                    ForEach(Array(receivedImages.enumerated()), id: \.offset) { _, image in
                        Image(uiImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(maxHeight: 420)
                            .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                            .padding(.horizontal, 20)
                    }
                }
                .frame(height: 450)
                .tabViewStyle(.page)

                Text("\(receivedImages.count)枚受信しました")
                    .foregroundColor(.secondary)
            }

            if let saveErrorMessage {
                Text(saveErrorMessage)
                    .font(.footnote)
                    .foregroundColor(.red)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
            }
            Spacer()
        }
    }
}

// MARK: - Actions
private extension TakePhoto {

    func startSession() {
        if currentGuideIndex >= selectedGuides.count {
            currentGuideIndex = 0
        }

        if isExperimentMode {
            localSessionID = experimentState.sessionId
        } else {
            localSessionID = UUID().uuidString
        }
        sessionId = localSessionID  // ContentViewのsessionIdに同期
        connectionState = .connecting
        remoteImage = nil
        displayMode = .qr
        receivedImages = []
        saveErrorMessage = nil
        phase = .qrAndPreview
        showGridOverlay = true
        shouldReconnectWebSocket = true

        connectWebSocket()
        logSubjectEvent("subject_capture_screen_opened")
    }

    func connectWebSocket(isReconnect: Bool = false) {
        disconnectWebSocket(allowReconnect: true)
        connectionState = isReconnect ? .reconnecting : .connecting
        shouldReconnectWebSocket = true

        var components = URLComponents(url: APIConfig.wsBaseURL, resolvingAgainstBaseURL: false)
        components?.queryItems = [
            URLQueryItem(name: "sessionId", value: localSessionID),
            URLQueryItem(name: "role", value: "receiver")
        ]

        guard let url = components?.url else {
            print("Invalid WebSocket URL")
            DispatchQueue.main.async {
                self.connectionState = .disconnected
            }
            return
        }

        let task = URLSession.shared.webSocketTask(with: url)
        wsTask = task
        
        print("Connecting to WebSocket: \(url.absoluteString)")
        task.resume()

        task.sendPing { error in
            DispatchQueue.main.async {
                guard self.wsTask === task else { return }

                if let error {
                    print("WebSocket ping error: \(error)")
                    self.connectionState = .disconnected
                    self.scheduleReconnect()
                    return
                }

                self.connectionState = .connected
                print("WebSocket connected, starting to receive messages")
                self.sendGuideTransform()
                self.logSubjectEvent("subject_video_socket_connected")
                self.receiveWebSocketMessage()
            }
        }
    }

    func disconnectWebSocket(allowReconnect: Bool = false) {
        shouldReconnectWebSocket = allowReconnect
        let wasConnected = connectionState == .connected
        if !allowReconnect {
            connectionState = .disconnected
        }
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        if wasConnected {
            print("WebSocket disconnected")
        }
    }

    func receiveWebSocketMessage() {
        guard let task = wsTask else {
            print("WebSocket task is nil")
            DispatchQueue.main.async {
                self.connectionState = .disconnected
            }
            return
        }
        
        task.receive {result in
            
            switch result {
            case .failure(let error):
                print("WebSocket receive error: \(error)")
                DispatchQueue.main.async {
                    self.connectionState = .disconnected
                    self.logSubjectEvent("subject_video_socket_disconnected")
                    self.scheduleReconnect()
                }

            case .success(let message):
                var imageProcessed = false
                
                switch message {
                case .data(let data):
                    if let image = UIImage(data: data) {
                        DispatchQueue.main.async {
                            self.remoteImage = image
                        }
                        imageProcessed = true
                    } else {
                        print("Failed to convert data to UIImage")
                    }

                case .string(let text):
                    if let data = Data(base64Encoded: text),
                       let image = UIImage(data: data) {
                        DispatchQueue.main.async {
                            self.remoteImage = image
                        }
                        imageProcessed = true
                    }

                @unknown default:
                    break
                }
                
                if imageProcessed {
                    DispatchQueue.main.async {
                        self.connectionState = .connected
                    }
                }

                // Continue receiving
                self.receiveWebSocketMessage()
            }
        }
    }

    func scheduleReconnect() {
        guard shouldReconnectWebSocket, phase == .qrAndPreview else { return }

        connectionState = .reconnecting
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            guard self.shouldReconnectWebSocket, self.phase == .qrAndPreview else { return }
            print("Attempting to reconnect WebSocket")
            self.connectWebSocket(isReconnect: true)
        }
    }

    func uploadGuideToSession() async {
        guard allowsPhotographerSupport,
              let guideImage = photographerGuideImage,
              !localSessionID.isEmpty else {
            guideShareMessage = "共有するガイドがありません。"
            return
        }

        isUploadingGuide = true
        guideShareMessage = nil

        do {
            let url = try await SessionAPI.shared.uploadGuide(sessionId: localSessionID, image: guideImage)
            if let url = url {
                guideShareMessage = "ガイドを共有しました。"
                print("Guide URL: \(url)")
                displayMode = .preview
                sendGuideTransform()
                previewScrollRequest += 1
                logSubjectEvent("guide_shared", payload: [
                    "guideType": photographerGuideType.rawValue,
                ])
            } else {
                guideShareMessage = "ガイド共有に失敗しました。"
            }
        } catch {
            guideShareMessage = "ガイド共有中にエラーが発生しました。"
            print("guide upload error: \(error)")
        }

        isUploadingGuide = false
    }

    func endSession() {
        saveErrorMessage = nil
        shouldReconnectWebSocket = false
        disconnectWebSocket()
        logSubjectEvent("subject_capture_screen_ended")

        DispatchQueue.main.async {
            selectedIndex = TabbarItem.receivedPhotos.rawValue
        }
    }

    func returnToPhotoTop() {
        resetTakePhotoState()

        DispatchQueue.main.async {
            selectedIndex = TabbarItem.photo.rawValue
            resetID = UUID()
        }
    }

    func resetTakePhotoState() {
        phase = .qrAndPreview
        displayMode = .qr
        currentGuideIndex = 0
        localSessionID = isExperimentMode
            ? experimentState.sessionId
            : UUID().uuidString
        sessionId = localSessionID
        connectionState = .disconnected
        receivedImages = []
        saveErrorMessage = nil
        isSavingPhotos = false
        overlayOpacity = 0.45
        showGridOverlay = true
        showReferencePreview = true
        resetSharedGuideTransform()
        shouldReconnectWebSocket = false
    }

    func resetSharedGuideTransform() {
        sharedGuideHorizontalOffset = 0.0
        sharedGuideVerticalOffset = 0.0
        sharedGuideScale = 1.0
        overlayOpacity = 0.45
        guideDragStartHorizontalOffset = 0.0
        guideDragStartVerticalOffset = 0.0
        guidePinchStartScale = 1.0
    }

    func constrainedGuideOffset(_ value: Double) -> Double {
        min(0.5, max(-0.5, value))
    }

    func constrainedGuideScale(_ value: Double) -> Double {
        min(1.8, max(0.5, value))
    }

    func guideDragGesture(in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                guard size.width > 0, size.height > 0 else { return }

                sharedGuideHorizontalOffset = constrainedGuideOffset(
                    guideDragStartHorizontalOffset + Double(value.translation.width / size.width)
                )
                sharedGuideVerticalOffset = constrainedGuideOffset(
                    guideDragStartVerticalOffset + Double(value.translation.height / size.height)
                )
                sendGuideTransform()
            }
            .onEnded { _ in
                guideDragStartHorizontalOffset = sharedGuideHorizontalOffset
                guideDragStartVerticalOffset = sharedGuideVerticalOffset
                sendGuideTransform()
            }
    }

    var guidePinchGesture: some Gesture {
        MagnificationGesture()
            .onChanged { value in
                sharedGuideScale = constrainedGuideScale(guidePinchStartScale * Double(value))
                sendGuideTransform()
            }
            .onEnded { _ in
                guidePinchStartScale = sharedGuideScale
                sendGuideTransform()
            }
    }

    func sendGuideTransform() {
        guard allowsPhotographerSupport,
              let task = wsTask,
              connectionState == .connected else { return }

        let payload: [String: Any] = [
            "type": "guide-transform",
            "offsetX": sharedGuideHorizontalOffset,
            "offsetY": sharedGuideVerticalOffset,
            "scale": sharedGuideScale,
            "opacity": overlayOpacity
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let text = String(data: data, encoding: .utf8) else {
            return
        }

        task.send(.string(text)) { error in
            if let error {
                print("guide transform send error: \(error)")
            }
        }
        logSubjectEvent("guide_transform_changed", payload: [
            "offsetX": sharedGuideHorizontalOffset,
            "offsetY": sharedGuideVerticalOffset,
            "scale": sharedGuideScale,
            "opacity": overlayOpacity,
        ])
    }

    func logSubjectEvent(_ eventType: String, payload: [String: Any] = [:]) {
        guard experimentState.isRunning else { return }
        Task {
            await ExperimentAPI.shared.logEvent(
                sessionId: experimentState.sessionId,
                trialId: experimentState.trialId,
                eventType: eventType,
                role: "subject",
                payload: payload
            )
        }
    }

}

// MARK: - QR Code
struct QRCodeView: View {
    let text: String

    private let context = CIContext()
    private let filter = CIFilter.qrCodeGenerator()

    var body: some View {
        Group {
            if let image = generateQRCode(from: text) {
                Image(uiImage: image)
                    .interpolation(.none)
                    .resizable()
                    .scaledToFit()
                    .padding(16)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
            } else {
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(Color.white)
                    .overlay {
                        Text("QR生成に失敗しました")
                            .foregroundColor(.secondary)
                    }
            }
        }
    }

    private func generateQRCode(from string: String) -> UIImage? {
        let data = Data(string.utf8)
        filter.setValue(data, forKey: "inputMessage")

        guard let outputImage = filter.outputImage else {
            return nil
        }

        let transform = CGAffineTransform(scaleX: 10, y: 10)
        let scaledImage = outputImage.transformed(by: transform)

        guard let cgImage = context.createCGImage(scaledImage, from: scaledImage.extent) else {
            return nil
        }

        return UIImage(cgImage: cgImage)
    }
}

struct CameraGridOverlay: View {
    var body: some View {
        GeometryReader { proxy in
            Path { path in
                let width = proxy.size.width
                let height = proxy.size.height

                for ratio in [1.0 / 3.0, 2.0 / 3.0] {
                    let x = width * ratio
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x, y: height))

                    let y = height * ratio
                    path.move(to: CGPoint(x: 0, y: y))
                    path.addLine(to: CGPoint(x: width, y: y))
                }
            }
            .stroke(Color.white.opacity(0.42), lineWidth: 0.75)
        }
    }
}

#Preview {
    TakePhoto(
        selectedIndex: .constant(0),
        resetID: .constant(UUID()),
        sessionId: .constant(""),
        selectedGuides: [],
        experimentState: ExperimentState()
    )
}
