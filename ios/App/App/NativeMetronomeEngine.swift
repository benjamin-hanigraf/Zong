import AVFoundation

// ============================================================
// NativeMetronomeEngine
//
// This is the same mechanism as the PWA's Web Audio metronome, on AVAudioEngine:
//
//   • Clicks are NOT pre-rendered into a looping bar. A small scheduler runs every
//     few milliseconds and schedules each upcoming click (a short sample buffer) at
//     its exact sample time, ~120 ms ahead of the audio clock ("look-ahead").
//   • The time of the next click is always "previous click + one beat at the CURRENT
//     tempo", so a tempo / accent / time-signature change simply takes effect on the
//     next click. Nothing is restarted, so changing tempo never causes a stray click.
//   • Start: the first click is scheduled to play immediately and the player is started;
//     Stop: the player is stopped, which discards everything still queued.
//   • Beat flashes are fired from the same audio clock, so they match the sound.
//
// Threading: ALL mutable state lives on one serial queue (`q`). Public methods can be
// called from any thread. Blocking work (activating the audio session) never runs on the
// main thread. The engine is the source of truth for "playing": every change (start,
// stop, interruption, lock-screen button) is published via `onState` and JS mirrors it.
// The lock-screen Live Activity (MetronomeLiveActivity.swift) mirrors the state and its
// +/−/play buttons call handle(_:). The engine recovers by itself from audio route /
// configuration changes and category changes made by the web view.
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
    private var title = "Metronome"      // shown on the lock-screen Live Activity
    private var volume: Float = 1.0
    private var isPlaying = false
    private var resumeAfterInterruption = false
    private var lastCommand: MetronomeCommand?
    private var lastCommandTime: UInt64 = 0
    private var sessionActive = false    // avoids re-activating the audio session on every start

    // MARK: - Audio objects
    private let engine  = AVAudioEngine()
    private let clkNode = AVAudioPlayerNode()
    private let mixNode = AVAudioMixerNode()   // volume control
    private var format: AVAudioFormat?          // canonical click format (stereo float)
    private var accentClick: AVAudioPCMBuffer?  // m_hi.wav
    private var normalClick: AVAudioPCMBuffer?  // m_low.wav
    private var subClick: AVAudioPCMBuffer?     // m_low.wav, quieter (subdivisions)

    // MARK: - Scheduler state
    private let lookahead = 0.12                // seconds scheduled ahead of the audio clock
    private var scheduler: DispatchSourceTimer?
    private var nextFrame: Double = 0           // player-timeline frame of the next click
    private var nextBeat = 0
    private var nextSub = 0
    private var upcomingBeats: [(frame: Int64, beat: Int)] = []   // scheduled, not yet flashed

    // MARK: - Init
    init() {
        q.async { [self] in
            activateSession()
            loadSamples()
            setupEngine()
            observeSystemEvents()
        }
    }

    // MARK: - Public API (thread-safe)

    /// `completion` receives the resulting playing state once the command has been applied.
    func start(bpm: Double, beatsPerBar: Int, accents: [String]?, subdivision: Int, title: String?, completion: @escaping (Bool) -> Void) {
        q.async { [self] in
            setTitle(title)
            apply(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents, subdivision: subdivision)
            if !isPlaying { startPlayback() }
            completion(isPlaying)
        }
    }

    /// Updates settings on the fly; they apply from the next click (nothing restarts).
    func update(bpm: Double, beatsPerBar: Int, accents: [String]?, subdivision: Int, title: String?) {
        q.async { [self] in
            setTitle(title)
            apply(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents, subdivision: subdivision)
            syncLiveActivity()
        }
    }

    func stop(completion: @escaping (Bool) -> Void) {
        q.async { [self] in
            resumeAfterInterruption = false
            halt()
            completion(isPlaying)
        }
    }

    /// Lock-screen / Live Activity buttons.
    func handle(_ command: MetronomeCommand) {
        q.async { [self] in
            // When the Live Activity is used from a Mac (menu bar / iPhone Mirroring) one click
            // can be delivered twice. Identical commands within 120 ms are the same click.
            let now = DispatchTime.now().uptimeNanoseconds
            if command == lastCommand, now - lastCommandTime < 120_000_000 { return }
            lastCommand = command
            lastCommandTime = now
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
    private func apply(bpm newBpm: Double, beatsPerBar newBeats: Int, accents newAccents: [String]?, subdivision newSub: Int) {
        bpm = max(30, min(300, newBpm))
        beatsPerBar = max(1, newBeats)
        subdivision = max(1, min(4, newSub))
        var arr = newAccents ?? []
        while arr.count < beatsPerBar { arr.append("normal") }
        accents = Array(arr.prefix(beatsPerBar))
        if nextBeat >= beatsPerBar { nextBeat = 0; nextSub = 0 }
        if nextSub >= subdivision { nextSub = 0 }
    }

    private func adjustTempo(by delta: Double) {
        let next = max(30, min(300, bpm + delta))
        guard next != bpm else { return }
        bpm = next   // takes effect on the next scheduled click; no restart
        syncLiveActivity()
        let tempo = Int(next.rounded())
        DispatchQueue.main.async { [weak self] in self?.onTempo?(tempo) }
    }

    private func setTitle(_ newTitle: String?) {
        let t = (newTitle ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        title = t.isEmpty ? "Metronome" : t
    }

    /// Lock-screen updates run on their own queue: creating/updating a Live Activity can take
    /// hundreds of ms and must never delay the click or the next button press.
    private func syncLiveActivity() {
        let t = title, b = Int(bpm.rounded()), p = isPlaying
        if #available(iOS 16.2, *) {
            MetronomeLiveActivity.shared.sync(title: t, bpm: b, playing: p)
        }
    }

    // MARK: - Audio session
    /// `force` re-applies category + activation (after an interruption or a category change by the web view).
    private func activateSession(force: Bool = false) {
        if sessionActive && !force { return }
        let session = AVAudioSession.sharedInstance()
        do {
            // .playback ignores the hardware silent switch and keeps playing with the screen locked.
            try session.setCategory(.playback, mode: .default, options: [])
            // ~5 ms hardware buffer instead of the default ~23 ms: clicks start/stop sooner.
            try? session.setPreferredIOBufferDuration(0.005)
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
        // clkNode → mixNode → mainMixerNode → outputNode, connected with the click format up
        // front so the first Play never has to re-wire a running engine.
        engine.connect(clkNode, to: mixNode, format: format)
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

    // MARK: - Click samples
    private func loadSamples() {
        // Capacitor copies the web assets into the bundle under public/ (the same /tones files the PWA uses)
        let hi  = loadWav(named: "m_hi",  inSubdir: "public/tones")
        let low = loadWav(named: "m_low", inSubdir: "public/tones")

        var rate = hi?.format.sampleRate ?? low?.format.sampleRate ?? 0
        if rate <= 0 { rate = 44100 }
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 2) else { return }
        format = fmt

        accentClick = (hi.flatMap  { canonical($0, to: fmt, gain: 1.0) })  ?? synthClick(fmt, accent: true,  gain: 1.0)
        normalClick = (low.flatMap { canonical($0, to: fmt, gain: 0.85) }) ?? synthClick(fmt, accent: false, gain: 0.85)
        subClick    = (low.flatMap { canonical($0, to: fmt, gain: 0.7) })  ?? synthClick(fmt, accent: false, gain: 0.7)
        print("[NativeMetronome] samples: hi=\(hi != nil) low=\(low != nil) rate=\(rate)")
    }

    private func loadWav(named name: String, inSubdir subdir: String) -> AVAudioPCMBuffer? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "wav", subdirectory: subdir) else {
            print("[NativeMetronome] WAV not found: \(subdir)/\(name).wav")
            return nil
        }
        do {
            let file   = try AVAudioFile(forReading: url)
            let count  = AVAudioFrameCount(file.length)
            guard let buf = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: count) else { return nil }
            try file.read(into: buf)
            return buf
        } catch {
            print("[NativeMetronome] WAV load error \(name): \(error)")
            return nil
        }
    }

    /// Converts a loaded WAV (any channel count / rate) to the canonical stereo format and scales it.
    private func canonical(_ src: AVAudioPCMBuffer, to fmt: AVAudioFormat, gain: Float) -> AVAudioPCMBuffer? {
        var out: AVAudioPCMBuffer?
        if src.format == fmt {
            out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: src.frameLength)
            if let out = out, let s = src.floatChannelData, let d = out.floatChannelData {
                for ch in 0..<Int(fmt.channelCount) { memcpy(d[ch], s[ch], Int(src.frameLength) * MemoryLayout<Float>.size) }
                out.frameLength = src.frameLength
            }
        } else if let converter = AVAudioConverter(from: src.format, to: fmt) {
            let ratio = fmt.sampleRate / src.format.sampleRate
            let capacity = AVAudioFrameCount(Double(src.frameLength) * ratio) + 64
            out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: capacity)
            var fed = false
            var error: NSError?
            if let out = out {
                converter.convert(to: out, error: &error) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return src
                }
            }
            if let error = error { print("[NativeMetronome] sample conversion error: \(error)"); return nil }
        }
        guard let result = out, let d = result.floatChannelData else { return nil }
        let n = Int(result.frameLength)
        for ch in 0..<Int(fmt.channelCount) {
            for i in 0..<n { d[ch][i] *= gain }
        }
        return result
    }

    /// Short sine blip, used only if the WAV files can't be loaded.
    private func synthClick(_ fmt: AVAudioFormat, accent: Bool, gain: Float) -> AVAudioPCMBuffer? {
        let rate = fmt.sampleRate
        let frames = AVAudioFrameCount(0.05 * rate)
        guard frames > 0, let buf = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: frames), let d = buf.floatChannelData else { return nil }
        buf.frameLength = frames
        let freq: Double = accent ? 1500 : 1000
        let amp: Float   = (accent ? 0.7 : 0.4) * gain
        for i in 0..<Int(frames) {
            let env = Float(1.0 - Double(i) / Double(frames))
            let sample = amp * env * Float(sin(2 * .pi * freq * Double(i) / rate))
            for ch in 0..<Int(fmt.channelCount) { d[ch][i] = sample }
        }
        return buf
    }

    // MARK: - Playback
    private func startPlayback() {
        stopScheduler()
        activateSession()   // no-op when already active; never runs on the main thread

        guard format != nil, accentClick != nil, normalClick != nil, startEngineIfNeeded() else {
            isPlaying = false
            publishState()
            return
        }

        // Restarts (interruption recovery) need the node cleared.
        if isPlaying {
            clkNode.stop()
            clkNode.reset()
        }

        nextFrame = 0
        nextBeat = 0
        nextSub = 0
        upcomingBeats.removeAll()

        // First click plays the instant the player starts; the scheduler takes over right after.
        scheduleNextClick(immediate: true)
        clkNode.play()
        isPlaying = true
        startScheduler()
        publishState()
        print("[NativeMetronome] playing: bpm=\(bpm) beats=\(beatsPerBar) sub=\(subdivision)")
    }

    /// Stops sound (discarding everything still queued) and notifies JS.
    private func halt() {
        let wasPlaying = isPlaying
        isPlaying = false
        stopScheduler()
        clkNode.stop()
        clkNode.reset()
        upcomingBeats.removeAll()
        if wasPlaying { publishState() }
    }

    // MARK: - Look-ahead scheduler (same idea as the PWA's scheduler())
    private func startScheduler() {
        stopScheduler()
        let timer = DispatchSource.makeTimerSource(flags: .strict, queue: q)
        timer.schedule(deadline: .now(), repeating: .milliseconds(8), leeway: .milliseconds(1))
        timer.setEventHandler { [weak self] in self?.tick() }
        scheduler = timer
        timer.resume()
    }

    private func stopScheduler() {
        scheduler?.cancel()
        scheduler = nil
    }

    private func tick() {
        guard isPlaying, let fmt = format else { return }
        let now = currentFrame()
        let horizon = Double(now) + lookahead * fmt.sampleRate
        while nextFrame < horizon {
            scheduleNextClick(immediate: false)
        }
        while let first = upcomingBeats.first, first.frame <= now {
            upcomingBeats.removeFirst()
            onBeat?(first.beat)
        }
    }

    /// Position of the audio clock on the player's timeline.
    private func currentFrame() -> Int64 {
        if let nodeTime = clkNode.lastRenderTime, let playerTime = clkNode.playerTime(forNodeTime: nodeTime) {
            return max(0, playerTime.sampleTime)
        }
        return 0
    }

    /// Schedules the click at `nextFrame`, then advances to the following one using the
    /// CURRENT tempo / subdivision (so changes apply from the next click, like the PWA).
    private func scheduleNextClick(immediate: Bool) {
        guard let fmt = format else { return }
        let beat = nextBeat
        let state = beat < accents.count ? accents[beat] : "normal"
        let frame = Int64(nextFrame.rounded())

        if state != "mute" {
            let buffer: AVAudioPCMBuffer?
            if nextSub == 0 { buffer = (state == "accent") ? accentClick : normalClick } else { buffer = subClick }
            if let buffer = buffer {
                let when: AVAudioTime? = immediate ? nil : AVAudioTime(sampleTime: frame, atRate: fmt.sampleRate)
                clkNode.scheduleBuffer(buffer, at: when, options: [], completionHandler: nil)
            }
            if nextSub == 0 { upcomingBeats.append((frame: frame, beat: beat)) }
        }

        let subFrames = (60.0 / bpm) * fmt.sampleRate / Double(subdivision)
        nextFrame += subFrames
        nextSub += 1
        if nextSub >= subdivision {
            nextSub = 0
            nextBeat = (nextBeat + 1) % beatsPerBar
        }
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
        let reasonVal = note.userInfo?[AVAudioSessionRouteChangeReasonKey] as? UInt ?? 0
        let reason = AVAudioSession.RouteChangeReason(rawValue: reasonVal)
        // The web view plays the piano with Web Audio, and WebKit puts the shared session into
        // an "ambient" category for it. Ambient audio is silenced by the phone's silent switch,
        // so the piano went mute while the metronome (our .playback session) still played.
        // Whenever anything changes the category away from .playback — playing or not — put it back.
        if reason == .categoryChange && AVAudioSession.sharedInstance().category != .playback {
            print("[NativeMetronome] audio category changed to \(AVAudioSession.sharedInstance().category.rawValue) — restoring playback")
            activateSession(force: true)
        }
        if isPlaying && !engine.isRunning {
            startPlayback()
        }
    }
}
