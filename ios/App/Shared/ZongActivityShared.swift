import Foundation
#if canImport(ActivityKit)
import ActivityKit
#endif
#if canImport(AppIntents)
import AppIntents
#endif

// Compiled into BOTH the app and the Live Activity extension.

/// Commands the lock-screen buttons send to the metronome engine.
enum MetronomeCommand {
    case toggle, tempoUp, tempoDown
}

/// Live Activity buttons run inside the *app* process; the app registers its handler
/// at launch (AppDelegate). In the extension this stays nil and is never called.
final class MetronomeIntentBridge {
    static var handler: ((MetronomeCommand) -> Void)?
}

#if canImport(ActivityKit)
@available(iOS 16.2, *)
struct ZongActivityAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var title: String
        var bpm: Int
        var playing: Bool
    }
}
#endif

#if canImport(AppIntents)
@available(iOS 17.0, *)
struct ToggleMetronomeIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Start or stop the metronome"
    func perform() async throws -> some IntentResult {
        MetronomeIntentBridge.handler?(.toggle)
        return .result()
    }
}

@available(iOS 17.0, *)
struct TempoUpIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Increase tempo"
    func perform() async throws -> some IntentResult {
        MetronomeIntentBridge.handler?(.tempoUp)
        return .result()
    }
}

@available(iOS 17.0, *)
struct TempoDownIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Decrease tempo"
    func perform() async throws -> some IntentResult {
        MetronomeIntentBridge.handler?(.tempoDown)
        return .result()
    }
}
#endif
