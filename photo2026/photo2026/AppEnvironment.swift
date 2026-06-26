import Foundation

enum AppEnvironment {
    static let apiBaseURLString = "https://photo-interface.com"
    static let webAppBaseURLString = "https://photo-interface.com"
    static let wsBaseURLString = "wss://photo-interface.com/ws/video"

    static var apiBaseURL: URL {
        URL(string: apiBaseURLString)!
    }

    static var webAppBaseURL: URL {
        URL(string: webAppBaseURLString)!
    }

    static var wsBaseURL: URL {
        URL(string: wsBaseURLString)!
    }

    static let apiBaseURLKey = "API_BASE_URL"
    static let webAppBaseURLKey = "WEB_APP_BASE_URL"
    static let wsBaseURLKey = "WS_BASE_URL"
    static let legacyApiBaseURLKey = "ServerBaseURL"
    static let legacyWsBaseURLKey = "WebSocketBaseURL"
}
