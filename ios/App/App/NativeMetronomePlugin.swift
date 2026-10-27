import Capacitor

// ============================================================
// NativeMetronomePlugin — local Capacitor plugin (Capacitor 7/8)
// Registered explicitly in ZongBridgeViewController.capacitorDidLoad (SceneDelegate.swift).
// ============================================================

@objc(NativeMetronomePlugin)
public class NativeMetronomePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMetronomePlugin"
    public let jsName = "NativeMetronome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        // Piano / pad chord voices (rendered natively so they ignore the silent switch)
        CAPPluginMethod(name: "pianoNoteOn",  returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "padOn",        returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pianoNoteOff", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pianoAllOff",  returnType: CAPPluginReturnPromise),
    ]

    private let engine = NativeMetronomeEngine.shared

    public override func load() {
        _ = NativePianoSynth.shared   // load samples and start the piano engine at launch
        // Touching `engine` here creates it at launch, so audio is ready before the first tap.
        engine.onBeat = { [weak self] beatIndex in
            self?.notifyListeners("beat", data: ["beatIndex": beatIndex])
        }
        // The engine is the source of truth for "playing"; JS mirrors this event.
        engine.onState = { [weak self] playing in
            self?.notifyListeners("state", data: ["playing": playing])
        }
        // Tempo changed from the lock-screen +/- buttons.
        engine.onTempo = { [weak self] bpm in
            self?.notifyListeners("tempo", data: ["bpm": bpm])
        }
        if #available(iOS 16.2, *) { MetronomeLiveActivity.shared.endStale() }
    }

    private func settings(_ call: CAPPluginCall) -> (bpm: Double, beats: Int, accents: [String]?, sub: Int, title: String?) {
        (call.getDouble("bpm") ?? 120.0,
         call.getInt("beatsPerBar") ?? 4,
         call.getArray("accents") as? [String],
         call.getInt("subdivision") ?? 1,
         call.getString("title"))
    }

    @objc func start(_ call: CAPPluginCall) {
        let s = settings(call)
        engine.start(bpm: s.bpm, beatsPerBar: s.beats, accents: s.accents, subdivision: s.sub, title: s.title) { playing in
            call.resolve(["playing": playing])
        }
    }

    @objc func update(_ call: CAPPluginCall) {
        let s = settings(call)
        engine.update(bpm: s.bpm, beatsPerBar: s.beats, accents: s.accents, subdivision: s.sub, title: s.title)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        engine.stop { playing in call.resolve(["playing": playing]) }
    }

    @objc func getState(_ call: CAPPluginCall) {
        engine.queryState { playing, bpm in call.resolve(["playing": playing, "bpm": bpm]) }
    }

    @objc func pianoNoteOn(_ call: CAPPluginCall) {
        NativePianoSynth.shared.noteOn(id: call.getInt("id") ?? 0, midi: call.getInt("midi") ?? 60)
        call.resolve()
    }

    @objc func padOn(_ call: CAPPluginCall) {
        NativePianoSynth.shared.padOn(id: call.getInt("id") ?? 0, root: call.getInt("root") ?? 0, minor: call.getBool("minor") ?? false)
        call.resolve()
    }

    @objc func pianoNoteOff(_ call: CAPPluginCall) {
        NativePianoSynth.shared.noteOff(id: call.getInt("id") ?? 0)
        call.resolve()
    }

    @objc func pianoAllOff(_ call: CAPPluginCall) {
        NativePianoSynth.shared.allOff()
        call.resolve()
    }
}
