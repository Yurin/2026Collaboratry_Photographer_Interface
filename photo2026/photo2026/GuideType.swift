import Foundation

enum GuideType: String, CaseIterable, Identifiable, Codable {
    case rectangle = "rectangle"
    case keypoints = "keypoints"
    case silhouette = "silhouette"

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .rectangle:
            return "人物枠"
        case .keypoints:
            return "人物枠 + 主要ポイント"
        case .silhouette:
            return "シルエット"
        }
    }
}