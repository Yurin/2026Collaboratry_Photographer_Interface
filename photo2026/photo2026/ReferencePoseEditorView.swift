import SwiftUI
import PhotosUI
import UIKit

struct ReferencePoseEditorView: View {
    @ObservedObject var experimentState: ExperimentState

    @State private var photoItem: PhotosPickerItem?
    @State private var referenceImage: UIImage?
    @State private var pose: ReferencePose?
    @State private var automaticPose: ReferencePose?
    @State private var savedPose: ReferencePose?
    @State private var selectedPointName: String?
    @State private var displayLevel = 2
    @State private var isWorking = false
    @State private var message: String?
    @State private var showSilhouette = false
    @State private var showAutomaticComparison = false
    @State private var showPersonCountConfirmation = false

    private let skeletonPairs: [(String, String)] = [
        ("leftShoulder", "rightShoulder"),
        ("leftShoulder", "leftElbow"),
        ("leftElbow", "leftWrist"),
        ("rightShoulder", "rightElbow"),
        ("rightElbow", "rightWrist"),
        ("leftShoulder", "leftHip"),
        ("rightShoulder", "rightHip"),
        ("leftHip", "rightHip"),
        ("leftHip", "leftKnee"),
        ("leftKnee", "leftAnkle"),
        ("rightHip", "rightKnee"),
        ("rightKnee", "rightAnkle"),
        ("nose", "leftShoulder"),
        ("nose", "rightShoulder"),
    ]

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                configurationCard
                imagePicker

                if referenceImage != nil, pose != nil {
                    comparisonControls
                    poseCanvas
                    pointControls
                    actionButtons
                } else {
                    ContentUnavailableView(
                        "参照姿勢がありません",
                        systemImage: "figure.stand",
                        description: Text("写真を選び、関節点を抽出してください。")
                    )
                    .frame(minHeight: 260)
                }

