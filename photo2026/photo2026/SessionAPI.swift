import UIKit

// MARK: - API Configuration
struct APIConfig {
    private static let apiBaseURLKey = AppEnvironment.apiBaseURLKey
    private static let webAppBaseURLKey = AppEnvironment.webAppBaseURLKey
    private static let wsBaseURLKey = AppEnvironment.wsBaseURLKey
    private static let legacyApiBaseURLKey = AppEnvironment.legacyApiBaseURLKey
    private static let legacyWsBaseURLKey = AppEnvironment.legacyWsBaseURLKey

    static var baseURL: URL {
        let configured = userConfiguredURL(for: apiBaseURLKey)
            ?? bundledURL(for: apiBaseURLKey)
            ?? userConfiguredURL(for: legacyApiBaseURLKey)
            ?? bundledURL(for: legacyApiBaseURLKey)
            ?? AppEnvironment.apiBaseURL
        return normalizedBaseURL(configured)
    }

    static var appBaseURL: URL {
        let configured = userConfiguredURL(for: webAppBaseURLKey)
            ?? bundledURL(for: webAppBaseURLKey)
        return normalizedBaseURL(configured ?? rootURL(from: baseURL))
    }

    static var wsBaseURL: URL {
        if let configured = userConfiguredURL(for: wsBaseURLKey)
            ?? bundledURL(for: wsBaseURLKey)
            ?? userConfiguredURL(for: legacyWsBaseURLKey)
            ?? bundledURL(for: legacyWsBaseURLKey) {
            return normalizedWebSocketURL(configured)
        }

        var components = URLComponents(url: rootURL(from: baseURL), resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/ws/video"
        return components.url!
    }

    static var sessionWsBaseURL: URL {
        guard var components = URLComponents(url: wsBaseURL, resolvingAgainstBaseURL: false) else {
            return wsBaseURL
        }
        components.path = "/ws/session"
        components.query = nil
        return components.url ?? wsBaseURL
    }

    private static func userConfiguredURL(for key: String) -> URL? {
        guard let value = UserDefaults.standard.string(forKey: key) else {
            return nil
        }
        return validURL(from: value)
    }

    private static func bundledURL(for key: String) -> URL? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: key) as? String else {
            return nil
        }
        return validURL(from: value)
    }

    private static func validURL(from value: String) -> URL? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              !trimmed.contains("$("),
              let url = URL(string: trimmed),
              let scheme = url.scheme,
              ["http", "https", "ws", "wss"].contains(scheme),
              url.host != nil else {
            return nil
        }
        return url
    }

    private static func rootURL(from url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }

        let pathComponents = components.path
            .split(separator: "/", omittingEmptySubsequences: true)
            .map(String.init)

        if pathComponents.first == "api" {
            components.path = "/"
        } else if components.path.isEmpty {
            components.path = "/"
        }

        return components.url ?? url
    }

    private static func normalizedWebSocketURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }

        if components.path == "/ws" || components.path == "/ws/" {
            components.path = "/ws/video"
        }

        return components.url ?? url
    }

    private static func normalizedBaseURL(_ url: URL) -> URL {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
            return url
        }
        components.path = components.path.isEmpty ? "/" : components.path
        return components.url ?? url
    }
}
struct SessionGuideResponse: Decodable {
    let success: Bool
    let sessionId: String?
    let guide: GuideFile?
}

struct SessionGuideSetResponse: Decodable {
    let success: Bool
    let sessionId: String?
    let referenceGuide: GuideReference?
    let guides: [String: GuideFile]
}

struct GuideFile: Decodable {
    let guideId: String?
    let filename: String
    let url: String
    let featuresUrl: String?
    let featuresAvailable: Bool?
}

struct GuideReference: Decodable {
    let guideId: String
    let featuresUrl: String
}

struct GeneratedGuideSet {
    let urls: [GuideType: URL]
    let guideId: String?
    let featuresUrl: String?
}

struct PhotosListResponse: Decodable {
    let success: Bool
    let files: [PhotoFile]
}

struct PhotoFile: Decodable {
    let filename: String
    let url: String
}

struct RoleGuidanceUpdate: Codable {
    let type: String?
    let analysisId: String?
    let sessionId: String?
    let trialId: String?
    let photoId: String?
    let clientId: String?
    let captureSequence: Int?
    let captureTimestamp: Int64?
    let analysisStartTimestamp: Int64?
    let analysisEndTimestamp: Int64?
    let guideId: String?
    let alignmentError: AlignmentError?
    let photographerGuidance: [GuidanceItem]
    let subjectGuidance: [GuidanceItem]
    let ready: ReadyState?

