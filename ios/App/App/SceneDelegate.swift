import UIKit
import Capacitor
import WebKit

/// Bridge controller that:
///  • locks iPhones to portrait (iPads rotate freely, per the device setting),
///  • keeps the web view fully black and edge-to-edge so no hairline shows at the top.
class ZongBridgeViewController: CAPBridgeViewController {
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return UIDevice.current.userInterfaceIdiom == .phone ? .portrait : .all
    }

    override var shouldAutorotate: Bool { return true }

    override var preferredStatusBarStyle: UIStatusBarStyle { return .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        applyEdgeToEdgeWebView()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        applyEdgeToEdgeWebView()
    }

    private func applyEdgeToEdgeWebView() {
        guard let webView = self.webView else { return }
        view.backgroundColor = .black
        webView.isOpaque = false
        webView.backgroundColor = .black
        if #available(iOS 15.0, *) { webView.underPageBackgroundColor = .black }
        let sv = webView.scrollView
        sv.backgroundColor = .black
        sv.contentInsetAdjustmentBehavior = .never
        sv.contentInset = .zero
        sv.scrollIndicatorInsets = .zero
        sv.bounces = false
        sv.showsVerticalScrollIndicator = false
        sv.showsHorizontalScrollIndicator = false
        if webView.frame != view.bounds { webView.frame = view.bounds }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        let bridgeVC = ZongBridgeViewController()
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
