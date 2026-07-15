import SwiftUI

struct ContentView: View {
    @State private var selectedIndex = TabbarItem.home.rawValue
    @State private var takePhotoResetID = UUID()
    @State private var pendingSelectedGuides: [GuideItem] = []
    @State private var sessionId: String = ""
    @State private var photoRefreshRequest: Int = 0
    @State private var sessionSocketTask: URLSessionWebSocketTask?
    @State private var shouldReconnectSessionSocket = false
    @State private var roleGuidanceUpdate: RoleGuidanceUpdate?
    @State private var latestRoleGuidanceCaptureSequence: Int?
    @State private var latestRoleGuidanceCaptureTimestamp: Int64?
    @StateObject private var experimentState = ExperimentState()

    var body: some View {
        ZStack(alignment: .bottom) {
            AppStyle.background.ignoresSafeArea()

            TabView(selection: $selectedIndex) {
                HomeView(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    pendingSelectedGuides: $pendingSelectedGuides
                )
                .tag(TabbarItem.home.rawValue)

                TakePhoto(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    sessionId: $sessionId,
                    selectedGuides: pendingSelectedGuides,
                    experimentState: experimentState,
                    roleGuidanceUpdate: roleGuidanceUpdate
                )
                .id(takePhotoResetID)
                .tag(TabbarItem.photo.rawValue)

                MakeGuide(sessionId: $sessionId)
                    .tag(TabbarItem.guide.rawValue)

                SceneTemplateView(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    pendingSelectedGuides: $pendingSelectedGuides
                )
                .tag(TabbarItem.template.rawValue)

                ShowGuide(
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID,
                    pendingSelectedGuides: $pendingSelectedGuides
                )
                .tag(TabbarItem.showGuide.rawValue)
                
                ReceivedPhotosView(
                    sessionId: $sessionId,
                    refreshRequest: photoRefreshRequest
                )
                .tag(TabbarItem.receivedPhotos.rawValue)

                ExperimentSetupView(
                    experimentState: experimentState,
                    sessionId: $sessionId,
                    selectedIndex: $selectedIndex,
                    resetID: $takePhotoResetID
                )
                .tag(TabbarItem.experiment.rawValue)
            }

            HStack(spacing: 0) {
                ForEach(TabbarItem.allCases, id: \.self) { item in
                    Button {
                        selectedIndex = item.rawValue
                    } label: {
                        tabItemView(
                            tabbarItem: item,
                            isActive: selectedIndex == item.rawValue
                        )
                    }
                }
            }
            .padding(5)
            .frame(height: 62)
            .background(.ultraThinMaterial)
            .clipShape(Capsule())
            .overlay {
                Capsule().stroke(AppStyle.border, lineWidth: 1)
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 6)
        }
        .appScreen()
        .onAppear {
            shouldReconnectSessionSocket = true
            connectSessionSocket()
        }
        .onDisappear {
            disconnectSessionSocket()
        }
        .onChange(of: sessionId) { _, _ in
            roleGuidanceUpdate = nil
            latestRoleGuidanceCaptureSequence = nil
            latestRoleGuidanceCaptureTimestamp = nil
            shouldReconnectSessionSocket = true
            connectSessionSocket()
            photoRefreshRequest += 1
        }
        .onChange(of: experimentState.condition) { _, condition in
            if experimentState.isRunning && condition != .roleBased {
                roleGuidanceUpdate = nil
                latestRoleGuidanceCaptureSequence = nil
                latestRoleGuidanceCaptureTimestamp = nil
            }
        }
        .onChange(of: experimentState.trialId) { _, _ in
            roleGuidanceUpdate = nil
            latestRoleGuidanceCaptureSequence = nil
            latestRoleGuidanceCaptureTimestamp = nil
        }
    }

    func tabItemView(tabbarItem: TabbarItem, isActive: Bool) -> some View {
        VStack(spacing: 3) {
            Image(systemName: tabbarItem.iconName)
                .font(.system(size: 17, weight: .bold))
                .foregroundColor(isActive ? .black : AppStyle.secondaryText)

            Text(tabbarItem.title)
                .lineLimit(1)
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(isActive ? .black : AppStyle.secondaryText)
        }
        .frame(maxWidth: .infinity)
        .frame(height: 50)
        .background(isActive ? Color.white : Color.clear)
        .clipShape(Capsule())
    }

    func connectSessionSocket(isReconnect: Bool = false) {
        disconnectSessionSocket(allowReconnect: true)

        guard !sessionId.isEmpty,
              var components = URLComponents(url: APIConfig.sessionWsBaseURL, resolvingAgainstBaseURL: false) else {
            return
        }

        components.queryItems = [
            URLQueryItem(name: "sessionId", value: sessionId)
        ]

        guard let url = components.url else { return }

        let task = URLSession.shared.webSocketTask(with: url)
        sessionSocketTask = task
        task.resume()
        print("\(isReconnect ? "Reconnecting" : "Connecting") session WebSocket: \(url.absoluteString)")
        task.sendPing { error in
            DispatchQueue.main.async {
                guard sessionSocketTask === task else { return }
                if let error {
                    print("session socket connection error: \(error)")
                    sessionSocketTask = nil
                    roleGuidanceUpdate = nil
                    scheduleSessionSocketReconnect()
                    return
                }
                receiveSessionSocketMessage(from: task)
            }
        }
    }

