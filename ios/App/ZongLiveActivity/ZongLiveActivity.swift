import ActivityKit
import AppIntents
import SwiftUI
import WidgetKit

// Zong's design language: black surfaces, #1F1F1F controls, amber (#FFB020) accent for the metronome.
private let zongAccent  = Color(red: 1.0, green: 0.690, blue: 0.125)
private let zongSurface = Color(red: 0.122, green: 0.122, blue: 0.122)

struct ZongLiveActivity: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ZongActivityAttributes.self) { context in
            ZongControlBar(state: context.state)
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
        } dynamicIsland: { context in
            DynamicIsland {
                DynamicIslandExpandedRegion(.bottom) {
                    ZongControlBar(state: context.state)
                        .padding(.horizontal, 4)
                }
            } compactLeading: {
                Image(systemName: "metronome.fill").foregroundColor(zongAccent)
            } compactTrailing: {
                Text("\(context.state.bpm)")
                    .contentTransition(.identity)
                    .font(.system(size: 14, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundColor(zongAccent)
            } minimal: {
                Image(systemName: "metronome.fill").foregroundColor(zongAccent)
            }
        }
    }
}

/// Slim control bar: song title + tempo on the left, −  +  and start/stop on the right.
private struct ZongControlBar: View {
    let state: ZongActivityAttributes.ContentState

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 0) {
                Text(state.title)
                    .contentTransition(.identity)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundColor(.white.opacity(0.65))
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text("\(state.bpm)")
                        .contentTransition(.identity)
                        .font(.system(size: 32, weight: .bold, design: .rounded))
                        .monospacedDigit()
                        .foregroundColor(zongAccent)
                    Text("BPM")
                        .font(.system(size: 11, weight: .semibold))
                        .tracking(1)
                        .foregroundColor(.white.opacity(0.4))
                }
            }
            Spacer(minLength: 6)

            Button(intent: TempoDownIntent()) {
                ControlGlyph(symbol: "minus", fill: zongSurface, tint: .white)
            }
            .buttonStyle(.plain)

            Button(intent: TempoUpIntent()) {
                ControlGlyph(symbol: "plus", fill: zongSurface, tint: .white)
            }
            .buttonStyle(.plain)

            Button(intent: ToggleMetronomeIntent()) {
                ControlGlyph(symbol: state.playing ? "stop.fill" : "play.fill", fill: zongAccent, tint: .black)
            }
            .buttonStyle(.plain)
        }
        // Changes (tempo, start/stop) must appear instantly: no cross-fades or number rolls.
        .transaction { $0.animation = nil }
    }
}

private struct ControlGlyph: View {
    let symbol: String
    let fill: Color
    let tint: Color

    var body: some View {
        Image(systemName: symbol)
            .contentTransition(.identity)
            .font(.system(size: 15, weight: .bold))
            .foregroundColor(tint)
            .frame(width: 40, height: 40)
            .background(Circle().fill(fill))
    }
}
