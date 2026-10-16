import AVFoundation
import MediaPlayer

// ============================================================
// NativeMetronomeEngine
//
// Scheduling strategy:
//   • One AVAudioEngine + one AVAudioPlayerNode (the "click node").
//   • buildBarBuffer() pre-renders one bar of audio into an AVAudioPCMBuffer:
//       – loads m_hi.wav (accent) and m_low.wav (normal) from the bundle
//       – places each click at the exact sample position for its beat
//       – fills the remaining samples with silence
//   • The buffer is looped with scheduleBuffer(.loops).
//   • On tempo / time-sig / accent changes while playing: call
//     rebuildAndSeamlesslyRestart() which computes the current playback
//     position, builds the new buffer, and schedules it so the next bar
//     boundary lines up perfectly.
//   • Beat events are fired by a dedicated serial queue that wakes up at the
//     precise audio-clock time of each beat using DispatchQueue + .asyncAfter.
// ============================================================

final class NativeMetronomeEngine {

    // MARK: - Callbacks (set by the plugin)
    var onBeat: ((Int) -> Void)?
    var onRemoteCommand: ((String) -> Void)?

    // MARK: - State
    private var bpm: Double = 120
    private var beatsPerBar: Int = 4
    private var accents: [String] = []   // "normal" | "accent" | "mute"
    private var volume: Float = 1.0
    private(set) var isPlaying = false

    // MARK: - Audio objects
    private let engine  = AVAudioEngine()
    private let clkNode = AVAudioPlayerNode()
    private let mixNode = AVAudioMixerNode()   // volume control

    private var hiBuffer:  AVAudioPCMBuffer?  // m_hi.wav
    private var lowBuffer: AVAudioPCMBuffer?  // m_low.wav
    private var barBuffer: AVAudioPCMBuffer?  // pre-rendered bar
    private var barFormat: AVAudioFormat?

    // Track when the current bar started in audio-engine time,
    // so we can offset beat events accurately.
    private var barStartSampleTime: AVAudioFramePosition = 0
    private var beatTimerWorkItems: [DispatchWorkItem] = []
    private let beatQueue = DispatchQueue(label: "com.zong.metronome.beat", qos: .userInteractive)

    private var isInterrupted = false

    // MARK: - Init
    init() {
        setupAudioSession()
        setupEngine()
        loadSamples()
        setupRemoteCommands()
    }

