import AVFoundation
import UIKit

// ============================================================
// NativePianoSynth
//
// The piano (sampled notes, used in Chords/Drums mode) and the warm pad chord (Vocals mode)
// rendered by the app's own audio engine instead of the web view's Web Audio. Web Audio is
// subject to WebKit's own audio-session rules — it was muted by the phone's silent switch —
// while this engine uses the same .playback session as the metronome, so it always sounds.
//
// It is a small real-time synthesiser in ONE AVAudioSourceNode:
//   • sample voices: the 12 piano recordings pitched by playback rate (same as Web Audio's
//     playbackRate), 8 ms attack, 300 ms release;
//   • pad voices: the same sine oscillators / detune / low-pass / pan / "air" layer as the web
//     version (filters are applied analytically since every oscillator is a pure sine);
//   • a master compressor matching the web one (-12 dB threshold, 8 dB knee, 3:1, 6/220 ms).
// JS sends note on / off commands; the render thread owns all voice state (commands are handed
// over through a tiny lock-protected queue, so the audio thread never waits).
// ============================================================

private let kSampleRate: Double = 44100

private struct SynthCommand {
    var type: Int32 = 0      // 0 sample note on, 1 pad on, 2 off (by id), 3 all off, 4 pad on from a table slot
    var id: Int32 = 0
    var value: Int32 = 0     // midi note (sample) or root semitone (pad)
    var flag: Int32 = 0      // pad: 1 = minor
}

private struct SynthVoice {
    var active = false
    var id: Int32 = 0
    var isPad = false
    var releasing = false
    var env: Float = 0
    var target: Float = 1
    var attackInc: Float = 0
    var releaseMul: Float = 1
    var age: Int = 0
    // sample voices
    var bank = 0
    var pos: Double = 0
    var rate: Double = 1
    // pad voices
    var oscCount = 0
    // looped warm-pad sample voices (loopEnd > 0)
    var loopStart: Double = 0
    var loopEnd: Double = 0
    var level: Float = 1
    var panMode = 0          // 0 none (piano), 1 pan left of centre, 2 pan right — the Web Audio StereoPanner law for stereo input
    var panL: Float = 1
    var panR: Float = 1
}

private final class SynthCore {
    static let maxVoices = 24
    static let maxCommands = 256
    static let maxOsc = 16
    static let maxBank = 32      // 12 piano samples + 12 warm-pad samples (+ spare)
    static let tableSlots = 32   // 0..23 = the 12 roots x major/minor pads, 24..31 = spare slots for the joystick's chords

    private let voices: UnsafeMutablePointer<SynthVoice>
    private let padPhase: UnsafeMutablePointer<Double>
    private let padInc: UnsafeMutablePointer<Double>
    private let padAmpL: UnsafeMutablePointer<Float>
    private let padAmpR: UnsafeMutablePointer<Float>
    // pad chord tables: index = root * 2 + (minor ? 1 : 0); 24...31 hold custom chords (see buildCustomPad)
    private let tableInc: UnsafeMutablePointer<Double>
    private let tableL: UnsafeMutablePointer<Float>
    private let tableR: UnsafeMutablePointer<Float>
    private let tableCount: UnsafeMutablePointer<Int>

    private let queue: UnsafeMutablePointer<SynthCommand>
    private let drained: UnsafeMutablePointer<SynthCommand>
    private var queued = 0
    private let lock: UnsafeMutablePointer<os_unfair_lock>

    // Sample bank (written by the control thread before notes are played)
    private let bankL: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>
    private let bankR: UnsafeMutablePointer<UnsafeMutablePointer<Float>?>
    private let bankFrames: UnsafeMutablePointer<Int>
    private let bankMidi: UnsafeMutablePointer<Int>
    private let bankIsPad: UnsafeMutablePointer<Bool>          // warm-pad sample (looped) rather than a piano sample
    private let bankLoopStart: UnsafeMutablePointer<Double>
    private let bankLoopEnd: UnsafeMutablePointer<Double>
    private var bankCount = 0

