// The Dock app: one window showing the engine's local page. All the logic lives in the engine,
// so updating Peeraxis never needs this app rebuilt.
import AppKit
import WebKit

let pageURL = URL(string: "http://127.0.0.1:4477/")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate {
  var window: NSWindow!
  var web: WKWebView!

  func applicationDidFinishLaunching(_ notification: Notification) {
    web = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
    web.navigationDelegate = self
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1100, height: 820),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Peeraxis"
    window.contentView = web
    window.setFrameAutosaveName("PeeraxisMain")
    window.center()
    window.makeKeyAndOrderFront(nil)
    buildMenu()
    web.load(URLRequest(url: pageURL))
  }

  // If the engine is still starting, show a plain line and try again shortly.
  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    webView.loadHTMLString(
      "<body style='font:15px -apple-system;color:#6e6e73;display:grid;place-items:center;height:90vh'>Peeraxis is starting…</body>",
      baseURL: nil)
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { webView.load(URLRequest(url: pageURL)) }
  }

  // Links that leave the local page open in the browser.
  func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
    if let url = action.request.url, url.host != "127.0.0.1", url.scheme?.hasPrefix("http") == true {
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    } else {
      decisionHandler(.allow)
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

  @objc func reload() { web.load(URLRequest(url: pageURL)) }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit Peeraxis", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu
    main.addItem(appItem)
    let viewItem = NSMenuItem()
    let viewMenu = NSMenu(title: "View")
    viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
    viewItem.submenu = viewMenu
    main.addItem(viewItem)
    let editItem = NSMenuItem()
    let editMenu = NSMenu(title: "Edit")
    for (title, sel, key) in [("Cut", #selector(NSText.cut(_:)), "x"), ("Copy", #selector(NSText.copy(_:)), "c"),
                              ("Paste", #selector(NSText.paste(_:)), "v"), ("Select All", #selector(NSText.selectAll(_:)), "a")] {
      editMenu.addItem(withTitle: title, action: sel, keyEquivalent: key)
    }
    editItem.submenu = editMenu
    main.addItem(editItem)
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
