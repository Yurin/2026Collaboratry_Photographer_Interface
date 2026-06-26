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
    let guides: [String: GuideFile]
}

struct GuideFile: Decodable {
    let filename: String
    let url: String
}

struct PhotosListResponse: Decodable {
    let success: Bool
    let files: [PhotoFile]
}

struct PhotoFile: Decodable {
    let filename: String
    let url: String
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
    ) async throws -> [GuideType: URL] {
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

        return urls
    }

    func uploadGuide(sessionId: String, image: UIImage) async throws -> URL? {
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
