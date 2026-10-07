import SwiftUI
import Foundation

struct ParticipantPlan: Decodable, Identifiable {
    let planId: String
    let pairId: String
    let title: String
    let available: Bool
    let totalTrials: Int
    let practiceCount: Int
    var id: String { planId }
}
struct ParticipantQuestion: Decodable, Identifiable { let id: String; let text: String }
struct ParticipantSnapshot: Decodable {
    let sessionId: String
    let trialId: String
    let revision: Int
    let experimentPhase: String
    let viewPhase: String
    let isPractice: Bool
    let trialIndex: Int
    let totalTrials: Int
    let captureCount: Int
    let maximumCaptureCount: Int
    let isLastCapture: Bool
    let currentCaptureSequence: Int?
    let referenceImageUrl: String
    let guideUrl: String
    let photoUrl: String?
    let analysisId: String?
    let acknowledged: Bool
    let submittedEvaluation: Bool
    let questionnaireSubmitted: Bool
    let guidance: [GuidanceItem]
    let ready: ReadyState?
    let questions: [ParticipantQuestion]
    let freeTextQuestion: String
    let photographerJoinPath: String?
    let completionReason: String?
    let participantReset: Bool?
    let showReadyToParticipants: Bool?
    var formKey: String { "\(sessionId):\(trialId):\(currentCaptureSequence ?? 0):\(viewPhase)" }
}

enum ParticipantLocalState {
    static func clear(_ defaults: UserDefaults = .standard) {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("ParticipantFlow") || key.hasPrefix("ParticipantAnswerDraft:") || key.hasPrefix("ParticipantStartKey:") {
            defaults.removeObject(forKey: key)
        }
    }
}

@MainActor
final class ParticipantFlowModel: ObservableObject {
    @Published var state: ParticipantSnapshot?
    @Published var plans: [ParticipantPlan] = []
    @Published var error: String?
    @Published var busy = false
    @Published var remoteImage: UIImage?
    private var socket: URLSessionWebSocketTask?
    private var stateSocket: URLSessionWebSocketTask?
    private var refreshing = false
    private var displayed = Set<String>()
    private var sessionId = UserDefaults.standard.string(forKey: "ParticipantFlowSession") ?? ""
    private var token = UserDefaults.standard.string(forKey: "ParticipantFlowToken") ?? ""
    var hasSession: Bool { !sessionId.isEmpty && !token.isEmpty }