    private var ageCounter = 0
    // compressor state
    private var detector: Float = 0
    private let attackCoef: Float
    private let releaseCoef: Float
    private let sr = Float(kSampleRate)

    init() {
        voices = .allocate(capacity: SynthCore.maxVoices)
        voices.initialize(repeating: SynthVoice(), count: SynthCore.maxVoices)
        let oscTotal = SynthCore.maxVoices * SynthCore.maxOsc
        padPhase = .allocate(capacity: oscTotal); padPhase.initialize(repeating: 0, count: oscTotal)
        padInc = .allocate(capacity: oscTotal);   padInc.initialize(repeating: 0, count: oscTotal)
        padAmpL = .allocate(capacity: oscTotal);  padAmpL.initialize(repeating: 0, count: oscTotal)
        padAmpR = .allocate(capacity: oscTotal);  padAmpR.initialize(repeating: 0, count: oscTotal)
        let tableTotal = SynthCore.tableSlots * SynthCore.maxOsc
        tableInc = .allocate(capacity: tableTotal); tableInc.initialize(repeating: 0, count: tableTotal)
        tableL = .allocate(capacity: tableTotal);   tableL.initialize(repeating: 0, count: tableTotal)
        tableR = .allocate(capacity: tableTotal);   tableR.initialize(repeating: 0, count: tableTotal)
        tableCount = .allocate(capacity: SynthCore.tableSlots); tableCount.initialize(repeating: 0, count: SynthCore.tableSlots)
        queue = .allocate(capacity: SynthCore.maxCommands);   queue.initialize(repeating: SynthCommand(), count: SynthCore.maxCommands)
        drained = .allocate(capacity: SynthCore.maxCommands); drained.initialize(repeating: SynthCommand(), count: SynthCore.maxCommands)
        lock = .allocate(capacity: 1); lock.initialize(to: os_unfair_lock())
        bankL = .allocate(capacity: SynthCore.maxBank); bankL.initialize(repeating: nil, count: SynthCore.maxBank)
        bankR = .allocate(capacity: SynthCore.maxBank); bankR.initialize(repeating: nil, count: SynthCore.maxBank)
        bankFrames = .allocate(capacity: SynthCore.maxBank); bankFrames.initialize(repeating: 0, count: SynthCore.maxBank)
        bankMidi = .allocate(capacity: SynthCore.maxBank); bankMidi.initialize(repeating: 0, count: SynthCore.maxBank)
        bankIsPad = .allocate(capacity: SynthCore.maxBank); bankIsPad.initialize(repeating: false, count: SynthCore.maxBank)
        bankLoopStart = .allocate(capacity: SynthCore.maxBank); bankLoopStart.initialize(repeating: 0, count: SynthCore.maxBank)
        bankLoopEnd = .allocate(capacity: SynthCore.maxBank); bankLoopEnd.initialize(repeating: 0, count: SynthCore.maxBank)
        attackCoef = 1 - expf(-1 / (0.006 * Float(kSampleRate)))
        releaseCoef = 1 - expf(-1 / (0.220 * Float(kSampleRate)))
    }

    // MARK: Control thread

    /// `loopEnd > 0` marks a warm-pad sample that loops between loopStart and loopEnd (frames).
    func addSample(left: UnsafeMutablePointer<Float>, right: UnsafeMutablePointer<Float>, frames: Int, midi: Int, loopStart: Int = 0, loopEnd: Int = 0) {
        guard bankCount < SynthCore.maxBank else { return }
        os_unfair_lock_lock(lock)
        bankL[bankCount] = left
        bankR[bankCount] = right
        bankFrames[bankCount] = frames
        bankMidi[bankCount] = midi
        bankIsPad[bankCount] = loopEnd > 0
        bankLoopStart[bankCount] = Double(loopStart)
        bankLoopEnd[bankCount] = Double(loopEnd)
        bankCount += 1
        os_unfair_lock_unlock(lock)
    }

