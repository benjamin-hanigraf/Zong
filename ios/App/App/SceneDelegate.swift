import UIKit
import Capacitor
import WebKit

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let bridgeVC = CAPBridgeViewController()
        window = UIWindow(windowScene: windowScene)
        // Extend the window edge-to-edge so no gap appears under the status bar.
        window?.backgroundColor = .black
        window?.rootViewController = bridgeVC
        window?.makeKeyAndVisible()

        // Remove the 1-pt separator line that iOS inserts at the top of WKWebView.
        // We do this after the window is visible so the webView is already in the hierarchy.
        DispatchQueue.main.async {
            self.removeWebViewTopInset(in: bridgeVC.view)
        }

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    /// Walk the view hierarchy to find the WKWebView and disable its scroll-view
    /// content-inset adjustment, which is the root cause of the thin top line.
    private func removeWebViewTopInset(in root: UIView) {
        for subview in root.subviews {
            if let webView = subview as? WKWebView {
                webView.scrollView.contentInsetAdjustmentBehavior = .never
                webView.scrollView.contentInset = .zero
                webView.scrollView.scrollIndicatorInsets = .zero
                // Ensure the webView frame fills the entire window including
                // the area behind the status bar.
                webView.frame = root.bounds
                webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
                return
            }
            removeWebViewTopInset(in: subview)
        }
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