    private func request<T: Decodable>(_ path: String, body: [String: Any]? = nil) async throws -> T {
        let url = URL(string: path, relativeTo: APIConfig.baseURL)!
        var req = URLRequest(url: url)
        req.cachePolicy = .reloadIgnoringLocalCacheData
        req.setValue(token, forHTTPHeaderField: "X-Experiment-Token")
        if let body {
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await URLSession.shared.data(for: req)
        guard let http = response as? HTTPURLResponse, (200...299).contains(http.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            throw NSError(domain: "ParticipantFlow", code: 1, userInfo: [NSLocalizedDescriptionKey: object?["error"] as? String ?? "通信できませんでした。もう一度お試しください。"])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func load() async {
        if hasSession { await refresh(); await diagnostic("experiment_resume"); return }
        struct Response: Decodable { let plans: [ParticipantPlan] }
        do { let result: Response = try await request("api/participant-experiments/plans"); plans = result.plans; error = nil }
        catch { self.error = error.localizedDescription }
    }
    func start(_ plan: ParticipantPlan) async {
        guard !busy else { return }; busy = true; defer { busy = false }
        struct Start: Decodable { let sessionId: String; let token: String; let state: ParticipantSnapshot }
        let keyName = "ParticipantStartKey:\(plan.planId)"
        let key = UserDefaults.standard.string(forKey: keyName) ?? UUID().uuidString
        UserDefaults.standard.set(key, forKey: keyName)
        do {
            let result: Start = try await request("api/participant-experiments/start", body: ["planId": plan.planId, "startKey": key])
            sessionId = result.sessionId; token = result.token
            UserDefaults.standard.set(sessionId, forKey: "ParticipantFlowSession")
            UserDefaults.standard.set(token, forKey: "ParticipantFlowToken")
            accept(result.state)
        } catch { self.error = error.localizedDescription }
    }
    private func accept(_ next: ParticipantSnapshot) {
        guard hasSession, next.sessionId == sessionId else { return }
        if next.participantReset == true { clearLocalState(); Task { await load() }; return }
        guard state == nil || next.revision >= state!.revision else { return }
        state = next; error = nil
        if stateSocket == nil { connectState() }
        if next.experimentPhase == "capture" && socket == nil { connectVideo() }
        if next.experimentPhase != "capture" { stopVideo() }
    }
    func refresh() async {
        guard hasSession, !refreshing else { return }; refreshing = true; defer { refreshing = false }
        do { let next: ParticipantSnapshot = try await request("api/participant-experiments/\(sessionId)/state"); accept(next); await logGuidanceDisplay() }
        catch { self.error = error.localizedDescription }
    }
    func action(_ action: String, values: [String: Any] = [:]) async -> Bool {
        guard let state, !busy else { return false }; busy = true; defer { busy = false }
        var body: [String: Any] = ["trialId": state.trialId, "captureSequence": state.currentCaptureSequence.map { $0 as Any } ?? NSNull()]
        values.forEach { body[$0.key] = $0.value }
        do { let next: ParticipantSnapshot = try await request("api/participant-experiments/\(sessionId)/\(action)", body: body); accept(next); return true }
        catch { self.error = error.localizedDescription; if action == "evaluation" || action == "questionnaire" { await diagnostic(action + "_submit", outcome: "failed") }; return false }
    }
    func acknowledge() async { guard let state else { return }; _ = await action("ack", values: ["phase": state.experimentPhase]) }
    func logGuidanceDisplay() async {
        guard let state, state.experimentPhase == "guidance", !displayed.contains(state.formKey) else { return }
        let key = state.formKey
        displayed.insert(key)
        do {
            let _: ParticipantSnapshot = try await request("api/participant-experiments/\(sessionId)/displayed", body: ["trialId": state.trialId, "captureSequence": state.currentCaptureSequence.map { $0 as Any } ?? NSNull(), "displayedAt": Int64(Date().timeIntervalSince1970 * 1000)])
        } catch { displayed.remove(key) }
    }
    private func connectState() {
        var url = URLComponents(url: APIConfig.wsBaseURL, resolvingAgainstBaseURL: false)!
        url.path = "/ws/session"
        url.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
        let task = URLSession.shared.webSocketTask(with: url.url!); stateSocket = task; task.resume()
        Task { [weak self] in
            await self?.diagnostic("websocket_reconnect")
            do {
                while !Task.isCancelled {
                    _ = try await task.receive()
                    guard let self, self.stateSocket === task else { return }
                    await self.refresh()
                }
            } catch { if self?.stateSocket === task { self?.stateSocket = nil } }
        }
    }
    func diagnostic(_ operation: String, outcome: String = "success") async {
        guard hasSession else { return }
        let _: ParticipantSnapshot? = try? await request("api/participant-experiments/\(sessionId)/diagnostic", body: ["operation": operation, "outcome": outcome])
    }
    func clearLocalState() {
        disconnect(); ParticipantLocalState.clear(); state = nil; sessionId = ""; token = ""; remoteImage = nil; displayed.removeAll(); plans = []
    }
    func finishSession() async {
        if await action("reset") { clearLocalState(); await load() }
    }
    func disconnect() { stopVideo(); stateSocket?.cancel(with: .goingAway, reason: nil); stateSocket = nil }

    func connectVideo() {
        var url = URLComponents(url: APIConfig.wsBaseURL, resolvingAgainstBaseURL: false)!
        url.queryItems = [URLQueryItem(name: "sessionId", value: sessionId), URLQueryItem(name: "role", value: "receiver")]
        let task = URLSession.shared.webSocketTask(with: url.url!); socket = task; task.resume()
        Task { [weak self] in
            do {
                while !Task.isCancelled {
                    let message = try await task.receive()
                    guard let self, self.socket === task else { return }
                    if case .data(let data) = message { self.remoteImage = UIImage(data: data) }
                }
            } catch { if self?.socket === task { self?.socket = nil } }
        }
    }
    func stopVideo() { socket?.cancel(with: .goingAway, reason: nil); socket = nil }
}

struct ParticipantExperimentView: View {
    @StateObject private var model = ParticipantFlowModel()
    @State private var pairCode = ""
    @State private var showQR = false
    @State private var showPhotos = false
    @State private var pendingPlan: ParticipantPlan?
    @State private var confirmStart = false
    @State private var confirmWithdrawal = false
    @State private var confirmReset = false
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if let error = model.error {
                        Text(error).foregroundStyle(.red)
                        Button("接続を確認・再読み込み") { Task { await model.load() } }
                    }
                    if let state = model.state {
                        participantScreen(state)
                        if !["experimentCompleted", "withdrawn", "technical_failure", "researcher_terminated"].contains(state.experimentPhase) {
                            Button("実験を中断する", role: .destructive) { confirmWithdrawal = true }.disabled(model.busy)
                        }
                    } else { startScreen }
                }.padding(20)
            }
            .background(AppStyle.background)
            .navigationTitle("撮影実験")
            .alert("ペア番号を確認してください", isPresented: $confirmStart) {
                Button("キャンセル", role: .cancel) { pendingPlan = nil }
                Button("このペアとして開始") { if let plan = pendingPlan { Task { await model.start(plan) } } }
            } message: { if let plan = pendingPlan { Text("\(plan.pairId)として実験を開始します\n本番試行: \(plan.totalTrials)回\n練習: \(plan.practiceCount)回") } }
            .alert("ふたりの実験を中断しますか？", isPresented: $confirmWithdrawal) {
                Button("続ける", role: .cancel) {}
                Button("実験を中断する", role: .destructive) { Task { _ = await model.action("withdraw", values: ["confirm": true]) } }
            } message: { Text("再開はできません。ここまでの記録は保存されます。") }
            .alert("別のペアへ切り替えますか？", isPresented: $confirmReset) {
                Button("キャンセル", role: .cancel) {}
                Button("参加情報を消して退出") { pairCode = ""; Task { await model.finishSession() } }
            } message: { Text("両端末の参加情報と入力途中の回答を消去します。保存済み研究データは残ります。") }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .topBarTrailing) { if model.state?.photographerJoinPath != nil { Button("参加QR") { showQR = true } } }
            }
            .sheet(isPresented: $showQR) {
                if let path = model.state?.photographerJoinPath, let url = URL(string: path, relativeTo: APIConfig.appBaseURL) {
                    VStack(spacing: 24) { Text("撮影する方が読み取ってください").font(.headline); QRCodeView(text: url.absoluteString).frame(width: 260, height: 260); Button("閉じる") { showQR = false } }.padding()
                }
            }
            .sheet(isPresented: $showPhotos) {
                if let s = model.state { NavigationStack { ReceivedPhotosView(sessionId: .constant(s.sessionId), refreshRequest: 0) } }
            }
            .task {
                await model.load()
                while !Task.isCancelled {
                    try? await Task.sleep(for: .seconds(2))
                    if Task.isCancelled { break }
                    await model.refresh()
                }
            }
            .onChange(of: model.state?.sessionId) { _, next in
                if next == nil { pairCode = ""; pendingPlan = nil; showQR = false; showPhotos = false }
            }
            .onDisappear { model.disconnect() }
        }
    }
    var startScreen: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("ユーザ実験を開始").font(.title2.bold())
            Text("案内されたペア番号を入力してください。練習から順番に進みます。")
            TextField("ペア番号", text: $pairCode).textInputAutocapitalization(.characters).textFieldStyle(.roundedBorder)
            ForEach(model.plans.filter { $0.pairId.caseInsensitiveCompare(pairCode.trimmingCharacters(in: .whitespaces)) == .orderedSame }) { plan in
                if plan.available {
                    Text("ペア番号: \(plan.pairId)\n本番試行: \(plan.totalTrials)回\n練習: \(plan.practiceCount)回")
                    Button("\(plan.pairId)として実験を開始") { pendingPlan = plan; confirmStart = true }.buttonStyle(.borderedProminent).disabled(model.busy)
                }
                else { Text("この実験は準備中です。担当者へお知らせください。") }
            }
            if model.plans.isEmpty { Text("実験計画がまだ登録されていません。") }
        }
    }
    func photo(_ path: String?) -> some View {
        AsyncImage(url: path.flatMap { URL(string: $0, relativeTo: APIConfig.baseURL) }) { phase in
            if let image = phase.image { image.resizable().scaledToFit().frame(maxHeight: 380) }
            else if phase.error != nil { Text("画像を読み込めません。接続を確認して画面を開き直してください。") }
            else { ProgressView() }
        }
    }
    @ViewBuilder func participantScreen(_ s: ParticipantSnapshot) -> some View {
        Text(s.isPractice ? "練習" : "撮影 \(s.trialIndex) / \(s.totalTrials)").font(.subheadline).foregroundStyle(.secondary)
        switch s.viewPhase {
        case "experimentIntroduction":
            Text("ふたりで撮影を進めましょう").font(.title2.bold())
            Text("お手本を確認して撮影し、ふたりがそれぞれ写真を評価します。回答は相手には見えません。はじめに練習を行います。")
            Button("撮影する方をQRで招待") { showQR = true }.buttonStyle(.borderedProminent)
            nextButton(s)
        case "trialIntroduction":
            Text(s.isPractice ? "まずは練習です" : "次の撮影を始めます").font(.title2.bold())
            Text("ふたりが納得する写真になるまで、最大\(s.maximumCaptureCount)回撮影できます。")
            nextButton(s)
        case "referenceViewing":
            Text("お手本写真を確認してください").font(.title2.bold())
            photo(s.referenceImageUrl)
            nextButton(s)
        case "capture":
            Text("お手本に近い写真を撮ってください").font(.title2.bold())
            Text("\(s.captureCount + 1)回目 / \(s.maximumCaptureCount)回" + (s.isLastCapture ? " ― 最後の撮影です" : ""))
            Color.black.aspectRatio(3.0 / 4.0, contentMode: .fit).overlay {
                ZStack {
                    if let image = model.remoteImage { Image(uiImage: image).resizable().scaledToFit() }
                    else { Text("撮影者のカメラ映像を待っています").foregroundStyle(.white) }
                    AsyncImage(url: URL(string: s.guideUrl, relativeTo: APIConfig.baseURL)) { phase in
                        if let image = phase.image { image.resizable().scaledToFit().opacity(0.5) }
                    }.allowsHitTesting(false)
                }
            }

            DisclosureGroup("お手本を確認") { photo(s.referenceImageUrl) }
        case "analyzing":
            Text("写真を保存・確認しています").font(.title2.bold())
            ProgressView(); Text("しばらくお待ちください。保存が進まない場合は撮影者の画面から再撮影できます。")
        case "photoEvaluation":
            Text("今撮った写真を評価してください").font(.title2.bold())
            photo(s.photoUrl)
            DisclosureGroup("お手本を確認") { photo(s.referenceImageUrl) }
            ParticipantAnswerForm(state: s, model: model, questionnaire: false).id(s.formKey)
        case "waitingForPartnerEvaluation":
            Text("相手の回答を待っています").font(.title2.bold())
            Text("あなたの回答は保存されました。")
            photo(s.photoUrl)
        case "guidance":
            VStack(alignment: .leading, spacing: 18) {
                Text("次はここを直してみてください").font(.title2.bold())
                if s.guidance.isEmpty { Text(s.showReadyToParticipants == true && s.ready?.poseReady == true ? "ポーズはOKです。もう一度撮影してください。" : "もう一度撮影してください。") }
                ForEach(s.guidance) { g in Text(g.message).font(.headline) }
                nextButton(s, label: "調整できたら次の撮影へ")
            }.task(id: s.formKey) { await model.logGuidanceDisplay() }
        case "trialQuestionnaire":
            Text("この撮影について教えてください").font(.title2.bold())
            Text("1＝全くそう思わない、7＝とてもそう思う")
            if s.questionnaireSubmitted { Text("相手の回答を待っています") }
            else { ParticipantAnswerForm(state: s, model: model, questionnaire: true).id(s.formKey) }
        case "trialCompleted":
            Text("この撮影は終了です").font(.title2.bold())
            Text(s.completionReason == "maximum_capture_count" ? "撮影回数の上限に達しました。" : "ふたりがこの写真を選びました。")
            photo(s.photoUrl); nextButton(s)
        case "experimentCompleted":
            Text("実験はすべて終了です").font(.title2.bold())
            Text("ご協力ありがとうございました。写真と回答は保存されました。")
            Button("最終写真を確認・保存") { showPhotos = true }.buttonStyle(.borderedProminent)
            Button("別のペアの実験を開始") { confirmReset = true }
        case "withdrawn", "technical_failure", "researcher_terminated":
            Text("実験を中断しました").font(.title2.bold())
            Text("ここまでの記録は保存されています。")
            Button("別のペアの実験を開始") { confirmReset = true }
        default: ProgressView("状態を確認しています")
        }
    }
    @ViewBuilder func nextButton(_ s: ParticipantSnapshot, label: String = "確認しました・次へ") -> some View {
        if s.acknowledged { Text("相手の準備を待っています") }
        else { Button(label) { Task { await model.acknowledge() } }.buttonStyle(.borderedProminent).disabled(model.busy) }
    }
}

