import Accelerate
import AVFoundation

// ============================================================
// NativeMetronomeEngine
//
// Design:
//   • One AVAudioEngine + one AVAudioPlayerNode (the "click node").
//   • One bar of audio (clicks at their exact sample positions, including
//     subdivisions) is pre-rendered into a buffer and looped by the player
//     node, so timing is sample-accurate and never depends on timers.
//   • Beat flashes are derived from the audio clock itself (a lightweight
//     ticker reads the player's sample position), so they can never drift
//     away from the sound.
//   • ALL mutable state is touched on one serial queue (`q`). Public methods
//     can be called from any thread; blocking work (activating the audio
//     session) never runs on the main thread.
//   • The native side is the source of truth for "playing": every change
//     (start, stop, audio interruption, lock-screen button) is published via
//     `onState`, and JS mirrors it. Nothing can stop the sound without the UI
//     finding out.
//   • The lock-screen Live Activity (MetronomeLiveActivity.swift) mirrors the state and
//     its +/−/play buttons call handle(_:).
//   • The engine recovers by itself from audio route / configuration changes
//     and category changes made by the web view.
// ============================================================

final class NativeMetronomeEngine {

    /// One engine for the whole app: the plugin (JS) and the Live Activity buttons share it.
    static let shared = NativeMetronomeEngine()

    // MARK: - Callbacks (set by the plugin)
    var onBeat: ((Int) -> Void)?
    var onState: ((Bool) -> Void)?
    var onTempo: ((Int) -> Void)?   // tempo changed by a lock-screen button

    // MARK: - State (only touched on `q`)
    private let q = DispatchQueue(label: "com.zong.metronome.audio", qos: .userInteractive)
    private var bpm: Double = 120
    private var beatsPerBar: Int = 4
    private var subdivision: Int = 1
    private var accents: [String] = []   // "normal" | "accent" | "mute"
    private var title = "Metronome"     // shown on the lock-screen Live Activity
    private var volume: Float = 1.0
    private var isPlaying = false
    private var resumeAfterInterruption = false
    private var sessionActive = false   // avoids re-activating the audio session on every start

    // MARK: - Audio objects
    private let engine  = AVAudioEngine()
    private let clkNode = AVAudioPlayerNode()
    private let mixNode = AVAudioMixerNode()   // volume control
    private var hiBuffer:  AVAudioPCMBuffer?   // m_hi.wav  (accent)
    private var lowBuffer: AVAudioPCMBuffer?   // m_low.wav (normal)
    private var connectedFormat: AVAudioFormat?
    private var ticker: DispatchSourceTimer?
    private var lastBeat = -1

    // MARK: - Init
    init() {
        q.async { [self] in
            activateSession()
            setupEngine()
            loadSamples()
            observeSystemEvents()
        }
    }

    // MARK: - Public API (thread-safe)

    /// Starts playing. If already playing with identical settings this is a no-op
    /// (prevents a double click when JS and the lock screen both ask to play).
    /// `completion` receives the resulting playing state once the command has been applied.
    func start(bpm: Double, beatsPerBar: Int, accents: [String]?, subdivision: Int, title: String?, completion: @escaping (Bool) -> Void) {
        q.async { [self] in
            setTitle(title)
            let changed = apply(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents, subdivision: subdivision)
            if !isPlaying || changed { startPlayback() }
            completion(isPlaying)
        }
    }

    /// Updates settings; restarts the bar only if something actually changed and we are playing.
    func update(bpm: Double, beatsPerBar: Int, accents: [String]?, subdivision: Int, title: String?) {
        q.async { [self] in
            setTitle(title)
            let changed = apply(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents, subdivision: subdivision)
            if isPlaying && changed { startPlayback() } else { syncLiveActivity() }
        }
    }

    /// Lock-screen / Live Activity buttons.
    func handle(_ command: MetronomeCommand) {
        q.async { [self] in
            switch command {
            case .toggle:
                if isPlaying { resumeAfterInterruption = false; halt() } else { startPlayback() }
            case .tempoUp:
                adjustTempo(by: 1)
            case .tempoDown:
                adjustTempo(by: -1)
            }
        }
    }