    var hasPadSamples: Bool {
        for i in 0..<bankCount where bankIsPad[i] { return true }
        return false
    }

    func push(_ command: SynthCommand) {
        os_unfair_lock_lock(lock)
        if queued < SynthCore.maxCommands {
            queue[queued] = command
            queued += 1
        } else if command.type == 2 || command.type == 3 {
            // A "release" must never be lost (the looping pad would ring on for ever): if the queue is full, it takes the
            // place of the oldest queued note-on instead.
            var i = 0
            while i < queued && (queue[i].type == 2 || queue[i].type == 3) { i += 1 }
            if i < queued { queue[i] = command }
        }
        os_unfair_lock_unlock(lock)
    }

    // MARK: Render thread

    private func drainCommands() {
        var n = 0
        if os_unfair_lock_trylock(lock) {
            n = queued
            for i in 0..<n { drained[i] = queue[i] }
            queued = 0
            os_unfair_lock_unlock(lock)
        }
        for i in 0..<n { apply(drained[i]) }
    }

    private func apply(_ c: SynthCommand) {
        switch c.type {
        case 0: startSample(id: c.id, midi: Int(c.value))
        case 1: startPad(id: c.id, root: Int(c.value), minor: c.flag == 1)
        case 4: startPadSlot(id: c.id, t: Int(c.value))
        case 5: startPadSample(id: c.id, midi: Int(c.value), packed: Int(c.flag))
        case 2:
            for v in 0..<SynthCore.maxVoices where voices[v].active && voices[v].id == c.id && !voices[v].releasing {
                release(v)
            }
        default:
            for v in 0..<SynthCore.maxVoices where voices[v].active && !voices[v].releasing { release(v) }
        }
    }

    private func release(_ v: Int) {
        voices[v].releasing = true
        let seconds: Float = (voices[v].isPad || voices[v].loopEnd > 0) ? 0.28 : 0.30
        let start = max(voices[v].env, 0.0002)
        // exponential fall from the current level to 0.0001 over `seconds` (like exponentialRampToValueAtTime)
        voices[v].releaseMul = expf(logf(0.0001 / start) / (seconds * sr))
    }

    private func allocateVoice() -> Int {
        var oldest = 0
        var oldestAge = Int.max
        for v in 0..<SynthCore.maxVoices {
            if !voices[v].active { return v }
            if voices[v].age < oldestAge { oldestAge = voices[v].age; oldest = v }
        }
        return oldest   // steal the oldest voice
    }

    private func startSample(id: Int32, midi: Int) {
        guard bankCount > 0 else { return }
        var best = 0
        var bestDist = Int.max
        for i in 0..<bankCount where !bankIsPad[i] {
            let d = abs(midi - bankMidi[i])
            if d < bestDist { bestDist = d; best = i }
        }
        let v = allocateVoice()
        ageCounter += 1
        var voice = SynthVoice()
        voice.active = true
        voice.id = id
        voice.isPad = false
        voice.env = 0
        voice.target = 1.0
        voice.attackInc = 1 / (0.008 * sr)
        voice.bank = best
        voice.pos = 0
        voice.rate = pow(2.0, Double(midi - bankMidi[best]) / 12.0)
        voice.age = ageCounter
        voices[v] = voice
    }

