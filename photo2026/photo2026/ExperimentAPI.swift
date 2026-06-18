import Foundation
import SwiftUI
import UIKit

enum ExperimentCondition: String, CaseIterable, Codable, Identifiable {
    case noSupport = "A"
    case photographerOnly = "B"
    case roleBased = "C"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .noSupport:
            return "A: 支援なし"
        case .photographerOnly:
            return "B: 撮影者のみ"
        case .roleBased:
            return "C: 役割別支援"
        }
    }
}

struct ExperimentTrial: Codable {
    let trialId: String
    let sessionId: String
    let participantId: String
    let pairId: String
    let conditionId: String
    let referenceImageId: String?
    let referencePoseVersion: String?
    let selectedGuideType: String?
    let supportLevel: Int
    let isPractice: Bool
    let state: String
    let startTime: String?
    let endTime: String?
    let finalPhotoId: String?
    let abortReason: String?
}

struct ExperimentSession: Codable {
    let sessionId: String
    let participantId: String
    let pairId: String
    let conditionId: String
    let referenceImageId: String?
    let supportLevel: Int
    let status: String
    let currentTrialId: String?
    let currentTrial: ExperimentTrial?
}

struct ReferencePoseFile: Codable {
    let filename: String
    let url: String
}

struct ReferenceBoundingBox: Codable {
    var x: Double
    var y: Double
    var width: Double
    var height: Double
}

struct ReferenceKeypoint: Codable, Identifiable, Hashable {
    var name: String
    var x: Double
    var y: Double
    var confidence: Double
    var isEnabled: Bool

    var id: String { name }

    var displayName: String {
        let names: [String: String] = [
            "nose": "顔",
            "leftEye": "左目",
            "rightEye": "右目",
            "leftEar": "左耳",
            "rightEar": "右耳",
            "leftShoulder": "左肩",
            "rightShoulder": "右肩",
            "leftElbow": "左肘",
            "rightElbow": "右肘",
            "leftWrist": "左手首",
            "rightWrist": "右手首",
            "leftHip": "左腰",
            "rightHip": "右腰",
            "leftKnee": "左膝",
            "rightKnee": "右膝",
            "leftAnkle": "左足首",
            "rightAnkle": "右足首",
        ]
        return names[name] ?? name
    }
}

struct ReferencePose: Codable {
    let schemaVersion: String?
    let sessionId: String?
    let referenceImageId: String
    let versionId: String
    let parentVersionId: String?
    let source: String
    let personCount: Int
    let personCountApproved: Bool?
    let personCountApprovedBy: String?
    let personCountApprovedAt: String?
    var boundingBox: ReferenceBoundingBox
    var keypoints: [ReferenceKeypoint]
    let warnings: [String]
    let silhouetteAvailable: Bool
    let image: ReferencePoseFile
    let originalImage: ReferencePoseFile?
    let silhouette: ReferencePoseFile?
    let createdAt: String?
    let updatedAt: String?
    let correctedBy: String?
}

private struct ExperimentSessionResponse: Decodable {
    let success: Bool
    let experiment: ExperimentSession
}

private struct ExperimentTrialResponse: Decodable {
    let success: Bool
    let trial: ExperimentTrial
    let experiment: ExperimentSession?
}

private struct ReferencePoseResponse: Decodable {
    let success: Bool
    let pose: ReferencePose
}

enum ExperimentAPIError: LocalizedError {
    case invalidURL
    case invalidResponse
    case server(statusCode: Int, message: String)

    var errorDescription: String? {
        switch self {
        case .invalidURL:
            return "実験APIのURLが不正です。"
        case .invalidResponse:
            return "サーバーから不正な応答を受信しました。"
        case .server(let statusCode, let message):
            return "サーバーエラー（\(statusCode)）: \(message)"
        }
    }
}

@MainActor
final class ExperimentAPI {
    static let shared = ExperimentAPI()

    private var baseURL: URL { APIConfig.baseURL }

    func createSession(
        participantId: String,
        pairId: String,
        condition: ExperimentCondition,
        referenceImageId: String?,
        supportLevel: Int
    ) async throws -> ExperimentSession {
        let response: ExperimentSessionResponse = try await request(
            path: "api/experiments/sessions",
            method: "POST",
            body: [
                "participantId": participantId,
                "pairId": pairId,
                "conditionId": condition.rawValue,
                "referenceImageId": referenceImageId ?? "",
                "supportLevel": supportLevel,
            ]
        )
        return response.experiment
    }