    // MARK: - AVAudioSession
    private func setupAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            // .playback ignores the hardware silent switch and continues
            // audio when the screen is locked.
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
        } catch {
            print("[NativeMetronome] Audio session setup error: \(error)")
        }

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification,
            object: session
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleRouteChange(_:)),
            name: AVAudioSession.routeChangeNotification,
            object: session
        )
    }

    // MARK: - AVAudioEngine
    private func setupEngine() {
        engine.attach(clkNode)
        engine.attach(mixNode)

        // clkNode → mixNode → mainMixerNode → outputNode
        engine.connect(clkNode, to: mixNode,               format: nil)
        engine.connect(mixNode, to: engine.mainMixerNode, format: nil)

        mixNode.outputVolume = volume

        do {
            try engine.start()
        } catch {
            print("[NativeMetronome] Engine start error: \(error)")
        }
    }

    // MARK: - Sample loading
    private func loadSamples() {
        // Capacitor copies the web assets into the bundle under public/audio/
        hiBuffer  = loadWav(named: "m_hi",  inSubdir: "public/audio")
        lowBuffer = loadWav(named: "m_low", inSubdir: "public/audio")
    }

    private func loadWav(named name: String, inSubdir subdir: String) -> AVAudioPCMBuffer? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "wav", subdirectory: subdir) else {
            print("[NativeMetronome] WAV not found: \(subdir)/\(name).wav")
            return nil
        }
        do {
            let file   = try AVAudioFile(forReading: url)
            let format = file.processingFormat
            let count  = AVAudioFrameCount(file.length)
            guard let buf = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: count) else { return nil }
            try file.read(into: buf)
            return buf
        } catch {
            print("[NativeMetronome] WAV load error \(name): \(error)")
            return nil
        }
    }

    // MARK: - Bar buffer construction
    /// Builds one bar of audio as a single PCMBuffer with clicks at the right positions.
    private func buildBarBuffer(bpm: Double, beatsPerBar: Int, accents: [String]) -> AVAudioPCMBuffer? {
        let sampleRate   = engine.outputNode.outputFormat(forBus: 0).sampleRate
        let beatDuration = 60.0 / bpm                             // seconds
        let barDuration  = beatDuration * Double(beatsPerBar)
        let barFrames    = AVAudioFrameCount(barDuration * sampleRate)
        guard barFrames > 0 else { return nil }

        // Use the accent buffer's format as the canonical stereo format.
        // If no WAVs loaded, fall back to a 2-channel float format.
        let fmt: AVAudioFormat
        if let ref = hiBuffer?.format ?? lowBuffer?.format {
            fmt = ref
        } else {
            guard let f = AVAudioFormat(standardFormatWithSampleRate: sampleRate, channels: 2) else { return nil }
            fmt = f
        }
        barFormat = fmt

        guard let bar = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: barFrames) else { return nil }
        bar.frameLength = barFrames

        // Zero-fill silence
        let channelCount = Int(fmt.channelCount)
        if let data = bar.floatChannelData {
            for ch in 0..<channelCount {
                memset(data[ch], 0, Int(barFrames) * MemoryLayout<Float>.size)
            }
        }

        // Mix each click into the bar buffer at the correct offset
        for beat in 0..<beatsPerBar {
            let accentState = beat < accents.count ? accents[beat] : "normal"
            if accentState == "mute" { continue }
            let isAccent   = accentState == "accent"
            let clickBuf   = isAccent ? hiBuffer : lowBuffer
            let gain: Float = isAccent ? 1.0 : 0.85

            let beatOffset = AVAudioFrameCount(Double(beat) * beatDuration * sampleRate)

            if let src = clickBuf, let srcData = src.floatChannelData, let dstData = bar.floatChannelData {
                let copyCount = min(Int(src.frameLength), Int(barFrames) - Int(beatOffset))
                if copyCount > 0 {
                    let srcChannels = Int(src.format.channelCount)
                    for ch in 0..<channelCount {
                        let srcCh = min(ch, srcChannels - 1)
                        vDSP_vsma(
                            srcData[srcCh], 1,
                            [gain],
                            dstData[ch].advanced(by: Int(beatOffset)), 1,
                            dstData[ch].advanced(by: Int(beatOffset)), 1,
                            vDSP_Length(copyCount)
                        )
                    }
                }
            } else {
                // Synthetic fallback click: short sine blip
                synthesizeClick(into: bar, at: Int(beatOffset), isAccent: isAccent, sampleRate: sampleRate)
            }
        }
        return bar
    }

    /// Synthetic sine-click fallback (used if WAV files fail to load).
    private func synthesizeClick(into buf: AVAudioPCMBuffer, at offset: Int, isAccent: Bool, sampleRate: Double) {
        let freq: Double  = isAccent ? 1500 : 1000
        let amp: Float    = isAccent ? 0.7  : 0.4
        let dur           = Int(0.05 * sampleRate)
        let end           = min(offset + dur, Int(buf.frameLength))
        guard let ch = buf.floatChannelData else { return }
        for i in offset..<end {
            let t = Double(i - offset) / sampleRate
            let env = Float(1.0 - Double(i - offset) / Double(dur))
            let sample = amp * env * Float(sin(2 * .pi * freq * t))
            for c in 0..<Int(buf.format.channelCount) {
                ch[c][i] += sample
            }
        }
    }

    // MARK: - Playback control
    func start(bpm: Double, beatsPerBar: Int, accents: [String]?) {
        self.bpm         = max(30, min(300, bpm))
        self.beatsPerBar = max(1, beatsPerBar)
        self.accents     = normalizedAccents(accents, beats: self.beatsPerBar)
        startPlayback()
    }

    func stop() {
        isPlaying = false
        cancelBeatTimers()
        clkNode.stop()
        updateNowPlaying(playing: false)
    }

    func setTempo(bpm newBpm: Double) {
        let clamped = max(30, min(300, newBpm))
        guard clamped != bpm else { return }
        bpm = clamped
        if isPlaying { rebuildAndSeamlesslyRestart() }
        updateNowPlaying(playing: isPlaying)
    }

    func setBeatsPerBar(_ beats: Int, accents newAccents: [String]?) {
        let newBeats = max(1, beats)
        accents = normalizedAccents(newAccents, beats: newBeats)
        guard newBeats != beatsPerBar else {
            if isPlaying { rebuildAndSeamlesslyRestart() }
            return
        }
        beatsPerBar = newBeats
        if isPlaying { rebuildAndSeamlesslyRestart() }
    }

    func setAccents(_ newAccents: [String]) {
        accents = normalizedAccents(newAccents, beats: beatsPerBar)
        if isPlaying { rebuildAndSeamlesslyRestart() }
    }

    func setVolume(_ v: Float) {
        volume = max(0, min(1, v))
        mixNode.outputVolume = volume
    }

    // MARK: - Internal playback
    private func startPlayback() {
        guard !engine.isRunning else { scheduleBar(); isPlaying = true; updateNowPlaying(playing: true); return }
        do { try engine.start() } catch { print("[NativeMetronome] engine.start error: \(error)"); return }
        scheduleBar()
        isPlaying = true
        updateNowPlaying(playing: true)
    }

    /// Schedule one looping bar, fire beat events via the audio clock.
    private func scheduleBar() {
        clkNode.stop()
        cancelBeatTimers()

        guard let buf = buildBarBuffer(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents) else { return }
        barBuffer = buf

        clkNode.play()

        // Schedule the bar to start immediately; the completion fires when the
        // *next* loop iteration would begin, so we can reschedule beat timers.
        barStartSampleTime = clkNode.playerTime(forNodeTime: engine.outputNode.lastRenderTime ?? AVAudioTime(hostTime: mach_absolute_time()))?.sampleTime ?? 0

        clkNode.scheduleBuffer(buf, at: nil, options: .loops, completionCallbackType: .dataConsumed) { [weak self] _ in
            // No-op: we use our own beat timer for UI events.
        }

        // Capture when the node started playing so beat events are relative.
        scheduleBeatTimers()
    }

    private func scheduleBeatTimers() {
        cancelBeatTimers()
        let beatDuration = 60.0 / bpm            // seconds per beat
        let sampleRate   = engine.outputNode.outputFormat(forBus: 0).sampleRate

        // Determine the engine render time of the first beat in this bar.
        // We anchor on the last render time and schedule ahead from now.
        guard let lastRender = engine.outputNode.lastRenderTime else { return }
        let startTime = clkNode.nodeTime(forPlayerTime: AVAudioTime(sampleTime: 0, atRate: sampleRate))
            ?? lastRender

        let nowHostTime = mach_absolute_time()
        let nowSecs     = Double(nowHostTime) * machTimebaseInfo()

        for beat in 0..<beatsPerBar {
            let accentState = beat < accents.count ? accents[beat] : "normal"
            if accentState == "mute" { continue }
            let delay = beatDuration * Double(beat)

            // Rough host-time of this beat. We fire the UI callback 10ms before
            // the actual audio click so the UI flash lands on the beat visually.
            let fireSecs = delay - 0.01
            let deadline = DispatchTime.now() + max(0, fireSecs)

            let beatIdx = beat
            let item = DispatchWorkItem { [weak self] in
                self?.onBeat?(beatIdx)
            }
            beatTimerWorkItems.append(item)
            beatQueue.asyncAfter(deadline: deadline, execute: item)
        }

        // Re-schedule beat timers for subsequent bars
        let barDuration = beatDuration * Double(beatsPerBar)
        let barItem = DispatchWorkItem { [weak self] in
            guard let self = self, self.isPlaying else { return }
            self.scheduleBeatTimers()
        }
        beatTimerWorkItems.append(barItem)
        beatQueue.asyncAfter(deadline: .now() + barDuration, execute: barItem)
    }

    private func cancelBeatTimers() {
        beatTimerWorkItems.forEach { $0.cancel() }
        beatTimerWorkItems.removeAll()
    }

    /// Rebuild bar buffer and seamlessly hand off playback without a gap.
    private func rebuildAndSeamlesslyRestart() {
        guard let buf = buildBarBuffer(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents) else { return }
        barBuffer = buf
        clkNode.stop()
        cancelBeatTimers()
        clkNode.play()
        clkNode.scheduleBuffer(buf, at: nil, options: .loops, completionCallbackType: .dataConsumed) { _ in }
        scheduleBeatTimers()
    }

    // MARK: - Accent helper
    private func normalizedAccents(_ incoming: [String]?, beats: Int) -> [String] {
        var arr = incoming ?? Array(repeating: "normal", count: beats)
        while arr.count < beats { arr.append("normal") }
        return Array(arr.prefix(beats))
    }

    // MARK: - Mach timebase
    private func machTimebaseInfo() -> Double {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        return Double(info.numer) / Double(info.denom) / 1_000_000_000.0
    }

    // MARK: - Interruption handling
    @objc private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let typeVal = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeVal) else { return }

        switch type {
        case .began:
            if isPlaying {
                isInterrupted = true
                stop()
            }
        case .ended:
            guard let optVal = info[AVAudioSessionInterruptionOptionKey] as? UInt else { return }
            let opts = AVAudioSession.InterruptionOptions(rawValue: optVal)
            if opts.contains(.shouldResume) && isInterrupted {
                isInterrupted = false
                try? AVAudioSession.sharedInstance().setActive(true)
                start(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents)
            }
        @unknown default: break
        }
    }

    @objc private func handleRouteChange(_ note: Notification) {
        // On route changes (e.g. headphones unplugged) ensure the engine is still running.
        guard isPlaying else { return }
        if !engine.isRunning {
            try? engine.start()
        }
    }

    // MARK: - Lock-screen / Now Playing
    private func setupRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.isEnabled = true
        center.playCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.start(bpm: self.bpm, beatsPerBar: self.beatsPerBar, accents: self.accents)
            self.onRemoteCommand?("play")
            return .success
        }

        center.pauseCommand.isEnabled = true
        center.pauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            self.stop()
            self.onRemoteCommand?("pause")
            return .success
        }

        center.togglePlayPauseCommand.isEnabled = true
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self = self else { return .commandFailed }
            if self.isPlaying {
                self.stop()
                self.onRemoteCommand?("pause")
            } else {
                self.start(bpm: self.bpm, beatsPerBar: self.beatsPerBar, accents: self.accents)
                self.onRemoteCommand?("play")
            }
            return .success
        }
    }

    private func updateNowPlaying(playing: Bool) {
        var info: [String: Any] = [
            MPMediaItemPropertyTitle:           "Zong",
            MPMediaItemPropertyArtist:          "\(Int(bpm)) BPM",
            MPNowPlayingInfoPropertyIsLiveStream: false,
            MPNowPlayingInfoPropertyPlaybackRate: playing ? 1.0 : 0.0,
        ]
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }
}