    /// One note of a warm-pad chord: the nearest pad sample, pitched to `midi`, looped while held.
    /// packed = pan index * 1000 + gain * 100 (pan index 0...20 = -1...+1).
    private func startPadSample(id: Int32, midi: Int, packed: Int) {
        var best = -1
        var bestDist = Int.max
        for i in 0..<bankCount where bankIsPad[i] {
            let d = abs(midi - bankMidi[i])
            if d < bestDist { bestDist = d; best = i }
        }
        guard best >= 0 else { return }
        let gain = Float(packed % 1000) / 100
        let pan = Double(packed / 1000 - 10) / 10
        // StereoPanner (stereo input): pan <= 0 -> x = pan + 1, else x = pan; gL = cos, gR = sin of x * pi/2
        let x = pan <= 0 ? pan + 1 : pan
        let v = allocateVoice()
        ageCounter += 1
        var voice = SynthVoice()
        voice.active = true
        voice.id = id
        voice.isPad = false
        voice.env = 0
        voice.target = 0.9
        voice.attackInc = 0.9 / (0.08 * sr)
        voice.bank = best
        voice.pos = 0
        voice.rate = pow(2.0, Double(midi - bankMidi[best]) / 12.0)
        voice.loopStart = bankLoopStart[best]
        voice.loopEnd = bankLoopEnd[best]
        voice.level = gain
        voice.panMode = pan <= 0 ? 1 : 2
        voice.panL = Float(cos(x * Double.pi / 2))
        voice.panR = Float(sin(x * Double.pi / 2))
        voice.age = ageCounter
        voices[v] = voice
    }

    /// |H| of a 2nd-order low-pass (Web Audio biquad, Q given in dB) at frequency f.
    private func lowpassGain(_ f: Double, cutoff: Double, qDb: Double) -> Double {
        let x = f / cutoff
        let q = pow(10.0, qDb / 20.0)
        let a = 1 - x * x
        return 1 / sqrt(a * a + (x / q) * (x / q))
    }

    /// Pre-computes the 24 pad chords (12 roots x major/minor) so starting one on the audio
    /// thread is just a copy — no allocation or maths there. Call once, before audio starts.
    func buildPadTables() {
        for root in 0..<12 {
            for minorFlag in 0..<2 {
                let t = root * 2 + minorFlag
                let base = 48 + root
                let third = minorFlag == 1 ? 3 : 4
                // (midi, gain, cutoff, detune cents, pan) — identical to the web version
                let notes: [(Int, Double, Double, Double, Double)] = [
                    (base,              0.28, 800,  0, -0.30),
                    (base + 7,          0.18, 1600, 5,  0.25),
                    (base + 12,         0.32, 1800, 6,  0.00),
                    (base + 12 + third, 0.20, 2000, 5,  0.20),
                ]
                var count = 0
                let slot = t * SynthCore.maxOsc

                func add(freq: Double, amp: Double, left: Double, right: Double) {
                    guard count < SynthCore.maxOsc else { return }
                    tableInc[slot + count] = 2 * Double.pi * freq / kSampleRate
                    tableL[slot + count] = Float(amp * left)
                    tableR[slot + count] = Float(amp * right)
                    count += 1
                }

                for (idx, n) in notes.enumerated() {
                    let freq = 440.0 * pow(2.0, Double(n.0 - 69) / 12.0)
                    let master = lowpassGain(freq, cutoff: 2400, qDb: 0.5)
                    // stereo panner (equal power, mono input)
                    let x = (n.4 + 1) / 2
                    let pl = cos(x * Double.pi / 2)
                    let pr = sin(x * Double.pi / 2)
                    let detunes: [Double] = n.3 > 0 ? [-n.3 / 2, n.3 / 2] : [0]
                    for dt in detunes {
                        let f = freq * pow(2.0, dt / 1200.0)
                        add(freq: f, amp: n.1 * lowpassGain(f, cutoff: n.2, qDb: 0.4) * master, left: pl, right: pr)
                    }
                    if idx > 0 {
                        // "air" layer: one octave up, very quiet, low-passed, un-panned
                        let f2 = freq * 2
                        let airCut = min(n.2 * 1.4, 3000)
                        let amp = n.1 * 0.08 * lowpassGain(f2, cutoff: airCut, qDb: 0.4) * lowpassGain(f2, cutoff: 2400, qDb: 0.5)
                        add(freq: f2, amp: amp, left: 1, right: 1)
                    }
                }
                tableCount[t] = count
            }
        }
    }