private struct ParticipantAnswerForm: View {
    let state: ParticipantSnapshot
    @ObservedObject var model: ParticipantFlowModel
    let questionnaire: Bool
    @State private var ratings: [String: Int] = [:]
    @State private var retake = ""
    @State private var comment = ""
    private var key: String { "ParticipantAnswerDraft:\(state.formKey)" }
    private var fields: [ParticipantQuestion] {
        questionnaire ? state.questions : [ParticipantQuestion(id: "similarityRating", text: "お手本写真にどれくらい近いと思いますか？（1＝全く近くない、7＝とても近い）"), ParticipantQuestion(id: "satisfactionRating", text: "この写真にどれくらい満足していますか？（1＝全く満足していない、7＝とても満足している）")]
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 22) {
            ForEach(fields) { q in
                Text(q.text)
                Picker(q.text, selection: Binding(get: { ratings[q.id] ?? 0 }, set: { ratings[q.id] = $0; persist() })) {
                    Text("選択してください").tag(0)
                    ForEach(1...7, id: \.self) { Text("\($0)").tag($0) }
                }.pickerStyle(.menu)
            }
            if questionnaire {
                Text(state.freeTextQuestion + "（任意）")
                TextField("自由記述", text: $comment, axis: .vertical).textFieldStyle(.roundedBorder).onChange(of: comment) { _, _ in persist() }
            } else {
                Picker("この写真を撮り直したいですか？", selection: $retake) {
                    Text("選択してください").tag("")
                    Text("撮り直したい").tag("yes")
                    Text("この写真でよい").tag("no")
                }.onChange(of: retake) { _, _ in persist() }
            }
            Button("回答を送信") {
                Task {
                    let values: [String: Any] = questionnaire ? ["answers": ratings, "comment": comment] : ["similarityRating": ratings["similarityRating"] ?? 0, "satisfactionRating": ratings["satisfactionRating"] ?? 0, "wantsRetake": retake == "yes"]
                    if await model.action(questionnaire ? "questionnaire" : "evaluation", values: values) { UserDefaults.standard.removeObject(forKey: key) }
                }
            }.buttonStyle(.borderedProminent).disabled(model.busy || !fields.allSatisfy { (1...7).contains(ratings[$0.id] ?? 0) } || (!questionnaire && retake.isEmpty) || comment.count > 2000)
        }.onAppear {
            if let draft = UserDefaults.standard.dictionary(forKey: key) {
                ratings = draft["ratings"] as? [String: Int] ?? [:]; retake = draft["retake"] as? String ?? ""; comment = draft["comment"] as? String ?? ""
            }
        }
    }
    private func persist() { UserDefaults.standard.set(["ratings": ratings, "retake": retake, "comment": comment], forKey: key) }
}
