import Cocoa
import WebKit
import Speech
import AVFoundation

final class SpeechBridge: NSObject, SFSpeechRecognizerDelegate {
    private var recognizer: SFSpeechRecognizer?
    private var audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private weak var webView: WKWebView?
    private var active = false
    private var contextWords: [String] = []
    private var lang = "ru-RU"

    init(webView: WKWebView) {
        self.webView = webView
        super.init()
    }

    func handle(_ body: [String: Any]) {
        let cmd = body["cmd"] as? String ?? ""
        if let l = body["lang"] as? String, !l.isEmpty { lang = l }
        if let ctx = body["context"] as? [String] { contextWords = ctx }
        switch cmd {
        case "start":
            start()
        case "stop":
            stop()
        case "restart":
            stop()
            start()
        default:
            break
        }
    }

    private func send(_ payload: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: payload),
              let json = String(data: data, encoding: .utf8) else { return }
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript("window.suflyorSpeech && window.suflyorSpeech(\(json));", completionHandler: nil)
        }
    }

    func start() {
        active = true
        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self = self, self.active else { return }
                guard status == .authorized else {
                    self.send(["error": "Нет доступа к распознаванию речи в Настройках macOS", "fatal": true])
                    return
                }
                self.beginSession()
            }
        }
    }

    func stop() {
        active = false
        task?.cancel()
        task = nil
        request?.endAudio()
        request = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }
    }

    private func beginSession() {
        task?.cancel()
        task = nil
        if audioEngine.isRunning {
            audioEngine.stop()
            audioEngine.inputNode.removeTap(onBus: 0)
        }

        let rec = SFSpeechRecognizer(locale: Locale(identifier: lang))
        recognizer = rec
        guard let rec = rec, rec.isAvailable else {
            send(["error": "Распознавание речи временно недоступно", "fatal": false])
            return
        }

        let req = SFSpeechAudioBufferRecognitionRequest()
        req.shouldReportPartialResults = true
        if !contextWords.isEmpty {
            req.contextualStrings = Array(contextWords.prefix(100))
        }
        let onDevice = rec.supportsOnDeviceRecognition
        if onDevice {
            req.requiresOnDeviceRecognition = true
        }
        request = req
        send(["reset": true, "onDevice": onDevice])

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak req] buffer, _ in
            req?.append(buffer)
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            send(["error": "Не удалось запустить микрофон для речи: \(error.localizedDescription)", "fatal": false])
            return
        }

        task = rec.recognitionTask(with: req) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.send(["text": result.bestTranscription.formattedString])
                if result.isFinal && self.active {
                    self.beginSession()
                }
            } else if let error = error, self.active {
                let ns = error as NSError
                // Ignore cancellation errors (203 / 216 / 1110)
                if ns.code != 203 && ns.code != 216 && ns.code != 1110 {
                    self.send(["log": "speech err \(ns.code): \(ns.localizedDescription)"])
                }
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var serverProc: Process?
    private var speech: SpeechBridge?
    private let port = Int(ProcessInfo.processInfo.environment["SUFLYOR_PORT"] ?? "8917") ?? 8917

    func applicationDidFinishLaunching(_ notification: Notification) {
        startServer()
        setupWindow()
        setupMenu()
        waitForServerAndLoad()
    }

    func applicationWillTerminate(_ notification: Notification) {
        speech?.stop()
        if let proc = serverProc, proc.isRunning {
            proc.terminate()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        return true
    }

    private func startServer() {
        let resDir = Bundle.main.resourcePath ?? ""
        let serverPath = (resDir as NSString).appendingPathComponent("suflyor/server.py")

        // Kill any stale suflyor/server.py on this port
        let killTask = Process()
        killTask.executableURL = URL(fileURLWithPath: "/bin/sh")
        killTask.arguments = ["-c", "for p in $(/usr/sbin/lsof -ti tcp:\(port) -sTCP:LISTEN 2>/dev/null); do /bin/ps -o args= -p $p | /usr/bin/grep -q 'suflyor/server.py' && kill $p; done"]
        try? killTask.run()
        killTask.waitUntilExit()

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        proc.arguments = [serverPath]
        var env = ProcessInfo.processInfo.environment
        env["SUFLYOR_PORT"] = String(port)
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        proc.environment = env
        try? proc.run()
        serverProc = proc
    }

    private func setupWindow() {
        let screenFrame = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let w = min(1180.0, screenFrame.width - 80.0)
        let h = min(780.0, screenFrame.height - 60.0)
        let rect = NSRect(
            x: screenFrame.midX - w / 2.0,
            y: screenFrame.midY - h / 2.0,
            width: w,
            height: h
        )

        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Суфлёр"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.backgroundColor = NSColor(calibratedRed: 17/255, green: 21/255, blue: 34/255, alpha: 1.0)
        window.minSize = NSSize(width: 820, height: 560)
        window.isReleasedWhenClosed = false

        let cfg = WKWebViewConfiguration()
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let ucc = cfg.userContentController
        ucc.add(self, name: "speech")
        ucc.add(self, name: "native")

        webView = WKWebView(frame: window.contentView!.bounds, configuration: cfg)
        webView.autoresizingMask = [.width, .height]
        webView.uiDelegate = self
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")

        speech = SpeechBridge(webView: webView)
        window.contentView?.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func setupMenu() {
        let mainMenu = NSMenu()
        let appItem = NSMenuItem()
        mainMenu.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "О программе Суфлёр", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Скрыть Суфлёр", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: "Выйти из Суфлёр", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Правка")
        editMenu.addItem(withTitle: "Отменить", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Повторить", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Вырезать", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Копировать", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Вставить", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Выбрать всё", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu

        let winItem = NSMenuItem()
        mainMenu.addItem(winItem)
        let winMenu = NSMenu(title: "Окно")
        winMenu.addItem(withTitle: "Свернуть", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        winMenu.addItem(withTitle: "Во весь экран", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
        winItem.submenu = winMenu

        NSApp.mainMenu = mainMenu
    }

    private func waitForServerAndLoad() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }
            let url = URL(string: "http://127.0.0.1:\(self.port)/")!
            for _ in 0..<80 {
                var req = URLRequest(url: url)
                req.timeoutInterval = 0.2
                let sem = DispatchSemaphore(value: 0)
                var ok = false
                URLSession.shared.dataTask(with: req) { _, resp, _ in
                    if let http = resp as? HTTPURLResponse, http.statusCode == 200 { ok = true }
                    sem.signal()
                }.resume()
                sem.wait()
                if ok {
                    DispatchQueue.main.async {
                        self.webView.load(URLRequest(url: url))
                    }
                    return
                }
                Thread.sleep(forTimeInterval: 0.04)
            }
            DispatchQueue.main.async {
                self.webView.load(URLRequest(url: url))
            }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        if message.name == "speech" {
            speech?.handle(body)
        }
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