    /// Builds one pad chord from the MIDI note of each voice (the app decides the voicing: close position in a fixed
    /// register) into a spare table slot, with the same voices / filtering / pans as the 24 built-in pads. Runs on the
    /// control thread BEFORE the start command is queued, so the audio thread only ever copies a finished slot.
    /// A note of -1 means that voice is not used (octave, extra, bass).
    func buildCustomPad(slot t: Int, root: Int, third: Int, fifth: Int, octave: Int, extra: Int, bass: Int) {
        guard t >= 24, t < SynthCore.tableSlots, root >= 0 else { return }
        var notes: [(Int, Double, Double, Double, Double)] = [
            (root,  0.28, 800,  0, -0.30),
            (fifth, 0.18, 1600, 5,  0.25),
        ]
        if octave >= 0 { notes.append((octave, 0.32, 1800, 6, 0.00)) }
        notes.append((third, 0.20, 2000, 5, 0.20))
        if extra >= 0 { notes.append((extra, 0.16, 2000, 5, -0.15)) }
        if bass >= 0 { notes.append((bass, 0.28, 700, 0, -0.10)) }
        var count = 0
        let offset = t * SynthCore.maxOsc

        func add(freq: Double, amp: Double, left: Double, right: Double) {
            guard count < SynthCore.maxOsc else { return }
            tableInc[offset + count] = 2 * Double.pi * freq / kSampleRate
            tableL[offset + count] = Float(amp * left)
            tableR[offset + count] = Float(amp * right)
            count += 1
        }

        for (idx, n) in notes.enumerated() {
            let freq = 440.0 * pow(2.0, Double(n.0 - 69) / 12.0)
            let master = lowpassGain(freq, cutoff: 2400, qDb: 0.5)
            let x = (n.4 + 1) / 2
            let pl = cos(x * Double.pi / 2)
            let pr = sin(x * Double.pi / 2)
            let detunes: [Double] = n.3 > 0 ? [-n.3 / 2, n.3 / 2] : [0]
            for dt in detunes {
                let f = freq * pow(2.0, dt / 1200.0)
                add(freq: f, amp: n.1 * lowpassGain(f, cutoff: n.2, qDb: 0.4) * master, left: pl, right: pr)
            }
            if idx > 0 {
                let f2 = freq * 2
                let airCut = min(n.2 * 1.4, 3000)
                let amp = n.1 * 0.08 * lowpassGain(f2, cutoff: airCut, qDb: 0.4) * lowpassGain(f2, cutoff: 2400, qDb: 0.5)
                add(freq: f2, amp: amp, left: 1, right: 1)
            }
        }
        tableCount[t] = count
    }

    private func startPad(id: Int32, root: Int, minor: Bool) {
        guard root >= 0, root < 12 else { return }
        startPadSlot(id: id, t: root * 2 + (minor ? 1 : 0))
    }

    /// Starts the pad chord stored in table slot `t`.
    private func startPadSlot(id: Int32, t: Int) {
        guard t >= 0, t < SynthCore.tableSlots else { return }
        let v = allocateVoice()
        ageCounter += 1
        let slot = v * SynthCore.maxOsc
        let count = tableCount[t]
        for o in 0..<count {
            padPhase[slot + o] = 0
            padInc[slot + o] = tableInc[t * SynthCore.maxOsc + o]
            padAmpL[slot + o] = tableL[t * SynthCore.maxOsc + o]
            padAmpR[slot + o] = tableR[t * SynthCore.maxOsc + o]
        }
        var voice = SynthVoice()
        voice.active = true
        voice.id = id
        voice.isPad = true
        voice.env = 0
        voice.target = 0.48
        voice.attackInc = 0.48 / (0.08 * sr)
        voice.oscCount = count
        voice.age = ageCounter
        voices[v] = voice
    }