    private func adjustTempo(by delta: Double) {
        let next = max(30, min(300, bpm + delta))
        guard next != bpm else { return }
        bpm = next
        if isPlaying { startPlayback() } else { syncLiveActivity() }
        let tempo = Int(next.rounded())
        DispatchQueue.main.async { [weak self] in self?.onTempo?(tempo) }
    }

    private func setTitle(_ newTitle: String?) {
        let t = (newTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        title = t.isEmpty ? "Metronome" : t
    }

    private func syncLiveActivity() {
        if #available(iOS 16.2, *) {
            MetronomeLiveActivity.shared.sync(title: title, bpm: Int(bpm.rounded()), playing: isPlaying)
        }
    }

    func stop(completion: @escaping (Bool) -> Void) {
        q.async { [self] in
            resumeAfterInterruption = false
            halt()
            completion(isPlaying)
        }
    }

    func setVolume(_ v: Float) {
        q.async { [self] in
            volume = max(0, min(1, v))
            mixNode.outputVolume = volume
        }
    }

    func queryState(_ completion: @escaping (Bool, Int) -> Void) {
        q.async { [self] in completion(isPlaying, Int(bpm.rounded())) }
    }

    // MARK: - Settings
    /// Returns true when any setting differs from the current one.
    private func apply(bpm newBpm: Double, beatsPerBar newBeats: Int, accents newAccents: [String]?, subdivision newSub: Int) -> Bool {
        let b   = max(30, min(300, newBpm))
        let n   = max(1, newBeats)
        let s   = max(1, min(4, newSub))
        let acc = normalizedAccents(newAccents, beats: n)
        let changed = b != bpm || n != beatsPerBar || s != subdivision || acc != accents
        bpm = b; beatsPerBar = n; subdivision = s; accents = acc
        return changed
    }

    private func normalizedAccents(_ incoming: [String]?, beats: Int) -> [String] {
        var arr = incoming ?? []
        while arr.count < beats { arr.append("normal") }
        return Array(arr.prefix(beats))
    }

    // MARK: - Audio session
    /// `force` re-applies category + activation (after an interruption or a category change by the web view).
    private func activateSession(force: Bool = false) {
        if sessionActive && !force { return }
        let session = AVAudioSession.sharedInstance()
        do {
            // .playback ignores the hardware silent switch and keeps playing with the screen locked.
            try session.setCategory(.playback, mode: .default, options: [])
            try session.setActive(true)
            sessionActive = true
        } catch {
            sessionActive = false
            print("[NativeMetronome] Audio session error: \(error)")
        }
    }

    // MARK: - Engine
    private func setupEngine() {
        engine.attach(clkNode)
        engine.attach(mixNode)
        // clkNode → mixNode → mainMixerNode → outputNode
        engine.connect(clkNode, to: mixNode, format: nil)
        engine.connect(mixNode, to: engine.mainMixerNode, format: nil)
        mixNode.outputVolume = volume
        startEngineIfNeeded()
    }

    @discardableResult
    private func startEngineIfNeeded() -> Bool {
        if engine.isRunning { return true }
        engine.prepare()
        do {
            try engine.start()
            return true
        } catch {
            print("[NativeMetronome] engine.start error: \(error)")
            return false
        }
    }

