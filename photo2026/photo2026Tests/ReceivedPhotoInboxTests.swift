import Foundation
import Testing
@testable import photo2026

struct ReceivedPhotoInboxTests {
    @Test func removalsPersistAndKeepNewPhotosAndOtherSessions() {
        let suite = "ReceivedPhotoInboxTests-" + UUID().uuidString
        let defaults = UserDefaults(suiteName: suite)!
        defer { defaults.removePersistentDomain(forName: suite) }
        let first = PhotoFile(filename: "1.jpg", url: "https://example.com/1.jpg")
        let second = PhotoFile(filename: "2.jpg", url: "https://example.com/2.jpg")
        ReceivedPhotoInbox.remove([first], sessionId: "a", defaults: defaults)
        ReceivedPhotoInbox.remove([first], sessionId: "a", defaults: defaults)
        let reopened = UserDefaults(suiteName: suite)!
        #expect(ReceivedPhotoInbox.visible([first, second], sessionId: "a", defaults: reopened).map(\.filename) == ["2.jpg"])
        #expect(ReceivedPhotoInbox.visible([first, second], sessionId: "b", defaults: reopened).count == 2)
        ReceivedPhotoInbox.remove([second], sessionId: "a", defaults: reopened)
        #expect(ReceivedPhotoInbox.visible([first, second], sessionId: "a", defaults: defaults).isEmpty)
    }
}