    func render(frames: Int, left: UnsafeMutablePointer<Float>, right: UnsafeMutablePointer<Float>) {
        drainCommands()
        for i in 0..<frames { left[i] = 0; right[i] = 0 }

        for v in 0..<SynthCore.maxVoices where voices[v].active {
            var voice = voices[v]
            if voice.isPad {
                let slot = v * SynthCore.maxOsc
                for i in 0..<frames {
                    var l: Float = 0, r: Float = 0
                    for o in 0..<voice.oscCount {
                        let s = sinf(Float(padPhase[slot + o]))
                        l += s * padAmpL[slot + o]
                        r += s * padAmpR[slot + o]
                        var ph = padPhase[slot + o] + padInc[slot + o]
                        if ph > 2 * Double.pi { ph -= 2 * Double.pi }
                        padPhase[slot + o] = ph
                    }
                    if voice.releasing {
                        voice.env *= voice.releaseMul
                        if voice.env < 0.0003 { voice.active = false; break }
                    } else if voice.env < voice.target {
                        voice.env = min(voice.target, voice.env + voice.attackInc)
                    }
                    left[i] += l * voice.env
                    right[i] += r * voice.env
                }
            } else {
                guard let bl = bankL[voice.bank], let br = bankR[voice.bank] else { voice.active = false; voices[v] = voice; continue }
                let total = bankFrames[voice.bank]
                for i in 0..<frames {
                    let i0 = Int(voice.pos)
                    if i0 + 1 >= total { voice.active = false; break }
                    let frac = Float(voice.pos - Double(i0))
                    var l = bl[i0] * (1 - frac) + bl[i0 + 1] * frac
                    var r = br[i0] * (1 - frac) + br[i0 + 1] * frac
                    if voice.panMode != 0 {
                        let il = l * voice.level, ir = r * voice.level
                        if voice.panMode == 1 { l = il + ir * voice.panL; r = ir * voice.panR }
                        else { l = il * voice.panL; r = ir + il * voice.panR }
                    }
                    voice.pos += voice.rate
                    if voice.loopEnd > 0 && voice.pos >= voice.loopEnd { voice.pos -= (voice.loopEnd - voice.loopStart) }
                    if voice.releasing {
                        voice.env *= voice.releaseMul
                        if voice.env < 0.0003 { voice.active = false; break }
                    } else if voice.env < voice.target {
                        voice.env = min(voice.target, voice.env + voice.attackInc)
                    }
                    left[i] += l * voice.env
                    right[i] += r * voice.env
                }
            }
            voices[v] = voice
        }

        // Master compressor (matches the Web Audio DynamicsCompressor settings used by the web piano,
        // including its automatic make-up gain of about +4.8 dB).
        let threshold: Float = -12, knee: Float = 8, ratio: Float = 3, makeup: Float = 1.74
        for i in 0..<frames {
            let level = max(abs(left[i]), abs(right[i]))
            detector += (level > detector ? attackCoef : releaseCoef) * (level - detector)
            let x = 20 * log10f(max(detector, 0.000001))
            var out = x
            if x > threshold + knee / 2 {
                out = threshold + (x - threshold) / ratio
            } else if x > threshold - knee / 2 {
                let t = x - threshold + knee / 2
                out = x + (1 / ratio - 1) * t * t / (2 * knee)
            }
            let g = powf(10, (out - x) / 20) * makeup
            // Soft ceiling instead of a hard clip: below 0.7 the signal passes untouched; above it curves smoothly towards 1,
            // so a loud chord is rounded off gently on the phone speaker instead of crackling.
            left[i] = softCeiling(left[i] * g)
            right[i] = softCeiling(right[i] * g)
        }
    }
}

@inline(__always) private func softCeiling(_ x: Float) -> Float {
    let knee: Float = 0.7
    let a = abs(x)
    if a <= knee { return x }
    let y = knee + (1 - knee) * tanhf((a - knee) / (1 - knee))
    return x < 0 ? -y : y
}

final class NativePianoSynth {
    static let shared = NativePianoSynth()

    private let core = SynthCore()
    private let engine = AVAudioEngine()
    private let control = DispatchQueue(label: "com.zong.piano.control", qos: .userInteractive)
    private var started = false

    private let sampleDefs: [(String, Int)] = [
        ("C2", 36), ("Ds2", 39), ("Fs2", 42), ("A2", 45),
        ("C3", 48), ("Ds3", 51), ("Fs3", 54), ("A3", 57),
        ("C4", 60), ("Ds4", 63), ("Fs4", 66), ("A4", 69),
    ]