    // MARK: - Samples
    private func loadSamples() {
        // Capacitor copies the web assets into the bundle under public/audio/
        hiBuffer  = loadWav(named: "m_hi",  inSubdir: "public/audio")
        lowBuffer = loadWav(named: "m_low", inSubdir: "public/audio")
        print("[NativeMetronome] samples loaded: hi=\(hiBuffer != nil) low=\(lowBuffer != nil)")
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

    // MARK: - Bar buffer
    /// Renders one bar (all beats and subdivisions) into a single stereo buffer.
    /// Frame positions use the buffer's own sample rate, so tempo is exact.
    private func buildBarBuffer() -> AVAudioPCMBuffer? {
        var rate = hiBuffer?.format.sampleRate ?? lowBuffer?.format.sampleRate ?? 0
        if rate <= 0 {
            let out = engine.outputNode.outputFormat(forBus: 0).sampleRate
            rate = out > 0 ? out : 44100
        }
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2) else { return nil }

        let beatFrames = 60.0 / bpm * rate
        let barFrames  = AVAudioFrameCount((beatFrames * Double(beatsPerBar)).rounded())
        guard barFrames > 0,
              let bar = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: barFrames),
              let dst = bar.floatChannelData else {
            print("[NativeMetronome] could not allocate bar buffer (bpm \(bpm), beats \(beatsPerBar))")
            return nil
        }
        bar.frameLength = barFrames
        for ch in 0..<Int(fmt.channelCount) {
            memset(dst[ch], 0, Int(barFrames) * MemoryLayout<Float>.size)
        }