    func disconnectSessionSocket(allowReconnect: Bool = false) {
        shouldReconnectSessionSocket = allowReconnect
        let task = sessionSocketTask
        sessionSocketTask = nil
        task?.cancel(with: .goingAway, reason: nil)
    }

    func receiveSessionSocketMessage(from task: URLSessionWebSocketTask) {
        task.receive { result in
            switch result {
            case .failure(let error):
                print("session socket receive error: \(error)")
                DispatchQueue.main.async {
                    guard sessionSocketTask === task else { return }
                    sessionSocketTask = nil
                    roleGuidanceUpdate = nil
                    scheduleSessionSocketReconnect()
                }

            case .success(let message):
                handleSessionSocketMessage(message)
                DispatchQueue.main.async {
                    guard sessionSocketTask === task else { return }
                    receiveSessionSocketMessage(from: task)
                }
            }
        }
    }

    func handleSessionSocketMessage(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .string(let text):
            guard let messageData = text.data(using: .utf8) else { return }
            data = messageData
        case .data(let messageData):
            data = messageData
        @unknown default:
            return
        }

        let decoder = JSONDecoder()
        let payload: SessionSocketPayload
        do {
            payload = try decoder.decode(SessionSocketPayload.self, from: data)
        } catch {
            print("session socket JSON decode error: \(error)")
            return
        }

        DispatchQueue.main.async {
            guard payload.sessionId == nil || payload.sessionId == sessionId else { return }

            if payload.type == "photos-updated" {
                photoRefreshRequest += 1
                selectedIndex = TabbarItem.receivedPhotos.rawValue
                return
            }

            if payload.type == "roleGuidanceUpdated" {
                do {
                    let update = try decoder.decode(RoleGuidanceUpdate.self, from: data)
                    guard !experimentState.isRunning || experimentState.condition == .roleBased else {
                        print("Ignored subject guidance for condition \(experimentState.condition.rawValue)")
                        return
                    }
                    if experimentState.isRunning,
                       let updateTrialId = update.trialId,
                       updateTrialId != experimentState.trialId {
                        print("Ignored roleGuidanceUpdated for stale trial: \(updateTrialId)")
                        return
                    }
                    guard shouldAcceptRoleGuidance(update) else {
                        print("Ignored stale roleGuidanceUpdated: \(update.photoId ?? "unknown")")
                        return
                    }
                    roleGuidanceUpdate = update
                    print("Received roleGuidanceUpdated: \(update.photoId ?? "unknown")")
                } catch {
                    print("roleGuidanceUpdated decode error: \(error)")
                }
            }
        }
    }

    func shouldAcceptRoleGuidance(_ update: RoleGuidanceUpdate) -> Bool {
        if let sequence = update.captureSequence {
            if let latestRoleGuidanceCaptureSequence,
               sequence < latestRoleGuidanceCaptureSequence {
                return false
            }
            latestRoleGuidanceCaptureSequence = sequence
            if let timestamp = update.captureTimestamp {
                latestRoleGuidanceCaptureTimestamp = max(
                    latestRoleGuidanceCaptureTimestamp ?? timestamp,
                    timestamp
                )
            }
            return true
        }
        if let timestamp = update.captureTimestamp {
            if let latestRoleGuidanceCaptureTimestamp,
               timestamp < latestRoleGuidanceCaptureTimestamp {
                return false
            }
            latestRoleGuidanceCaptureTimestamp = timestamp
        }
        return true
    }

    func scheduleSessionSocketReconnect() {
        guard shouldReconnectSessionSocket, !sessionId.isEmpty else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
            guard shouldReconnectSessionSocket,
                  !sessionId.isEmpty,
                  sessionSocketTask == nil else { return }
            connectSessionSocket(isReconnect: true)
        }
    }
}

private struct SessionSocketPayload: Decodable {
    let type: String
    let sessionId: String?
}

enum TabbarItem: Int, CaseIterable {
    case home
    case photo
    case guide
    case template
    case showGuide
    case receivedPhotos
    case experiment

    static var allCases: [TabbarItem] {
        [.home, .photo, .guide, .showGuide, .receivedPhotos, .experiment]
    }

    var title: String {
        switch self {
        case .home:
            return "ホーム"
        case .photo:
            return "写真"
        case .guide:
            return "ガイド作成"
        case .template:
            return "テンプレ"
        case .showGuide:
            return "ライブラリ"
        case .receivedPhotos:
            return "写真一覧"
        case .experiment:
            return "実験"
        }
    }

    var iconName: String {
        switch self {
        case .home:
            return "house.fill"
        case .photo:
            return "camera.fill"
        case .guide:
            return "wand.and.stars"
        case .template:
            return "person.crop.rectangle"
        case .showGuide:
            return "square.grid.2x2.fill"
        case .receivedPhotos:
            return "photo.on.rectangle"
        case .experiment:
            return "flask.fill"
        }
    }
}

#Preview {
    ContentView()
}
