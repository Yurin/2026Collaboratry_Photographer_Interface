import SwiftUI

struct ExperimentSetupView: View {
    @ObservedObject var experimentState: ExperimentState
    @Binding var sessionId: String
    @Binding var selectedIndex: Int
    @Binding var resetID: UUID

    @State private var isWorking = false
    @State private var message: String?
    @State private var abortReason = "通信または操作上の問題"
    @State private var isUnlocked = false
    @State private var enteredPIN = ""

    var body: some View {
        NavigationStack {
            if isUnlocked {
                experimentForm
            } else {
                lockView
            }
        }
        .background(AppStyle.background)
        .onDisappear {
            isUnlocked = false
            enteredPIN = ""
        }
    }

    private var experimentForm: some View {
        Form {
                Section("実験識別子") {
                    TextField("participantId（例: P001-S）", text: $experimentState.participantId)
                        .textInputAutocapitalization(.characters)
                    TextField("pairId（例: PAIR-001）", text: $experimentState.pairId)
                        .textInputAutocapitalization(.characters)
                    TextField("referenceImageId（例: REF-01）", text: $experimentState.referenceImageId)
                        .textInputAutocapitalization(.characters)
                }

                Section("実験条件") {
                    Picker("条件", selection: $experimentState.condition) {
                        ForEach(ExperimentCondition.allCases) { condition in
                            Text(condition.displayName).tag(condition)
                        }
                    }

                    Stepper(
                        "支援Level: \(experimentState.supportLevel)",
                        value: $experimentState.supportLevel,
                        in: 1...3
                    )

                    Toggle("練習試行", isOn: $experimentState.isPractice)
                }

                Section("参照姿勢") {
                    NavigationLink {
                        ReferencePoseEditorView(experimentState: experimentState)
                    } label: {
                        Label("関節点を抽出・補正する", systemImage: "figure.stand.line.dotted.figure.stand")
                    }
                    .disabled(
                        !experimentState.hasSession ||
                        experimentState.referenceImageId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    )

                    Text("試行を作成する前に、参照写真の関節点を確認して保存してください。")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Section("現在の状態") {
                    statusRow("sessionId", value: experimentState.sessionId)
                    statusRow("trialId", value: experimentState.trialId)
                    statusRow("状態", value: experimentState.trialState)
                    statusRow("条件", value: experimentState.condition.rawValue)
                }

                Section("セッション操作") {
                    Button("1. 実験セッションを作成") {
                        Task { await createSession() }
                    }
                    .disabled(isWorking || !canCreateSession)

                    Button("条件設定をサーバーへ反映") {
                        Task { await updateCondition() }
                    }
                    .disabled(isWorking || !experimentState.hasSession || experimentState.isRunning)

                    Button("2. 試行を作成") {
                        Task { await createTrial() }
                    }
                    .disabled(isWorking || !experimentState.hasSession || activeTrialExists)

                    Button("3. 試行を開始して撮影画面へ") {
                        Task { await startTrial() }
                    }
                    .disabled(isWorking || !canStartTrial)

                    Button("試行を完了") {
                        Task { await endTrial(aborted: false) }
                    }
                    .disabled(isWorking || !experimentState.isRunning)

                    TextField("中断理由", text: $abortReason)

                    Button("試行を中断", role: .destructive) {
                        Task { await endTrial(aborted: true) }
                    }
                    .disabled(isWorking || !experimentState.hasTrial || isClosed)
                }

                Section {
                    Button("現在状態を再読み込み") {
                        Task { await reloadSession() }
                    }
                    .disabled(isWorking || !experimentState.hasSession)

                    Button("通常モードへ戻す", role: .destructive) {
                        experimentState.clear()
                        sessionId = ""
                        message = "通常モードへ戻しました。"
                    }
                }

                if let message {
                    Section("結果") {
                        Text(message)
                            .foregroundStyle(message.contains("失敗") ? .red : .secondary)
                    }
                }
            }
            .navigationTitle("実験設定")
            .navigationBarTitleDisplayMode(.inline)
            .overlay {
                if isWorking {
                    ProgressView()
                        .padding(24)
                        .background(.regularMaterial)
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                }
            }
    }

    private var lockView: some View {
        VStack(spacing: 20) {
            Image(systemName: "lock.shield")
                .font(.system(size: 48))
                .foregroundStyle(.white)

            Text("実験者用画面")
                .font(.title2)
                .fontWeight(.bold)

            SecureField("実験者PIN", text: $enteredPIN)
                .textContentType(.password)
                .keyboardType(.numberPad)
                .padding(12)
                .background(AppStyle.surface)
                .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))

            Button("開く") {
                if enteredPIN == experimenterPIN {
                    isUnlocked = true
                    message = nil
                } else {
                    message = "失敗: PINが違います。"
                }
            }
            .buttonStyle(AppPrimaryButtonStyle())

            if let message {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
        .padding(28)
        .navigationTitle("実験")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var experimenterPIN: String {
        Bundle.main.object(forInfoDictionaryKey: "ExperimenterPIN") as? String ?? "2026"
    }

    private var canCreateSession: Bool {
        !experimentState.participantId.trimmingCharacters(in: .whitespaces).isEmpty &&
        !experimentState.pairId.trimmingCharacters(in: .whitespaces).isEmpty &&
        !experimentState.hasSession
    }

    private var activeTrialExists: Bool {
        experimentState.hasTrial && !isClosed
    }

    private var canStartTrial: Bool {
        experimentState.hasTrial &&
        ["configured", "ready"].contains(experimentState.trialState)
    }

    private var isClosed: Bool {
        ["completed", "aborted"].contains(experimentState.trialState)
    }

    private func statusRow(_ title: String, value: String) -> some View {
        HStack {
            Text(title)
            Spacer()
            Text(value.isEmpty ? "未設定" : value)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
    }

    private func createSession() async {
        await perform {
            let session = try await ExperimentAPI.shared.createSession(
                participantId: experimentState.participantId,
                pairId: experimentState.pairId,
                condition: experimentState.condition,
                referenceImageId: optional(experimentState.referenceImageId),
                supportLevel: experimentState.supportLevel
            )
            experimentState.apply(session: session)
            sessionId = session.sessionId
            message = "実験セッションを作成しました。"
        }
    }

    private func createTrial() async {
        await perform {
            let updatedSession = try await ExperimentAPI.shared.updateCondition(
                sessionId: experimentState.sessionId,
                condition: experimentState.condition
            )
            experimentState.apply(session: updatedSession)
            let (trial, session) = try await ExperimentAPI.shared.createTrial(
                sessionId: experimentState.sessionId,
                referenceImageId: optional(experimentState.referenceImageId),
                selectedGuideType: nil,
                supportLevel: experimentState.supportLevel,
                isPractice: experimentState.isPractice
            )
            if let session {
                experimentState.apply(session: session)
            }
            experimentState.apply(trial: trial)
            message = "試行を作成しました。"
        }
    }

    private func updateCondition() async {
        await perform {
            let session = try await ExperimentAPI.shared.updateCondition(
                sessionId: experimentState.sessionId,
                condition: experimentState.condition
            )
            experimentState.apply(session: session)
            message = "条件設定を反映しました。"
        }
    }

    private func startTrial() async {
        await perform {
            let trial = try await ExperimentAPI.shared.startTrial(
                sessionId: experimentState.sessionId,
                trialId: experimentState.trialId
            )
            experimentState.apply(trial: trial)
            sessionId = experimentState.sessionId
            resetID = UUID()
            selectedIndex = TabbarItem.photo.rawValue
            message = "試行を開始しました。"
        }
    }

    private func endTrial(aborted: Bool) async {
        await perform {
            let trial = try await ExperimentAPI.shared.endTrial(
                sessionId: experimentState.sessionId,
                trialId: experimentState.trialId,
                aborted: aborted,
                abortReason: aborted ? abortReason : nil
            )
            experimentState.apply(trial: trial)
            message = aborted ? "試行を中断しました。" : "試行を完了しました。"
        }
    }

    private func reloadSession() async {
        await perform {
            let session = try await ExperimentAPI.shared.fetchSession(
                sessionId: experimentState.sessionId
            )
            experimentState.apply(session: session)
            sessionId = session.sessionId
            message = "状態を再読み込みしました。"
        }
    }

    private func perform(_ operation: () async throws -> Void) async {
        isWorking = true
        message = nil
        do {
            try await operation()
        } catch {
            message = "失敗: \(error.localizedDescription)"
        }
        isWorking = false
    }

    private func optional(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
