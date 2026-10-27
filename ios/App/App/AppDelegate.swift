import UIKit
import AVFoundation
import Capacitor

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default)
        // Activating the session can block, so keep it off the main thread.
        DispatchQueue.global(qos: .userInitiated).async { try? AVAudioSession.sharedInstance().setActive(true) }
        // Lock-screen Live Activity buttons run in this process and drive the shared engine.
        MetronomeIntentBridge.handler = { NativeMetronomeEngine.shared.handle($0) }
        return true
    }

    // Phones are always portrait regardless of the rotation-lock setting;
    // iPads follow the device's rotation settings.
    func application(_ application: UIApplication, supportedInterfaceOrientationsFor window: UIWindow?) -> UIInterfaceOrientationMask {
        return UIDevice.current.userInterfaceIdiom == .phone ? .portrait : .all
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