        let subs = max(1, subdivision)
        for beat in 0..<beatsPerBar {
            let state = beat < accents.count ? accents[beat] : "normal"
            if state == "mute" { continue }
            for k in 0..<subs {
                let isAccent = (k == 0 && state == "accent")
                let gain: Float = isAccent ? 1.0 : (k == 0 ? 0.85 : 0.7)
                let offset = Int((Double(beat) * beatFrames + Double(k) * beatFrames / Double(subs)).rounded())
                mixClick(isAccent ? hiBuffer : lowBuffer, into: bar, at: offset, gain: gain, isAccent: isAccent, rate: rate)
            }
        }
        return bar
    }

    private func mixClick(_ src: AVAudioPCMBuffer?, into bar: AVAudioPCMBuffer, at offset: Int, gain: Float, isAccent: Bool, rate: Double) {
        let total = Int(bar.frameLength)
        guard offset >= 0, offset < total, let dst = bar.floatChannelData else { return }
        let channels = Int(bar.format.channelCount)
        if let src = src, let srcData = src.floatChannelData, src.format.channelCount > 0 {
            let count = min(Int(src.frameLength), total - offset)
            guard count > 0 else { return }
            let srcChannels = Int(src.format.channelCount)
            for ch in 0..<channels {
                vDSP_vsma(
                    srcData[min(ch, srcChannels - 1)], 1,
                    [gain],
                    dst[ch] + offset, 1,
                    dst[ch] + offset, 1,
                    vDSP_Length(count)
                )
            }
        } else {
            synthesizeClick(into: bar, at: offset, isAccent: isAccent, sampleRate: rate)
        }
    }

    /// Synthetic sine-click fallback (used if the WAV files fail to load).
    private func synthesizeClick(into buf: AVAudioPCMBuffer, at offset: Int, isAccent: Bool, sampleRate: Double) {
        let freq: Double = isAccent ? 1500 : 1000
        let amp: Float   = isAccent ? 0.7 : 0.4
        let dur          = Int(0.05 * sampleRate)
        let end          = min(offset + dur, Int(buf.frameLength))
        guard dur > 0, offset < end, let ch = buf.floatChannelData else { return }
        for i in offset..<end {
            let t = Double(i - offset) / sampleRate
            let env = Float(1.0 - Double(i - offset) / Double(dur))
            let sample = amp * env * Float(sin(2 * .pi * freq * t))
            for c in 0..<Int(buf.format.channelCount) {
                ch[c][i] += sample
            }
        }
    }

    // MARK: - Playback
    private func startPlayback() {
        stopTicker()
        activateSession()   // no-op when already active; never runs on the main thread

        guard let buf = buildBarBuffer() else {
            isPlaying = false
            publishState()
            return
        }

        clkNode.stop()
        clkNode.reset()

        // The player must be connected with the format of the buffer it plays.
        if connectedFormat != buf.format {
            engine.disconnectNodeOutput(clkNode)
            engine.connect(clkNode, to: mixNode, format: buf.format)
            connectedFormat = buf.format
        }
        guard startEngineIfNeeded() else {
            isPlaying = false
            publishState()
            return
        }

        clkNode.scheduleBuffer(buf, at: nil, options: .loops, completionHandler: nil)
        clkNode.play()

        isPlaying = true
        startTicker(barFrames: Int(buf.frameLength), beats: beatsPerBar)
        publishState()
        print("[NativeMetronome] playing: bpm=\(bpm) beats=\(beatsPerBar) sub=\(subdivision) hi=\(hiBuffer != nil) low=\(lowBuffer != nil) rate=\(buf.format.sampleRate)")
    }

    /// Stops sound and notifies JS.
    private func halt() {
        let wasPlaying = isPlaying
        isPlaying = false
        stopTicker()
        clkNode.stop()
        clkNode.reset()
        if wasPlaying { publishState() }
    }

    // MARK: - Beat ticker (driven by the audio clock)
    private func startTicker(barFrames: Int, beats: Int) {
        stopTicker()
        lastBeat = -1
        guard barFrames > 0, beats > 0 else { return }
        let beatFrames = Double(barFrames) / Double(beats)
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: q)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in
            guard let self = self, self.isPlaying,
                  let nodeTime = self.clkNode.lastRenderTime,
                  let playerTime = self.clkNode.playerTime(forNodeTime: nodeTime) else { return }
            let sample = Int(playerTime.sampleTime)
            guard sample >= 0 else { return }
            let beat = min(beats - 1, Int(Double(sample % barFrames) / beatFrames))
            if beat != self.lastBeat {
                self.lastBeat = beat
                self.onBeat?(beat)
            }
        }
        ticker = timer
        timer.resume()
    }

    private func stopTicker() {
        ticker?.cancel()
        ticker = nil
    }

    private func publishState() {
        let playing = isPlaying
        DispatchQueue.main.async { [weak self] in self?.onState?(playing) }
        syncLiveActivity()
    }

    // MARK: - System events
    private func observeSystemEvents() {
        let nc = NotificationCenter.default
        let session = AVAudioSession.sharedInstance()

        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: session, queue: nil) { [weak self] note in
            self?.q.async { self?.handleInterruption(note) }
        }
        nc.addObserver(forName: AVAudioSession.routeChangeNotification, object: session, queue: nil) { [weak self] note in
            self?.q.async { self?.handleRouteChange(note) }
        }
        // Output device / sample-rate changes stop the engine; rebuild and keep playing.
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.q.async {
                guard let self = self, self.isPlaying else { return }
                print("[NativeMetronome] engine configuration changed — restarting")
                self.startPlayback()
            }
        }
        nc.addObserver(forName: AVAudioSession.mediaServicesWereResetNotification, object: session, queue: nil) { [weak self] _ in
            self?.q.async {
                guard let self = self, self.isPlaying else { return }
                print("[NativeMetronome] media services reset — restarting")
                self.connectedFormat = nil
                self.activateSession(force: true)
                self.startPlayback()
            }
        }
    }

    private func handleInterruption(_ note: Notification) {
        guard let info = note.userInfo,
              let typeVal = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: typeVal) else { return }
        switch type {
        case .began:
            sessionActive = false
            if isPlaying {
                resumeAfterInterruption = true
                halt()   // publishes state so the UI never shows "playing" while silent
            }
        case .ended:
            let optVal = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let opts = AVAudioSession.InterruptionOptions(rawValue: optVal)
            if resumeAfterInterruption && opts.contains(.shouldResume) {
                resumeAfterInterruption = false
                activateSession(force: true)
                startPlayback()
            }
        @unknown default:
            break
        }
    }

    private func handleRouteChange(_ note: Notification) {
        guard isPlaying else { return }
        let reasonVal = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: reasonVal)
        // The web view (piano / web audio) can switch the shared session to another
        // category; that would mute the click on the silent switch. Put it back.
        if reason == .categoryChange && AVAudioSession.sharedInstance().category != .playback {
            activateSession(force: true)
        }
        if !engine.isRunning {
            startPlayback()
        }
    }
}