                if let message {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(message.contains("失敗") ? .red : .secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(16)
        }
        .navigationTitle("目標ポーズ補正")
        .navigationBarTitleDisplayMode(.inline)
        .interactiveDismissDisabled(hasUnsavedChanges)
        .alert("検出人数を確認してください", isPresented: $showPersonCountConfirmation) {
            Button("キャンセル", role: .cancel) {}
            Button("このまま採用して保存", role: .destructive) {
                Task { await saveCorrection(approvePersonCount: true) }
            }
        } message: {
            Text(personCountConfirmationMessage)
        }
        .overlay {
            if isWorking {
                ProgressView("処理中...")
                    .padding(24)
                    .background(.regularMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 16))
            }
        }
        .onChange(of: photoItem) { _, newItem in
            guard let newItem else { return }
            Task { await loadPhoto(newItem) }
        }
        .task {
            displayLevel = max(1, experimentState.supportLevel)
            await loadSavedPoseIfAvailable()
        }
    }

    private var comparisonControls: some View {
        HStack {
            Picker("表示", selection: $showAutomaticComparison) {
                Text("補正版").tag(false)
                Text("自動推定").tag(true)
            }
            .pickerStyle(.segmented)
            .disabled(automaticPose == nil || automaticPose?.versionId == pose?.versionId)

            if hasUnsavedChanges {
                Label("未保存", systemImage: "circle.fill")
                    .font(.caption)
                    .foregroundStyle(.orange)
            }
        }
    }

    private var configurationCard: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("参照写真ID")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(experimentState.referenceImageId.isEmpty
                 ? "実験設定でreferenceImageIdを入力してください"
                 : experimentState.referenceImageId)
                .font(.headline)

            Picker("表示Level", selection: $displayLevel) {
                Text("Level 1: 粗い骨格").tag(1)
                Text("Level 2: 主要関節").tag(2)
                Text("Level 3: 全関節").tag(3)
            }
            .pickerStyle(.menu)

            if let pose {
                Label(
                    personCountLabel(for: pose),
                    systemImage: pose.personCount == 1
                        ? "person.fill.checkmark"
                        : "person.2.fill"
                )
                .font(.subheadline)
                .foregroundStyle(pose.personCount == 1 ? .green : .orange)

                if pose.personCount != 1, pose.personCountApproved == true {
                    Text("実験者確認済み")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var imagePicker: some View {
        VStack(spacing: 10) {
            PhotosPicker(selection: $photoItem, matching: .images) {
                Label("参照写真を選ぶ", systemImage: "photo")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .background(Color.blue)
                    .foregroundStyle(.white)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(!canUseEditor || isWorking)

            Button("選択写真から関節点を抽出") {
                Task { await extractPose() }
            }
            .buttonStyle(.borderedProminent)
            .tint(.green)
            .disabled(referenceImage == nil || !canUseEditor || isWorking)
        }
    }

    private var poseCanvas: some View {
        GeometryReader { geometry in
            let width = geometry.size.width
            let height = geometry.size.height

            ZStack {
                Color.black

                if let referenceImage {
                    Image(uiImage: referenceImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: width, height: height)
                        .clipped()
                }

                if showSilhouette,
                   let silhouetteURL = pose?.silhouette?.url,
                   let url = URL(string: silhouetteURL) {
                    AsyncImage(url: url) { image in
                        image
                            .resizable()
                            .scaledToFill()
                            .opacity(0.28)
                    } placeholder: {
                        EmptyView()
                    }
                }

                if let box = displayedPose?.boundingBox {
                    Rectangle()
                        .stroke(Color.yellow.opacity(0.8), lineWidth: 2)
                        .frame(
                            width: width * box.width,
                            height: height * box.height
                        )
                        .position(
                            x: width * (box.x + box.width / 2),
                            y: height * (box.y + box.height / 2)
                        )
                }

                Path { path in
                    guard let pose = displayedPose else { return }
                    let visible = Dictionary(
                        uniqueKeysWithValues: pose.keypoints
                            .filter { $0.isEnabled && isVisible($0.name) }
                            .map { ($0.name, $0) }
                    )
                    for pair in skeletonPairs {
                        guard let start = visible[pair.0],
                              let end = visible[pair.1] else { continue }
                        path.move(to: CGPoint(x: start.x * width, y: start.y * height))
                        path.addLine(to: CGPoint(x: end.x * width, y: end.y * height))
                    }
                }
                .stroke(Color.cyan.opacity(0.9), style: StrokeStyle(lineWidth: 4, lineCap: .round))

                if let pose = displayedPose {
                    ForEach(pose.keypoints.filter { isVisible($0.name) }) { point in
                        Circle()
                            .fill(point.isEnabled ? pointColor(point) : Color.gray)
                            .overlay(Circle().stroke(.white, lineWidth: selectedPointName == point.name ? 3 : 1))
                            .frame(width: selectedPointName == point.name ? 26 : 20,
                                   height: selectedPointName == point.name ? 26 : 20)
                            .position(x: point.x * width, y: point.y * height)
                            .contentShape(Rectangle().inset(by: -12))
                            .gesture(
                                DragGesture(minimumDistance: 0, coordinateSpace: .named("poseCanvas"))
                                    .onChanged { value in
                                        guard !showAutomaticComparison else { return }
                                        selectedPointName = point.name
                                        updatePoint(
                                            named: point.name,
                                            x: value.location.x / width,
                                            y: value.location.y / height
                                        )
                                    }
                            )
                            .onTapGesture {
                                guard !showAutomaticComparison else { return }
                                selectedPointName = point.name
                            }
                    }
                }
            }
            .coordinateSpace(name: "poseCanvas")
            .clipShape(RoundedRectangle(cornerRadius: 16))
            .overlay(
                RoundedRectangle(cornerRadius: 16)
                    .stroke(Color.white.opacity(0.15), lineWidth: 1)
            )
        }
        .aspectRatio(3.0 / 4.0, contentMode: .fit)
    }

    private var pointControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let selectedPoint {
                HStack {
                    VStack(alignment: .leading) {
                        Text(selectedPoint.displayName)
                            .font(.headline)
                        Text("信頼度 \(Int(selectedPoint.confidence * 100))%")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer()
                    Toggle(
                        "使用",
                        isOn: Binding(
                            get: { selectedPoint.isEnabled },
                            set: { setPointEnabled(selectedPoint.name, enabled: $0) }
                        )
                    )
                    .labelsHidden()
                }
            } else {
                Text("関節点をタップまたはドラッグして補正してください。")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if pose?.silhouetteAvailable == true {
                Toggle("シルエットを重ねる", isOn: $showSilhouette)
            }

            if let warnings = pose?.warnings, !warnings.isEmpty {
                ForEach(warnings, id: \.self) { warning in
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.caption)
                        .foregroundStyle(.orange)
                }
            }
        }
        .padding(14)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    private var actionButtons: some View {
        VStack(spacing: 10) {
            Button("手動補正を保存") {
                if requiresPersonCountApproval {
                    showPersonCountConfirmation = true
                } else {
                    Task { await saveCorrection() }
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(pose == nil || isWorking)

            HStack {
                Button("自動推定へ戻す") {
                    if let automaticPose {
                        pose = automaticPose
                        selectedPointName = nil
                        message = "自動推定位置へ戻しました。保存するまではサーバーへ反映されません。"
                    }
                }
                .buttonStyle(.bordered)
                .disabled(automaticPose == nil)

                Button("保存版を再読込") {
                    Task { await loadSavedPoseIfAvailable(showNotFound: true) }
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var canUseEditor: Bool {
        experimentState.hasSession &&
        !experimentState.referenceImageId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var selectedPoint: ReferenceKeypoint? {
        guard !showAutomaticComparison else { return nil }
        guard let selectedPointName else { return nil }
        return pose?.keypoints.first { $0.name == selectedPointName }
    }

    private var displayedPose: ReferencePose? {
        showAutomaticComparison ? (automaticPose ?? pose) : pose
    }

    private var hasUnsavedChanges: Bool {
        guard let pose else { return false }
        guard let savedPose else { return true }
        guard pose.boundingBox.x == savedPose.boundingBox.x,
              pose.boundingBox.y == savedPose.boundingBox.y,
              pose.boundingBox.width == savedPose.boundingBox.width,
              pose.boundingBox.height == savedPose.boundingBox.height,
              pose.keypoints.count == savedPose.keypoints.count else {
            return true
        }
        return zip(pose.keypoints, savedPose.keypoints).contains { pair in
            let (current, saved) = pair
            return current.name != saved.name ||
            current.x != saved.x ||
            current.y != saved.y ||
            current.isEnabled != saved.isEnabled
        }
    }

    private var requiresPersonCountApproval: Bool {
        guard let pose else { return false }
        return pose.personCount != 1 && pose.personCountApproved != true
    }

    private var personCountConfirmationMessage: String {
        guard let pose else { return "" }
        if pose.personCount == 0 {
            return "人物を検出できませんでした。表示中の骨格を手動で対象人物に合わせたことを確認してから採用してください。"
        }
        return "人物を\(pose.personCount)人検出しました。表示中の骨格が採用する1人に対応していることを確認してください。"
    }

    private func personCountLabel(for pose: ReferencePose) -> String {
        pose.personCount == 0
            ? "人物を検出できませんでした"
            : "検出人数: \(pose.personCount)人"
    }

    private func isVisible(_ name: String) -> Bool {
        switch displayLevel {
        case 1:
            return ["nose", "leftShoulder", "rightShoulder", "leftHip", "rightHip",
                    "leftAnkle", "rightAnkle"].contains(name)
        case 2:
            return !["leftEye", "rightEye", "leftEar", "rightEar",
                     "leftWrist", "rightWrist", "leftAnkle", "rightAnkle"].contains(name)
        default:
            return true
        }
    }

    private func pointColor(_ point: ReferenceKeypoint) -> Color {
        if point.confidence < 0.25 { return .orange }
        return .cyan
    }

    private func updatePoint(named name: String, x: Double, y: Double) {
        guard var current = pose,
              let index = current.keypoints.firstIndex(where: { $0.name == name }) else {
            return
        }
        current.keypoints[index].x = min(1, max(0, x))
        current.keypoints[index].y = min(1, max(0, y))
        current.keypoints[index].isEnabled = true
        pose = current
    }

    private func setPointEnabled(_ name: String, enabled: Bool) {
        guard var current = pose,
              let index = current.keypoints.firstIndex(where: { $0.name == name }) else {
            return
        }
        current.keypoints[index].isEnabled = enabled
        pose = current
    }

    private func loadPhoto(_ item: PhotosPickerItem) async {
        do {
            guard let data = try await item.loadTransferable(type: Data.self),
                  let image = UIImage(data: data) else {
                throw ExperimentAPIError.invalidResponse
            }
            referenceImage = image
            pose = nil
            automaticPose = nil
            savedPose = nil
            showAutomaticComparison = false
            message = "写真を読み込みました。関節点を抽出してください。"
        } catch {
            message = "失敗: 写真を読み込めませんでした。"
        }
    }

    private func extractPose() async {
        guard let referenceImage else { return }
        isWorking = true
        message = nil
        do {
            let extracted = try await ExperimentAPI.shared.extractReferencePose(
                sessionId: experimentState.sessionId,
                referenceImageId: experimentState.referenceImageId,
                image: referenceImage
            )
            pose = extracted
            automaticPose = extracted
            savedPose = extracted
            showAutomaticComparison = false
            self.referenceImage = try await downloadImage(extracted.image.url)
            experimentState.persist()
            message = extracted.source == "auto"
                ? "関節点を自動抽出しました。必要な点をドラッグして補正してください。"
                : "自動推定を利用できなかったため、初期骨格を手動で合わせてください。"
        } catch {
            message = "失敗: \(error.localizedDescription)"
        }
        isWorking = false
    }

    private func saveCorrection(approvePersonCount: Bool = false) async {
        guard let pose else { return }
        isWorking = true
        message = nil
        do {
            let saved = try await ExperimentAPI.shared.saveReferencePose(
                sessionId: experimentState.sessionId,
                referenceImageId: experimentState.referenceImageId,
                pose: pose,
                correctedBy: experimentState.participantId,
                approvePersonCount: approvePersonCount
            )
            self.pose = saved
            savedPose = saved
            showAutomaticComparison = false
            message = "補正した目標ポーズを保存しました（\(saved.versionId)）。"
        } catch {
            message = "失敗: \(error.localizedDescription)"
        }
        isWorking = false
    }

    private func loadSavedPoseIfAvailable(showNotFound: Bool = false) async {
        guard canUseEditor else { return }
        isWorking = true
        do {
            let saved = try await ExperimentAPI.shared.fetchReferencePose(
                sessionId: experimentState.sessionId,
                referenceImageId: experimentState.referenceImageId
            )
            pose = saved
            savedPose = saved
            automaticPose = (try? await loadAutomaticPose(for: saved)) ?? saved
            showAutomaticComparison = false
            referenceImage = try await downloadImage(saved.image.url)
            message = "保存済み目標ポーズを読み込みました。"
        } catch {
            if showNotFound {
                message = "失敗: 保存済み目標ポーズを読み込めませんでした。"
            }
        }
        isWorking = false
    }

    private func loadAutomaticPose(for saved: ReferencePose) async throws -> ReferencePose {
        if saved.source == "auto" || saved.source == "fallback-template" {
            return saved
        }

        var versionId = saved.parentVersionId
        while let currentVersionId = versionId {
            let version = try await ExperimentAPI.shared.fetchReferencePoseVersion(
                sessionId: experimentState.sessionId,
                referenceImageId: experimentState.referenceImageId,
                versionId: currentVersionId
            )
            if version.source == "auto" || version.source == "fallback-template" {
                return version
            }
            versionId = version.parentVersionId
        }
        return saved
    }

    private func downloadImage(_ urlString: String) async throws -> UIImage {
        guard let url = URL(string: urlString) else {
            throw ExperimentAPIError.invalidURL
        }
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode),
              let image = UIImage(data: data) else {
            throw ExperimentAPIError.invalidResponse
        }
        return image
    }
}