    func fetchSession(sessionId: String) async throws -> ExperimentSession {
        let response: ExperimentSessionResponse = try await request(
            path: "api/experiments/sessions/\(sessionId)",
            method: "GET"
        )
        return response.experiment
    }

    func updateCondition(
        sessionId: String,
        condition: ExperimentCondition
    ) async throws -> ExperimentSession {
        let response: ExperimentSessionResponse = try await request(
            path: "api/experiments/sessions/\(sessionId)/condition",
            method: "PATCH",
            body: ["conditionId": condition.rawValue]
        )
        return response.experiment
    }

    func createTrial(
        sessionId: String,
        referenceImageId: String?,
        selectedGuideType: String?,
        supportLevel: Int,
        isPractice: Bool
    ) async throws -> (ExperimentTrial, ExperimentSession?) {
        let response: ExperimentTrialResponse = try await request(
            path: "api/experiments/sessions/\(sessionId)/trials",
            method: "POST",
            body: [
                "referenceImageId": referenceImageId ?? "",
                "selectedGuideType": selectedGuideType ?? "",
                "supportLevel": supportLevel,
                "isPractice": isPractice,
            ]
        )
        return (response.trial, response.experiment)
    }

    func startTrial(sessionId: String, trialId: String) async throws -> ExperimentTrial {
        let response: ExperimentTrialResponse = try await request(
            path: "api/experiments/trials/\(trialId)/start",
            method: "POST",
            body: [
                "sessionId": sessionId,
                "clientTimestamp": ISO8601DateFormatter().string(from: Date()),
            ]
        )
        return response.trial
    }

    func endTrial(
        sessionId: String,
        trialId: String,
        aborted: Bool,
        abortReason: String? = nil,
        finalPhotoId: String? = nil
    ) async throws -> ExperimentTrial {
        let response: ExperimentTrialResponse = try await request(
            path: "api/experiments/trials/\(trialId)/end",
            method: "POST",
            body: [
                "sessionId": sessionId,
                "state": aborted ? "aborted" : "completed",
                "abortReason": abortReason ?? "",
                "finalPhotoId": finalPhotoId ?? "",
                "clientTimestamp": ISO8601DateFormatter().string(from: Date()),
            ]
        )
        return response.trial
    }

    func extractReferencePose(
        sessionId: String,
        referenceImageId: String,
        image: UIImage
    ) async throws -> ReferencePose {
        guard let url = URL(
            string: "api/experiments/sessions/\(sessionId)/references/\(referenceImageId)/extract-pose",
            relativeTo: baseURL
        ), let imageData = image.jpegData(compressionQuality: 0.92) else {
            throw ExperimentAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue(
            "multipart/form-data; boundary=\(boundary)",
            forHTTPHeaderField: "Content-Type"
        )
        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"reference\"; filename=\"reference.jpg\"\r\n")
        body.append("Content-Type: image/jpeg\r\n\r\n")
        body.append(imageData)
        body.append("\r\n--\(boundary)--\r\n")
        request.httpBody = body

        let response: ReferencePoseResponse = try await execute(request)
        return absolutized(response.pose)
    }

    func fetchReferencePose(
        sessionId: String,
        referenceImageId: String
    ) async throws -> ReferencePose {
        let response: ReferencePoseResponse = try await request(
            path: "api/experiments/sessions/\(sessionId)/references/\(referenceImageId)/pose",
            method: "GET"
        )
        return absolutized(response.pose)
    }

    func fetchReferencePoseVersion(
        sessionId: String,
        referenceImageId: String,
        versionId: String
    ) async throws -> ReferencePose {
        let response: ReferencePoseResponse = try await request(
            path: "api/experiments/sessions/\(sessionId)/references/\(referenceImageId)/pose/versions/\(versionId)",
            method: "GET"
        )
        return absolutized(response.pose)
    }

