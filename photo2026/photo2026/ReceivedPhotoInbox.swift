import Foundation

/// Tracks removals from this device's inbox without deleting shared research records.
enum ReceivedPhotoInbox {
    private static func key(for sessionId: String) -> String {
        "ReceivedPhotoInbox.removed:\(sessionId)"
    }

    static func visible(_ photos: [PhotoFile], sessionId: String, defaults: UserDefaults = .standard) -> [PhotoFile] {
        let removed = Set(defaults.stringArray(forKey: key(for: sessionId)) ?? [])
        return photos.filter { !removed.contains($0.url) }
    }

    static func remove(_ photos: [PhotoFile], sessionId: String, defaults: UserDefaults = .standard) {
        let storageKey = key(for: sessionId)
        var removed = Set(defaults.stringArray(forKey: storageKey) ?? [])
        removed.formUnion(photos.map(\.url))
        defaults.set(removed.sorted(), forKey: storageKey)
    }
}