    private enum CodingKeys: String, CodingKey {
        case type
        case analysisId
        case sessionId
        case trialId
        case photoId
        case clientId
        case captureSequence
        case captureTimestamp
        case analysisStartTimestamp
        case analysisEndTimestamp
        case guideId
        case alignmentError
        case photographerGuidance
        case subjectGuidance
        case ready
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        type = try container.decodeIfPresent(String.self, forKey: .type)
        analysisId = try container.decodeIfPresent(String.self, forKey: .analysisId)
        sessionId = try container.decodeIfPresent(String.self, forKey: .sessionId)
        trialId = try container.decodeIfPresent(String.self, forKey: .trialId)
        photoId = try container.decodeIfPresent(String.self, forKey: .photoId)
        clientId = try container.decodeIfPresent(String.self, forKey: .clientId)
        captureSequence = try container.decodeIfPresent(Int.self, forKey: .captureSequence)
        captureTimestamp = try container.decodeIfPresent(Int64.self, forKey: .captureTimestamp)
        analysisStartTimestamp = try container.decodeIfPresent(Int64.self, forKey: .analysisStartTimestamp)
        analysisEndTimestamp = try container.decodeIfPresent(Int64.self, forKey: .analysisEndTimestamp)
        guideId = try container.decodeIfPresent(String.self, forKey: .guideId)
        alignmentError = try container.decodeIfPresent(AlignmentError.self, forKey: .alignmentError)
        photographerGuidance = try container.decodeIfPresent(
            [GuidanceItem].self,
            forKey: .photographerGuidance
        ) ?? []
        subjectGuidance = try container.decodeIfPresent(
            [GuidanceItem].self,
            forKey: .subjectGuidance
        ) ?? []
        ready = try container.decodeIfPresent(ReadyState.self, forKey: .ready)
    }
}

struct GuidanceItem: Codable, Identifiable {
    let id: UUID
    let type: String
    let message: String
    let severity: String?
    let value: Double?

    private enum CodingKeys: String, CodingKey {
        case type
        case message
        case severity
        case value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = UUID()
        type = try container.decode(String.self, forKey: .type)
        message = try container.decode(String.self, forKey: .message)
        severity = try container.decodeIfPresent(String.self, forKey: .severity)
        value = try container.decodeIfPresent(Double.self, forKey: .value)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(type, forKey: .type)
        try container.encode(message, forKey: .message)
        try container.encodeIfPresent(severity, forKey: .severity)
        try container.encodeIfPresent(value, forKey: .value)
    }
}

struct AlignmentError: Codable {
    let centerError: Double?
    let scaleError: Double?
    let poseError: Double?
    let upperBodyError: Double?
    let faceError: Double?
    let silhouetteError: Double?
    let totalError: Double?
}

struct ReadyState: Codable {
    let framingReady: Bool?
    let poseReady: Bool?
    let captureReady: Bool?
}

enum SessionAPIError: Error {
    case invalidURL
    case requestFailed(statusCode: Int)
    case invalidResponse
}

final class SessionAPI {
    static let shared = SessionAPI()
    private let baseURL = APIConfig.baseURL

    func generateGuide(
        sessionId: String,
        referenceImage: UIImage,
        guideType: GuideType,
        cropRect: CropRect? = nil
    ) async throws -> URL? {
        guard let url = URL(string: "api/session/\(sessionId)/generate-guide", relativeTo: baseURL) else {
            throw SessionAPIError.invalidURL
        }
        guard let imageData = referenceImage.jpegData(compressionQuality: 0.9) else {
            throw SessionAPIError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"guideType\"\r\n\r\n")
        body.append(guideType.rawValue)
        body.append("\r\n")
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"aspectRatio\"\r\n\r\n")
        body.append("3:4")
        body.append("\r\n")