    func saveReferencePose(
        sessionId: String,
        referenceImageId: String,
        pose: ReferencePose,
        correctedBy: String,
        approvePersonCount: Bool = false
    ) async throws -> ReferencePose {
        let keypoints = pose.keypoints.map { point in
            [
                "name": point.name,
                "x": point.x,
                "y": point.y,
                "confidence": point.confidence,
                "isEnabled": point.isEnabled,
            ] as [String: Any]
        }
        let response: ReferencePoseResponse = try await request(
            path: "api/experiments/sessions/\(sessionId)/references/\(referenceImageId)/pose",
            method: "PUT",
            body: [
                "source": "manual-corrected",
                "correctedBy": correctedBy,
                "personCountApproved": approvePersonCount,
                "boundingBox": [
                    "x": pose.boundingBox.x,
                    "y": pose.boundingBox.y,
                    "width": pose.boundingBox.width,
                    "height": pose.boundingBox.height,
                ],
                "keypoints": keypoints,
            ]
        )
        return absolutized(response.pose)
    }

    func logEvent(
        sessionId: String,
        trialId: String,
        eventType: String,
        role: String,
        payload: [String: Any] = [:]
    ) async {
        var pending = loadPendingEvents(sessionId: sessionId)
        pending.append([
            "eventId": UUID().uuidString,
            "trialId": trialId,
            "eventType": eventType,
            "role": role,
            "clientTimestamp": ISO8601DateFormatter().string(from: Date()),
            "payload": payload,
        ])
        savePendingEvents(pending, sessionId: sessionId)
        await flushPendingEvents(sessionId: sessionId)
    }

    func flushPendingEvents(sessionId: String) async {
        var pending = loadPendingEvents(sessionId: sessionId)
        guard let firstTrialId = pending.first?["trialId"] as? String else {
            return
        }
        let batch = Array(
            pending.filter { $0["trialId"] as? String == firstTrialId }.prefix(100)
        )
        guard !batch.isEmpty else { return }

        do {
            let _: EventResponse = try await request(
                path: "api/experiments/trials/\(firstTrialId)/events",
                method: "POST",
                body: [
                    "sessionId": sessionId,
                    "role": batch.first?["role"] as? String ?? "subject",
                    "events": batch.map { event in
                        var copy = event
                        copy.removeValue(forKey: "trialId")
                        return copy
                    },
                ]
            )
            let acceptedIds = Set(batch.compactMap { $0["eventId"] as? String })
            pending.removeAll { event in
                guard let eventId = event["eventId"] as? String else { return false }
                return acceptedIds.contains(eventId)
            }
            savePendingEvents(pending, sessionId: sessionId)
            if !pending.isEmpty {
                await flushPendingEvents(sessionId: sessionId)
            }
        } catch {
            print("実験ログ送信失敗: \(error)")
        }
    }

    private func loadPendingEvents(sessionId: String) -> [[String: Any]] {
        UserDefaults.standard.array(forKey: pendingEventsKey(sessionId)) as? [[String: Any]] ?? []
    }

    private func savePendingEvents(_ events: [[String: Any]], sessionId: String) {
        UserDefaults.standard.set(events, forKey: pendingEventsKey(sessionId))
    }

    private func pendingEventsKey(_ sessionId: String) -> String {
        "ExperimentPendingEvents.\(sessionId)"
    }

    private struct EventResponse: Decodable {
        let success: Bool
        let accepted: Int
    }

    private func request<Response: Decodable>(
        path: String,
        method: String,
        body: [String: Any]? = nil
    ) async throws -> Response {
        guard let url = URL(string: path, relativeTo: baseURL) else {
            throw ExperimentAPIError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }

        return try await execute(request)
    }

    private func execute<Response: Decodable>(_ request: URLRequest) async throws -> Response {
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ExperimentAPIError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let message = object?["error"] as? String ?? "request failed"
            throw ExperimentAPIError.server(
                statusCode: httpResponse.statusCode,
                message: message
            )
        }
        guard let decoded = try? JSONDecoder().decode(Response.self, from: data) else {
            throw ExperimentAPIError.invalidResponse
        }
        return decoded
    }

    private func absolutized(_ pose: ReferencePose) -> ReferencePose {
        func absoluteFile(_ file: ReferencePoseFile?) -> ReferencePoseFile? {
            guard let file else { return nil }
            guard URL(string: file.url)?.scheme == nil,
                  let absoluteURL = URL(string: file.url, relativeTo: baseURL)?.absoluteString else {
                return file
            }
            return ReferencePoseFile(filename: file.filename, url: absoluteURL)
        }

        return ReferencePose(
            schemaVersion: pose.schemaVersion,
            sessionId: pose.sessionId,
            referenceImageId: pose.referenceImageId,
            versionId: pose.versionId,
            parentVersionId: pose.parentVersionId,
            source: pose.source,
            personCount: pose.personCount,
            personCountApproved: pose.personCountApproved,
            personCountApprovedBy: pose.personCountApprovedBy,
            personCountApprovedAt: pose.personCountApprovedAt,
            boundingBox: pose.boundingBox,
            keypoints: pose.keypoints,
            warnings: pose.warnings,
            silhouetteAvailable: pose.silhouetteAvailable,
            image: absoluteFile(pose.image)!,
            originalImage: absoluteFile(pose.originalImage),
            silhouette: absoluteFile(pose.silhouette),
            createdAt: pose.createdAt,
            updatedAt: pose.updatedAt,
            correctedBy: pose.correctedBy
        )
    }
}

