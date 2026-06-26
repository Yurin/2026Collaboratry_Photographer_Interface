import SwiftUI
import Photos
import CoreImage.CIFilterBuiltins
import UIKit

enum TakePhotoPhase {
    case qrAndPreview
    case receivingPhoto
    case receivedPhoto
}

enum SessionDisplayMode {
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
    @State private var sharedGuideHorizontalOffset: Double = 0.0
    @State private var sharedGuideScale: Double = 1.0

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
        experimentState.hasSession
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

            HStack(spacing: 12) {
                Button {
                    displayMode = .qr
                } label: {
                    Text("QR表示")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                        .background(displayMode == .qr ? Color.white : AppStyle.surface)
                        .foregroundColor(displayMode == .qr ? .black : .white)
                        .clipShape(Capsule())
                }

                if allowsSubjectSupport {
                    Button {
                        displayMode = .preview
                    } label: {
                        Text("映像表示")
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(displayMode == .preview ? Color.white : AppStyle.surface)
                            .foregroundColor(displayMode == .preview ? .black : .white)
                            .clipShape(Capsule())
                    }
                }
            }
            .padding(.horizontal, 20)

            if allowsPhotographerSupport {
                if let currentGuide {
                    Text("表示中ガイド: \(currentGuide.title)")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                } else {
                    Text("ガイドなし")
                        .font(.subheadline)
                        .foregroundColor(.secondary)
                }
            }

            if allowsPhotographerSupport && !selectedGuides.isEmpty {
                guideSelectorView
                guideTypeControlView

                HStack(spacing: 12) {
                    Button {
                        Task {
                            await uploadGuideToSession()
                        }
                    } label: {
                        HStack {
                            if isUploadingGuide {
                                ProgressView()
                                    .progressViewStyle(CircularProgressViewStyle(tint: .white))
                            }
                            Text(isUploadingGuide ? "共有中..." : "ガイドを共有")
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(photographerGuideImage == nil || isUploadingGuide ? AppStyle.surface : Color.white)
                        .foregroundColor(photographerGuideImage == nil || isUploadingGuide ? .secondary : .black)
                        .clipShape(Capsule())
                    }
                    .disabled(photographerGuideImage == nil || isUploadingGuide || localSessionID.isEmpty)
                }
                .padding(.horizontal, 20)

                if let guideShareMessage {
                    Text(guideShareMessage)
                        .font(.footnote)
                        .foregroundColor(.secondary)
                        .padding(.horizontal, 20)
                }
            }

            Group {
                if displayMode == .qr {
                    qrDisplayView
                } else {
                    remotePreviewView
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 20)

            if allowsPhotographerSupport && !selectedGuides.isEmpty {
                VStack(alignment: .leading, spacing: 10) {
                    Text("ガイドの透明度")
                        .font(.subheadline)
                        .fontWeight(.semibold)

                    Slider(value: $overlayOpacity, in: 0.1...1.0)
                        .onChange(of: overlayOpacity) { _, _ in
                            sendGuideTransform()
                        }

                    Text("撮影者画面のガイド調整")
                        .font(.subheadline)
                        .fontWeight(.semibold)
                        .padding(.top, 6)

                    HStack {
                        Text("左右")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Slider(value: $sharedGuideHorizontalOffset, in: -0.35...0.35)
                            .onChange(of: sharedGuideHorizontalOffset) { _, _ in
                                sendGuideTransform()
                            }
                    }

                    HStack {
                        Text("大きさ")
                            .font(.caption)
                            .foregroundColor(.secondary)
                        Slider(value: $sharedGuideScale, in: 0.65...1.5)
                            .onChange(of: sharedGuideScale) { _, _ in
                                sendGuideTransform()
                            }
                    }

                    Button {
                        resetSharedGuideTransform()
                        sendGuideTransform()
                    } label: {
                        Text("撮影者画面のガイドをリセット")
                            .font(.caption)
                    }
                    .padding(8)
                    .background(AppStyle.elevatedSurface)
                    .clipShape(Capsule())
                }
                .appCard()
                .padding(.horizontal, 20)
            }

            VStack(spacing: 12) {
                Text(connectionState.displayText)
                    .foregroundColor(connectionState.color)
                    .bold()

                Button(role: .destructive) {
                    endSession()
                } label: {
                    Text("終了")
                        .frame(maxWidth: .infinity)
                        .padding()
                        .background(AppStyle.danger)
                        .foregroundColor(.white)
                        .clipShape(Capsule())
                }
            }
            .padding(.horizontal, 20)
            .padding(.bottom, 70)
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
        VStack(spacing: 16) {
            Spacer()

            ZStack {
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .fill(Color.black.opacity(0.92))

                if let remoteImage {
                    ZStack {
                        Image(uiImage: remoteImage)
                            .resizable()
                            .scaledToFill()
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                            .clipped()

                        if allowsSubjectSupport, let guideImage = subjectGuideImage {
                            Image(uiImage: guideImage)
                                .resizable()
                                .scaledToFit()
                                .scaleEffect(sharedGuideScale)
                                .offset(x: sharedGuideHorizontalOffset * 320)
                                .opacity(overlayOpacity)
                                .padding()
                        }
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
                }
            }
            .frame(height: 420)
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

            Spacer()
        }
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

        if experimentState.hasSession {
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
                sendGuideTransform()
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
        localSessionID = experimentState.hasSession
            ? experimentState.sessionId
            : UUID().uuidString
        sessionId = localSessionID
        connectionState = .disconnected
        receivedImages = []
        saveErrorMessage = nil
        isSavingPhotos = false
        overlayOpacity = 0.45
        resetSharedGuideTransform()
        shouldReconnectWebSocket = false
    }

    func resetSharedGuideTransform() {
        sharedGuideHorizontalOffset = 0.0
        sharedGuideScale = 1.0
        overlayOpacity = 0.45
    }

    func sendGuideTransform() {
        guard allowsPhotographerSupport,
              let task = wsTask,
              connectionState == .connected else { return }

        let payload: [String: Any] = [
            "type": "guide-transform",
            "offsetX": sharedGuideHorizontalOffset,
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
            "scale": sharedGuideScale,
            "opacity": overlayOpacity,
        ])
    }

    func logSubjectEvent(_ eventType: String, payload: [String: Any] = [:]) {
        guard experimentState.hasTrial else { return }
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

#Preview {
    TakePhoto(
        selectedIndex: .constant(0),
        resetID: .constant(UUID()),
        sessionId: .constant(""),
        selectedGuides: [],
        experimentState: ExperimentState()
    )
}
