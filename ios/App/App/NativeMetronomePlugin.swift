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
        CAPPluginMethod(name: "start",          returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop",           returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setTempo",       returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBeatsPerBar", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setAccents",     returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setVolume",      returnType: CAPPluginReturnPromise),
    ]

    private lazy var engine = NativeMetronomeEngine()

    public override func load() {
        engine.onBeat = { [weak self] beatIndex in
            self?.notifyListeners("beat", data: ["beatIndex": beatIndex])
        }
        engine.onRemoteCommand = { [weak self] command in
            self?.notifyListeners("remoteCommand", data: ["command": command])
        }
    }

    @objc func start(_ call: CAPPluginCall) {
        let bpm         = call.getDouble("bpm")         ?? 120.0
        let beatsPerBar = call.getInt("beatsPerBar")    ?? 4
        // accents: array of "normal" | "accent" | "mute", length == beatsPerBar
        let accents     = call.getArray("accents") as? [String]
        engine.start(bpm: bpm, beatsPerBar: beatsPerBar, accents: accents)
        call.resolve()
    }

    @objc func stop(_ call: CAPPluginCall) {
        engine.stop()
        call.resolve()
    }

    @objc func setTempo(_ call: CAPPluginCall) {
        guard let bpm = call.getDouble("bpm") else { call.reject("bpm required"); return }
        engine.setTempo(bpm: bpm)
        call.resolve()
    }

    @objc func setBeatsPerBar(_ call: CAPPluginCall) {
        guard let beats = call.getInt("beatsPerBar") else { call.reject("beatsPerBar required"); return }
        let accents = call.getArray("accents") as? [String]
        engine.setBeatsPerBar(beats, accents: accents)
        call.resolve()
    }

    @objc func setAccents(_ call: CAPPluginCall) {
        guard let accents = call.getArray("accents") as? [String] else { call.reject("accents required"); return }
        engine.setAccents(accents)
        call.resolve()
    }

    @objc func setVolume(_ call: CAPPluginCall) {
        let volume = call.getDouble("volume") ?? 1.0
        engine.setVolume(Float(volume))
        call.resolve()
    }
}
