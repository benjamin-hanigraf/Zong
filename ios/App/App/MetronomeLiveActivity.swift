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
    // All ActivityKit work happens here, never on the audio queue or the main thread.
    private let queue = DispatchQueue(label: "com.zong.metronome.liveactivity", qos: .utility)

    func sync(title: String, bpm: Int, playing: Bool) {
        queue.async { [self] in perform(title: title, bpm: bpm, playing: playing) }
    }

    // Updates are sent one at a time and always converge on the newest state, so quick
    // button presses can never leave the lock screen showing an older state.
    private var desired: ZongActivityAttributes.ContentState?
    private var sent: ZongActivityAttributes.ContentState?
    private var inFlight = false

    private func perform(title: String, bpm: Int, playing: Bool) {
        guard ActivityAuthorizationInfo().areActivitiesEnabled else { return }
        let state = ZongActivityAttributes.ContentState(title: title, bpm: bpm, playing: playing)
        desired = state

        endWork?.cancel()
        if activity == nil { activity = Activity<ZongActivityAttributes>.activities.first }
        if activity == nil, playing {
            do {
                activity = try Activity.request(attributes: ZongActivityAttributes(),
                                                content: ActivityContent(state: state, staleDate: nil),
                                                pushType: nil)
                sent = state
            } catch {
                print("[NativeMetronome] Live Activity request failed: \(error)")
            }
        }
        pushLatest()

        // Remove the lock-screen control a while after the metronome stops.
        if !playing, activity != nil {
            let work = DispatchWorkItem { [weak self] in self?.end() }
            endWork = work
            queue.asyncAfter(deadline: .now() + 600, execute: work)
        }
    }

    private func pushLatest() {
        guard !inFlight, let activity = activity, let state = desired, state != sent else { return }
        inFlight = true
        Task {
            await activity.update(ActivityContent(state: state, staleDate: nil))
            queue.async { [self] in
                sent = state
                inFlight = false
                pushLatest()
            }
        }
    }

    func end() {
        queue.async { [self] in
            let current = activity
            activity = nil
            sent = nil
            desired = nil
            Task { await current?.end(nil, dismissalPolicy: .immediate) }
        }
    }

    /// Clears an activity left over from a previous run of the app.
    func endStale() {
        queue.async {
            for old in Activity<ZongActivityAttributes>.activities {
                Task { await old.end(nil, dismissalPolicy: .immediate) }
            }
        }
    }
}
#endif