@MainActor
final class ExperimentState: ObservableObject {
    @Published var isEnabled = false
    @Published var sessionId = ""
    @Published var trialId = ""
    @Published var condition: ExperimentCondition = .noSupport
    @Published var trialState = "未設定"
    @Published var participantId = ""
    @Published var pairId = ""
    @Published var referenceImageId = ""
    @Published var supportLevel = 1
    @Published var isPractice = false

    init() {
        let defaults = UserDefaults.standard
        sessionId = defaults.string(forKey: "ExperimentSessionId") ?? ""
        trialId = defaults.string(forKey: "ExperimentTrialId") ?? ""
        participantId = defaults.string(forKey: "ExperimentParticipantId") ?? ""
        pairId = defaults.string(forKey: "ExperimentPairId") ?? ""
        referenceImageId = defaults.string(forKey: "ExperimentReferenceImageId") ?? ""
        trialState = defaults.string(forKey: "ExperimentTrialState") ?? "未設定"
        condition = ExperimentCondition(
            rawValue: defaults.string(forKey: "ExperimentConditionId") ?? ""
        ) ?? .noSupport
        supportLevel = max(1, defaults.integer(forKey: "ExperimentSupportLevel"))
        isPractice = defaults.bool(forKey: "ExperimentIsPractice")
        isEnabled = !sessionId.isEmpty
    }

    var hasSession: Bool { isEnabled && !sessionId.isEmpty }
    var hasTrial: Bool { hasSession && !trialId.isEmpty }
    var isRunning: Bool { hasTrial && trialState == "running" }

    func apply(session: ExperimentSession) {
        isEnabled = true
        sessionId = session.sessionId
        participantId = session.participantId
        pairId = session.pairId
        condition = ExperimentCondition(rawValue: session.conditionId) ?? .noSupport
        referenceImageId = session.referenceImageId ?? referenceImageId
        supportLevel = session.supportLevel
        trialId = session.currentTrial?.trialId ?? session.currentTrialId ?? ""
        trialState = session.currentTrial?.state ?? session.status
        persist()
    }

    func apply(trial: ExperimentTrial) {
        trialId = trial.trialId
        trialState = trial.state
        condition = ExperimentCondition(rawValue: trial.conditionId) ?? condition
        referenceImageId = trial.referenceImageId ?? referenceImageId
        supportLevel = trial.supportLevel
        isPractice = trial.isPractice
        persist()
    }

    func clear() {
        isEnabled = false
        sessionId = ""
        trialId = ""
        trialState = "未設定"
        persist()
    }

    func persist() {
        let defaults = UserDefaults.standard
        defaults.set(sessionId, forKey: "ExperimentSessionId")
        defaults.set(trialId, forKey: "ExperimentTrialId")
        defaults.set(participantId, forKey: "ExperimentParticipantId")
        defaults.set(pairId, forKey: "ExperimentPairId")
        defaults.set(referenceImageId, forKey: "ExperimentReferenceImageId")
        defaults.set(trialState, forKey: "ExperimentTrialState")
        defaults.set(condition.rawValue, forKey: "ExperimentConditionId")
        defaults.set(supportLevel, forKey: "ExperimentSupportLevel")
        defaults.set(isPractice, forKey: "ExperimentIsPractice")
    }
}

private extension Data {
    mutating func append(_ string: String) {
        guard let data = string.data(using: .utf8) else { return }
        append(data)
    }
}