        // Add crop parameters if provided
        if let cropRect = cropRect {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropX\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.x))
            body.append("\r\n")
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropY\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.y))
            body.append("\r\n")
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropWidth\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.width))
            body.append("\r\n")
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropHeight\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.height))
            body.append("\r\n")
        }

        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"reference\"; filename=\"reference.jpg\"\r\n")
        body.append("Content-Type: image/jpeg\r\n\r\n")
        body.append(imageData)
        body.append("\r\n")
        body.append("--\(boundary)--\r\n")

        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SessionAPIError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw SessionAPIError.requestFailed(statusCode: httpResponse.statusCode)
        }

        let decoded = try JSONDecoder().decode(SessionGuideResponse.self, from: data)
        if let guideUrl = decoded.guide?.url {
            return URL(string: guideUrl, relativeTo: baseURL)
        }
        return nil
    }

    func generateGuideSet(
        sessionId: String,
        referenceImage: UIImage,
        cropRect: CropRect? = nil
    ) async throws -> GeneratedGuideSet {
        guard let url = URL(string: "api/session/\(sessionId)/generate-guide-set", relativeTo: baseURL) else {
            throw SessionAPIError.invalidURL
        }
        guard let imageData = referenceImage.jpegData(compressionQuality: 0.9) else {
            throw SessionAPIError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"aspectRatio\"\r\n\r\n")
        body.append("3:4")
        body.append("\r\n")

        if let cropRect = cropRect {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropX\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.x))
            body.append("\r\n")
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropY\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.y))
            body.append("\r\n")
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropWidth\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.width))
            body.append("\r\n")
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"cropHeight\"\r\n\r\n")
            body.append(String(format: "%.6f", cropRect.height))
            body.append("\r\n")
        }

        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"reference\"; filename=\"reference.jpg\"\r\n")
        body.append("Content-Type: image/jpeg\r\n\r\n")
        body.append(imageData)
        body.append("\r\n")
        body.append("--\(boundary)--\r\n")

        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SessionAPIError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw SessionAPIError.requestFailed(statusCode: httpResponse.statusCode)
        }

        let decoded = try JSONDecoder().decode(SessionGuideSetResponse.self, from: data)
        var urls: [GuideType: URL] = [:]

        for (rawType, file) in decoded.guides {
            guard let guideType = GuideType(rawValue: rawType),
                  let guideURL = URL(string: file.url, relativeTo: baseURL) else {
                continue
            }
            urls[guideType] = guideURL
        }

        let representativeFile = decoded.guides.values.first
        return GeneratedGuideSet(
            urls: urls,
            guideId: decoded.referenceGuide?.guideId ?? representativeFile?.guideId,
            featuresUrl: decoded.referenceGuide?.featuresUrl ?? representativeFile?.featuresUrl
        )
    }

    func uploadGuide(
        sessionId: String,
        image: UIImage,
        guideId: String? = nil,
        featuresUrl: String? = nil
    ) async throws -> URL? {
        guard let url = URL(string: "api/session/\(sessionId)/guide", relativeTo: baseURL) else {
            throw SessionAPIError.invalidURL
        }
        guard let imageData = image.pngData() else {
            throw SessionAPIError.invalidResponse
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"

        let boundary = "Boundary-\(UUID().uuidString)"
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")

        var body = Data()
        if let guideId, !guideId.isEmpty {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"guideId\"\r\n\r\n")
            body.append(guideId)
            body.append("\r\n")
        }
        if let featuresUrl, !featuresUrl.isEmpty {
            body.append("--\(boundary)\r\n")
            body.append("Content-Disposition: form-data; name=\"featuresUrl\"\r\n\r\n")
            body.append(featuresUrl)
            body.append("\r\n")
        }
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"guide\"; filename=\"guide.png\"\r\n")
        body.append("Content-Type: image/png\r\n\r\n")
        body.append(imageData)
        body.append("\r\n")
        body.append("--\(boundary)--\r\n")

        request.httpBody = body

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SessionAPIError.invalidResponse
        }
        guard (200...299).contains(httpResponse.statusCode) else {
            throw SessionAPIError.requestFailed(statusCode: httpResponse.statusCode)
        }

        let decoded = try JSONDecoder().decode(SessionGuideResponse.self, from: data)
        if let guideUrl = decoded.guide?.url {
            return URL(string: guideUrl, relativeTo: baseURL)
        }
        return nil
    }

    func fetchGuide(sessionId: String) async throws -> URL? {
        guard let url = URL(string: "api/session/\(sessionId)/guide", relativeTo: baseURL) else {
            throw SessionAPIError.invalidURL
        }

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw SessionAPIError.requestFailed(statusCode: (response as? HTTPURLResponse)?.statusCode ?? -1)
        }

        let decoded = try JSONDecoder().decode(SessionGuideResponse.self, from: data)
        if let guideUrl = decoded.guide?.url {
            return URL(string: guideUrl, relativeTo: baseURL)
        }
        return nil
    }

    func fetchPhotos(sessionId: String) async throws -> [PhotoFile] {
        guard let url = URL(string: "api/photos?sessionId=\(sessionId)", relativeTo: baseURL) else {
            throw SessionAPIError.invalidURL
        }

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw SessionAPIError.requestFailed(statusCode: (response as? HTTPURLResponse)?.statusCode ?? -1)
        }

        let decoded = try JSONDecoder().decode(PhotosListResponse.self, from: data)
        return decoded.files.map { file in
            guard URL(string: file.url)?.scheme == nil,
                  let absoluteURL = URL(string: file.url, relativeTo: baseURL)?.absoluteString else {
                return file
            }

            return PhotoFile(filename: file.filename, url: absoluteURL)
        }
    }
}

private extension Data {
    mutating func append(_ string: String) {
        if let data = string.data(using: .utf8) {
            append(data)
        }
    }
}
