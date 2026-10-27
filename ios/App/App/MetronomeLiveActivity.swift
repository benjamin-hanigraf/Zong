import Foundation
#if canImport(ActivityKit)
import ActivityKit

/// Starts / updates / ends the lock-screen Live Activity that mirrors the metronome.
/// (App target only. Must be started while the app is in the foreground — which is
/// always the case when the user taps play in the app.)
@available(iOS 16.2, *)
final class MetronomeLiveActivity {
    static let shared = MetronomeLiveActivity()

    private var activity: Activity<ZongActivityAttributes>?
    private var endWork: DispatchWorkItem?

    func sync(title: String, bpm: Int, playing: Bool) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = ZongActivityAttributes.ContentState(title: title, bpm: bpm, playing: playing)
        let content = ActivityContent(state: state, staleDate: nil)

        endWork?.cancel()
        if let existing = activity ?? Activity<ZongActivityAttributes>.activities.first {
            activity = existing
            Task { await existing.update(content) }
        } else if playing {
            do {
                activity = try Activity.request(attributes: ZongActivityAttributes(), content: content, pushType: nil)
            } catch {
                print("[NativeMetronome] Live Activity request failed: \(error)")
            }
        }

        // Remove the lock-screen control a while after the metronome stops.
        if !playing, activity != nil {
            let work = DispatchWorkItem { [weak self] in self?.end() }
            endWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 600, execute: work)
        }
    }

    func end() {
        let current = activity
        activity = nil
        Task { await current?.end(nil, dismissalPolicy: .immediate) }
    }

    /// Clears an activity left over from a previous run of the app.
    func endStale() {
        for old in Activity<ZongActivityAttributes>.activities {
            Task { await old.end(nil, dismissalPolicy: .immediate) }
        }
    }
}
#endif
