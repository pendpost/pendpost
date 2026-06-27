// PendpostApp.swift - the native macOS app inside "pendpost.app".
//
// A minimal AppKit + WKWebView wrapper that makes pendpost a REAL app: its own
// Dock icon, menu bar ("pendpost"), Cmd-Tab entry, and a window hosting the local
// dashboard at http://127.0.0.1:8090. It stays open while the window is open and
// quits when the window closes - the BACKGROUND launchd agent (the Node server +
// scheduler) is independent and keeps running, so closing the window never stops
// publishing.
//
// On launch it ALWAYS restarts the agent (same contract as launcher.sh): a click
// `launchctl kickstart -k`s the server so it picks up the latest backend code AND
// re-runs serve.sh's staleness-gated dashboard rebuild. A still-answering but STALE
// server is exactly why a plain health check is not enough (healthy != current) - the
// missing "enable always-on" button was a Saturday server that never restarted. It
// falls back to install.sh if the agent was never installed, then loads once healthy.
//
// __REPO__ is substituted by install.sh at build time (for the install.sh fallback).
// Compiled at install with: swiftc -O -framework Cocoa -framework WebKit.

import Cocoa
import WebKit

let kURL = "http://127.0.0.1:8090"
let kLabel = "pendpost"
let kRepoRoot = "__REPO__"

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var webView: WKWebView!

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

        ensureServerThenLoad()
    }

    // Closing the window quits the app; the launchd agent (server) outlives it.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    @objc func reload() { webView.reload() }

    // ---- self-heal: ALWAYS restart the server on launch, then load once healthy ----
    func ensureServerThenLoad() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            // Restart unconditionally so clicking the Dock icon picks up the latest
            // backend code AND triggers the staleness-gated dashboard rebuild - a
            // still-answering but STALE server is the bug this avoids (healthy != current).
            self.heal()
            for _ in 0..<40 { // wait up to ~10s for the fresh server to bind
                if self.healthy() { break }
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async { self.load() }
        }
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

    func heal() {
        let uid = String(getuid())
        // kickstart -k restarts a RUNNING agent (the normal path). A non-zero status
        // means the agent was never installed - key the install.sh fallback off THAT,
        // not a post-restart health probe, so a server that is merely slow to rebind
        // never triggers a spurious reinstall.
        if run("/bin/launchctl", ["kickstart", "-k", "gui/\(uid)/\(kLabel)"]) != 0 {
            run("/bin/bash", ["\(kRepoRoot)/install.sh"]) // agent never installed
        }
    }

    @discardableResult
    func run(_ path: String, _ args: [String]) -> Int32 {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: path)
        p.arguments = args
        do { try p.run() } catch { return -1 }
        p.waitUntilExit()
        return p.terminationStatus
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

    // ---- a standard menu bar (so Cmd-Q / copy-paste / reload work) ----
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
