// PendpostApp.swift - the native macOS app inside the SHIPPED "pendpost.app".
//
// This is the BUNDLED-MODE launcher (distinct from launcher/PendpostApp.swift,
// which targets a developer's git clone + system node + launchd agent). Here
// everything is self-contained: a pinned Node and the pendpost file set live in
// Contents/Resources/runtime, and there is no toolchain on the user's machine.
//
// A minimal AppKit + WKWebView wrapper that makes pendpost a REAL app (Dock icon,
// menu bar, Cmd-Tab) hosting the local dashboard at http://127.0.0.1:8090. On
// launch it spawns the bundled server as a CHILD process, waits for it to answer,
// then loads the window. v1 is app-lifetime: quitting the app terminates the
// server (the README documents an optional LaunchAgent as the always-on follow-on).
//
// Compiled (universal) by packaging/desktop/macos/build-app.sh with:
//   swiftc -O -framework Cocoa -framework WebKit
import Cocoa
import WebKit

let kURL = "http://127.0.0.1:8090"
let kPort = "8090"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var server: Process?

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular) // a normal app: Dock icon + menu bar + Cmd-Tab
        buildMenu()

        let frame = NSRect(x: 0, y: 0, width: 1280, height: 860)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "pendpost"
        window.center()
        window.setFrameAutosaveName("pendpostMainWindow") // remember size/position

        webView = WKWebView(frame: frame, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = self
        webView.uiDelegate = self // so target="_blank" / window.open route to the system browser
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        startServerThenLoad()
    }

    // Closing the window quits the app.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // v1 is app-lifetime: stop the bundled server when the app quits so no orphan
    // process lingers. (Always-on is the optional LaunchAgent follow-on.)
    func applicationWillTerminate(_ note: Notification) {
        server?.terminate()
    }

    @objc func reload() { webView.reload() }

    // ---- bundle paths -------------------------------------------------------
    var resourcePath: String { Bundle.main.resourcePath ?? "" }
    var nodeBin: String { resourcePath + "/runtime/node" }
    var startScript: String { resourcePath + "/runtime/scripts/desktop-start.mjs" }
    var runtimeDir: String { resourcePath + "/runtime" }

    // The per-user, WRITABLE workspace. The bundle is read-only; all state lives
    // here (PENDPOST_ROOT) - see lib/util.mjs WORKSPACE_ROOT.
    func workspaceRoot() -> String {
        let fm = FileManager.default
        let base = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        let dir = base?.appendingPathComponent("pendpost").path
            ?? (NSHomeDirectory() + "/Library/Application Support/pendpost")
        try? fm.createDirectory(atPath: dir, withIntermediateDirectories: true)
        return dir
    }

    // ---- start the bundled server, then load the window ---------------------
    func startServerThenLoad() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            // If a server is already answering (a second launch, or `npx pendpost`
            // already running), reuse it instead of fighting for the port.
            if !self.healthy() { self.startServer() }
            for _ in 0..<80 { // wait up to ~20s for first-run seed + boot
                if self.healthy() { break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async { self.load() }
        }
    }

    func startServer() {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: nodeBin)
        p.arguments = [startScript]
        var env = ProcessInfo.processInfo.environment
        env["PENDPOST_ROOT"] = workspaceRoot()
        env["PENDPOST_PORT"] = kPort
        p.environment = env
        p.currentDirectoryURL = URL(fileURLWithPath: runtimeDir)
        do { try p.run(); server = p } catch { NSLog("pendpost: failed to start server: \(error)") }
    }

    func load() {
        if let u = URL(string: kURL) { webView.load(URLRequest(url: u)) }
    }

    func healthy() -> Bool {
        guard let u = URL(string: kURL + "/api/health") else { return false }
        var req = URLRequest(url: u)
        req.timeoutInterval = 1.5
        let sem = DispatchSemaphore(value: 0)
        var ok = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse, http.statusCode == 200 { ok = true }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return ok
    }

    // If the server is still binding when we first load, retry once shortly.
    func webView(_ wv: WKWebView, didFailProvisionalNavigation nav: WKNavigation!, withError error: Error) {
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) { [weak self] in self?.load() }
    }

    // Open external links in the system browser, not inside the app shell. The dashboard
    // lives on the loopback (127.0.0.1); a MAIN-FRAME navigation to any other http(s) host
    // (the marketing site, docs, Stripe) is handed to NSWorkspace and cancelled here. A
    // target="_blank" link has a nil targetFrame and is handled by createWebViewWith below
    // (so it is not opened twice). In-app SPA route changes are pushState, not navigations,
    // so they never reach this method.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url, let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow); return
        }
        let host = url.host ?? ""
        let isLoopback = host == "127.0.0.1" || host == "localhost"
        if let frame = navigationAction.targetFrame, frame.isMainFrame,
           (scheme == "http" || scheme == "https"), !isLoopback {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // A target="_blank" / window.open never spawns an in-app window: open the url in the
    // system browser and return nil (no child WKWebView).
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    // ---- a standard menu bar (so Cmd-Q / copy-paste / reload work) ----------
    func buildMenu() {
        let mainMenu = NSMenu()

        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About pendpost", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide pendpost", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Quit pendpost", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let viewItem = NSMenuItem()
        mainMenu.addItem(viewItem)
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewItem.submenu = viewMenu

        NSApp.mainMenu = mainMenu
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