    init() {
        control.async { [self] in
            core.buildPadTables()
            setupGraph()
            loadSamples()
            startEngine()
            observe()
        }
    }

    // MARK: Public (thread-safe)
    func noteOn(id: Int, midi: Int) {
        core.push(SynthCommand(type: 0, id: Int32(id), value: Int32(midi), flag: 0))
        ensureRunning()
    }

    func padOn(id: Int, root: Int, minor: Bool) {
        core.push(SynthCommand(type: 1, id: Int32(id), value: Int32(root), flag: minor ? 1 : 0))
        ensureRunning()
    }

    private var customSlot = 0

    /// A pad chord with arbitrary intervals (joystick chord piano). Same sound as padOn, more chord types.
    func padChordOn(id: Int, root: Int, third: Int, fifth: Int, octave: Int, extra: Int, bass: Int) {
        let slot = 24 + (customSlot % 8)
        customSlot += 1
        core.buildCustomPad(slot: slot, root: root, third: third, fifth: fifth, octave: octave, extra: extra, bass: bass)
        core.push(SynthCommand(type: 4, id: Int32(id), value: Int32(slot), flag: 0))
        ensureRunning()
    }

    /// True once the warm-pad samples (public/tones/pad_*.mp3) have been loaded; the app then plays pads from them.
    var padSamplesReady: Bool { core.hasPadSamples }

    /// One note of a warm-pad chord (all notes of a chord share `id`, so noteOff(id) releases them together).
    func padSampleOn(id: Int, midi: Int, gain: Double, pan: Double) {
        let packedPan = max(0, min(20, Int((pan * 10).rounded()) + 10))
        let packedGain = max(0, min(100, Int((gain * 100).rounded())))
        core.push(SynthCommand(type: 5, id: Int32(id), value: Int32(midi), flag: Int32(packedPan * 1000 + packedGain)))
        ensureRunning()
    }

    func noteOff(id: Int) { core.push(SynthCommand(type: 2, id: Int32(id), value: 0, flag: 0)) }
    func allOff() { core.push(SynthCommand(type: 3, id: 0, value: 0, flag: 0)) }

