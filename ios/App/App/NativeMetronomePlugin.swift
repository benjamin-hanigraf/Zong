import AVFoundation
import Capacitor
import MediaPlayer

// ============================================================
// NativeMetronomePlugin — local Capacitor plugin (Capacitor 7/8)
// Registered automatically because it is compiled into the App target.
// ============================================================

@objc(NativeMetronomePlugin)
public class NativeMetronomePlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeMetronomePlugin"
    public let jsName = "NativeMetronome"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start",    returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "update",   returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
    ]

    private lazy var engine = NativeMetronomeEngine()

    public override func load() {
        // Touching `engine` here creates it at launch, so audio is ready before the first tap.
        engine.onBeat = { [weak self] beatIndex in
            self?.notifyListeners("beat", data: ["beatIndex": beatIndex])
        }
        // The engine is the source of truth for "playing"; JS mirrors this event.
        engine.onState = { [weak self] playing in
            self?.notifyListeners("state", data: ["playing": playing])
        }
    }

    private func settings(_ call: CAPPluginCall) -> (bpm: Double, beats: Int, accents: [String]?, sub: Int) {
        (call.getDouble("bpm") ?? 120.0,
         call.getInt("beatsPerBar") ?? 4,
         call.getArray("accents") as? [String],
         call.getInt("subdivision") ?? 1)
    }

    @objc func start(_ call: CAPPluginCall) {
        let s = settings(call)
        engine.start(bpm: s.bpm, beatsPerBar: s.beats, accents: s.accents, subdivision: s.sub)
        call.resolve()
    }

    @objc func update(_ call: CAPPluginCall) {
        let s = settings(call)
        engine.update(bpm: s.bpm, beatsPerBar: s.beats, accents: s.accents, subdivision: s.sub)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        engine.stop()
        call.resolve()
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = call.getDouble("volume") ?? 1.0
        engine.setVolume(Float(volume))
        call.resolve()
    }

    @objc func getState(_ call: CAPPluginCall) {
        engine.queryState { playing in call.resolve(["playing": playing]) }
    }
}