    // MARK: Engine
    private func setupGraph() {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: kSampleRate, channels: 2) else { return }
        let core = self.core
        let node = AVAudioSourceNode(format: format) { _, _, frameCount, bufferList -> OSStatus in
            let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
            guard buffers.count >= 2,
                  let l = buffers[0].mData?.assumingMemoryBound(to: Float.self),
                  let r = buffers[1].mData?.assumingMemoryBound(to: Float.self) else { return noErr }
            core.render(frames: Int(frameCount), left: l, right: r)
            return noErr
        }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
    }

    private func loadSamples() {
        guard let fmt = AVAudioFormat(standardFormatWithSampleRate: kSampleRate, channels: 2) else { return }
        for (name, midi) in sampleDefs {
            guard let url = Bundle.main.url(forResource: name, withExtension: "mp3", subdirectory: "public/tones") else {
                print("[NativePiano] sample not found: \(name).mp3")
                continue
            }
            do {
                let file = try AVAudioFile(forReading: url)
                guard let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { continue }
                try file.read(into: src)
                guard let converter = AVAudioConverter(from: src.format, to: fmt) else { continue }
                let ratio = kSampleRate / src.format.sampleRate
                let capacity = AVAudioFrameCount(Double(src.frameLength) * ratio) + 256
                guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: capacity) else { continue }
                var fed = false
                var error: NSError?
                converter.convert(to: out, error: &error) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return src
                }
                if let error = error { print("[NativePiano] convert error \(name): \(error)"); continue }
                guard let data = out.floatChannelData else { continue }
                let n = Int(out.frameLength)
                let l = UnsafeMutablePointer<Float>.allocate(capacity: n)
                let r = UnsafeMutablePointer<Float>.allocate(capacity: n)
                l.update(from: data[0], count: n)
                r.update(from: data[1], count: n)
                core.addSample(left: l, right: r, frames: n, midi: midi)
            } catch {
                print("[NativePiano] load error \(name): \(error)")
            }
        }
        loadPadSamples(fmt)
        print("[NativePiano] samples ready")
    }

    /// Warm-pad samples: one long note every three semitones (pad_<name>.mp3), looped while a chord is held. The loop
    /// region (3 s - 11 s) has its end blended into the material before its start so the seam never clicks.
    /// Missing files are skipped: without them the app keeps using the synthesised pad.
    private func loadPadSamples(_ fmt: AVAudioFormat) {
        let sr = Int(kSampleRate)
        for (name, midi) in sampleDefs {
            guard let url = Bundle.main.url(forResource: "pad_\(name)", withExtension: "mp3", subdirectory: "public/tones") else { continue }
            do {
                let file = try AVAudioFile(forReading: url)
                guard let src = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length)) else { continue }
                try file.read(into: src)
                guard let converter = AVAudioConverter(from: src.format, to: fmt) else { continue }
                let ratio = kSampleRate / src.format.sampleRate
                let capacity = AVAudioFrameCount(Double(src.frameLength) * ratio) + 256
                guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: capacity) else { continue }
                var fed = false
                var error: NSError?
                converter.convert(to: out, error: &error) { _, status in
                    if fed { status.pointee = .noDataNow; return nil }
                    fed = true
                    status.pointee = .haveData
                    return src
                }
                if error != nil { continue }
                guard let data = out.floatChannelData else { continue }
                let n = Int(out.frameLength)
                let loopStart = 3 * sr
                let loopEnd = min(11 * sr, n - 1)
                let xf = sr
                guard loopEnd - loopStart > 2 * xf, loopStart >= xf else { continue }
                let l = UnsafeMutablePointer<Float>.allocate(capacity: n)
                let r = UnsafeMutablePointer<Float>.allocate(capacity: n)
                l.update(from: data[0], count: n)
                r.update(from: data[1], count: n)
                for i in 0..<xf {
                    let t = Float(i) / Float(xf)
                    let wOut = cosf(t * Float.pi / 2)
                    let wIn = sinf(t * Float.pi / 2)
                    let a = loopEnd - xf + i
                    let b = loopStart - xf + i
                    l[a] = l[a] * wOut + l[b] * wIn
                    r[a] = r[a] * wOut + r[b] * wIn
                }
                core.addSample(left: l, right: r, frames: n, midi: midi, loopStart: loopStart, loopEnd: loopEnd)
            } catch {
                print("[NativePiano] pad load error \(name): \(error)")
            }
        }
        print("[NativePiano] pad samples: \(core.hasPadSamples ? "ready" : "none found")")
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
        try? session.setPreferredIOBufferDuration(0.005)
        try? session.setActive(true)
    }

    private func startEngine() {
        if engine.isRunning { started = true; return }
        activateSession()
        engine.prepare()
        do {
            try engine.start()
            started = true
        } catch {
            started = false
            print("[NativePiano] engine start error: \(error)")
        }
    }

    private func ensureRunning() {
        if engine.isRunning { return }
        control.async { [self] in startEngine() }
    }

    private func observe() {
        let nc = NotificationCenter.default
        nc.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil) { [weak self] _ in
            self?.control.async { self?.startEngine() }
        }
        nc.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: nil) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
            if type == .began { self?.core.push(SynthCommand(type: 3, id: 0, value: 0, flag: 0)) }
            else { self?.control.async { self?.startEngine() } }
        }
        // No audio work while the app is in the background (the metronome has its own engine).
        nc.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: nil) { [weak self] _ in
            self?.control.async {
                guard let self = self else { return }
                self.core.push(SynthCommand(type: 3, id: 0, value: 0, flag: 0))
                self.engine.pause()
            }
        }
        nc.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: nil) { [weak self] _ in
            self?.control.async { self?.startEngine() }
        }
    }
}
