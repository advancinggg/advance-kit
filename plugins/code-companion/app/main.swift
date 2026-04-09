import AppKit
import SwiftUI
import Network
// AVFoundation removed — using NSSound (AppKit) for safe audio playback

// MARK: - Data Model

enum SessionStatus: String {
    case active
    case waiting
    case done
}

struct AgentEvent: Identifiable {
    let id = UUID()
    let type: String
    let toolName: String?
    let message: String?
    let timestamp: Date
}

final class AgentSession: Identifiable, ObservableObject {
    let id: String
    let source: String
    let projectDir: String
    @Published var status: SessionStatus
    @Published var lastEvent: AgentEvent
    @Published var events: [AgentEvent]
    let startedAt: Date
    @Published var updatedAt: Date

    // In-app approval support
    var decisionID: String           // unique ID for bridge to poll
    @Published var decision: String? // nil=pending, "allow", "deny", "terminal", "dismissed"
    var toolDescription: String = "" // human-readable action description (e.g. "Bash: npm test")
    var terminalPID: Int = 0         // the terminal shell PID
    var terminalTTY: String = ""     // the terminal TTY device (e.g. "/dev/ttys004")
    var terminalApp: String = ""     // terminal app type (e.g. "iterm2", "vscode", "ghostty")

    // Enhanced context
    @Published var recentPrompt: String?                   // last user prompt for context
    var permissionSuggestionsRaw: [[String: Any]] = []     // raw permission suggestions from event

    private static let genericDirNames: Set<String> = [
        "app", "src", "lib", "web", "api", "cmd", "pkg", "bin", "dist", "build", "test", "tests", "main"
    ]
    var projectName: String {
        let last = (projectDir as NSString).lastPathComponent
        if Self.genericDirNames.contains(last.lowercased()) {
            let parent = ((projectDir as NSString).deletingLastPathComponent as NSString).lastPathComponent
            return "\(parent)/\(last)"
        }
        return last
    }

    /// Derive a short session title from the first user prompt
    var sessionTitle: String? {
        guard let prompt = recentPrompt, !prompt.isEmpty else { return nil }
        // Take first line, truncate to ~40 chars
        let firstLine = prompt.components(separatedBy: .newlines).first ?? prompt
        let clean = firstLine.trimmingCharacters(in: .whitespaces)
        if clean.count > 40 {
            return String(clean.prefix(38)) + "…"
        }
        return clean
    }

    var abbreviatedDir: String {
        let home = NSHomeDirectory()
        if projectDir.hasPrefix(home) {
            return "~" + projectDir.dropFirst(home.count)
        }
        return projectDir
    }

    var terminalAppLabel: String {
        switch terminalApp.lowercased() {
        case "vscode": return "VS Code"
        case "cursor": return "Cursor"
        case "antigravity": return "Antigravity"
        case "iterm2": return "iTerm2"
        case "terminal": return "Terminal"
        case "ghostty": return "Ghostty"
        default: return terminalApp.isEmpty ? "" : terminalApp
        }
    }

    var sourceLabel: String {
        switch source.lowercased() {
        case "claude": return "Claude"
        case "codex": return "Codex"
        case "gemini": return "Gemini"
        default: return source
        }
    }

    var isPermissionRequest: Bool { lastEvent.type == "PermissionRequest" }
    var isStop: Bool { lastEvent.type == "Stop" }

    var permissionDescription: String? {
        guard let first = permissionSuggestionsRaw.first,
              let rules = first["rules"] as? [[String: Any]],
              let dest = first["destination"] as? String else { return nil }
        let toolNames = rules.compactMap { $0["toolName"] as? String }.joined(separator: ", ")
        let destLabel: String
        switch dest {
        case "session": destLabel = "session"
        case "localSettings": destLabel = "local"
        case "projectSettings": destLabel = "project"
        case "userSettings": destLabel = "user"
        default: destLabel = dest
        }
        return toolNames.isEmpty ? nil : "\(toolNames) (\(destLabel))"
    }

    init(id: String, source: String, projectDir: String, event: AgentEvent,
         decisionID: String = UUID().uuidString, toolDescription: String = "") {
        self.id = id
        self.source = source
        self.projectDir = projectDir
        self.status = .active
        self.lastEvent = event
        self.events = [event]
        self.startedAt = Date()
        self.updatedAt = Date()
        self.decisionID = decisionID
        self.toolDescription = toolDescription
    }
}

// MARK: - Incoming Event (JSON)

struct ToolInput: Decodable {
    let command: String?
    let file_path: String?
    let description: String?
}

struct IncomingEvent: Decodable {
    let session_id: String?
    let hook_event_name: String?
    let tool_name: String?
    let message: String?
    let cwd: String?
    let notification_type: String?
    let title: String?
    let tool_input: ToolInput?
    let terminal_pid: Int?
    let terminal_tty: String?
    let terminal_app: String?
    let prompt: String?           // user's prompt (UserPromptSubmit events)
    let stop_reason: String?      // why session stopped (Stop events)
}

func toolDescriptionFrom(toolName: String?, toolInput: ToolInput?) -> String {
    guard let name = toolName else { return "" }
    switch name {
    case "Bash":
        if let cmd = toolInput?.command {
            let short = cmd.count > 60 ? String(cmd.prefix(57)) + "..." : cmd
            return "Bash: \(short)"
        }
        return toolInput?.description ?? "Bash"
    case "Edit", "Write", "Read":
        if let path = toolInput?.file_path {
            return "\(name): \((path as NSString).lastPathComponent)"
        }
        return name
    default:
        return name
    }
}

// MARK: - Notification Sound

struct NotificationSound {
    private static var isPlaying = false

    /// Generate and play a gentle ascending chime using raw Core Audio
    static func play() {
        guard !isPlaying else { return }
        isPlaying = true

        DispatchQueue.global(qos: .userInitiated).async {
            defer { isPlaying = false }

            // Generate WAV in memory: 4-note ascending arpeggio
            let sampleRate: Double = 44100
            // Marimba/xylophone — warm wooden mallet strike
            // Rich harmonics with fast decay, pentatonic melody
            let notes: [(freq: Double, dur: Double, gap: Double)] = [
                (784.0, 0.12, 0.05),    // G5
                (880.0, 0.12, 0.05),    // A5
                (1175.0, 0.14, 0.06),   // D6
                (880.0, 0.10, 0.04),    // A5 (bounce)
                (1318.5, 0.10, 0.04),   // E6
                (1568.0, 0.18, 0.0),    // G6 (ring out)
            ]
            let totalDuration = notes.reduce(0.0) { $0 + $1.dur + $1.gap } + 0.15
            let totalSamples = Int(totalDuration * sampleRate)
            var pcm = [Int16](repeating: 0, count: totalSamples)

            var offset = 0
            for note in notes {
                let count = Int(note.dur * sampleRate)
                for j in 0..<count where (offset + j) < totalSamples {
                    let t = Double(j) / sampleRate
                    let f = note.freq
                    // Marimba timbre: fundamental + detuned harmonics that decay faster
                    let h1 = sin(2.0 * .pi * f * t)                      // fundamental
                    let h2 = sin(2.0 * .pi * f * 4.0 * t) * exp(-t * 25) * 0.3  // 4th harmonic, fast decay
                    let h3 = sin(2.0 * .pi * f * 10.0 * t) * exp(-t * 50) * 0.15 // high transient (mallet click)
                    // Envelope: sharp attack, medium exponential decay
                    let env = exp(-t * 8) * min(t / 0.001, 1.0)
                    let sample = (h1 + h2 + h3) * env * 0.35
                    pcm[offset + j] = Int16(max(-32767, min(32767, sample * 32767)))
                }
                offset += count + Int(note.gap * sampleRate)
            }

            // Build WAV file in memory
            var wav = Data()
            let dataSize = UInt32(totalSamples * 2)
            let fileSize = UInt32(36 + dataSize)

            func appendUInt32(_ v: UInt32) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 4)) }
            func appendUInt16(_ v: UInt16) { var x = v.littleEndian; wav.append(Data(bytes: &x, count: 2)) }

            wav.append("RIFF".data(using: .ascii)!)
            appendUInt32(fileSize)
            wav.append("WAVE".data(using: .ascii)!)
            wav.append("fmt ".data(using: .ascii)!)
            appendUInt32(16)           // chunk size
            appendUInt16(1)            // PCM
            appendUInt16(1)            // mono
            appendUInt32(UInt32(sampleRate))
            appendUInt32(UInt32(sampleRate) * 2)  // byte rate
            appendUInt16(2)            // block align
            appendUInt16(16)           // bits per sample
            wav.append("data".data(using: .ascii)!)
            appendUInt32(dataSize)
            pcm.withUnsafeBufferPointer { wav.append(Data(buffer: $0)) }

            // Play via NSSound (safe, no special permissions needed)
            DispatchQueue.main.async {
                if let sound = NSSound(data: wav) {
                    sound.volume = 0.4
                    sound.play()
                }
            }
        }
    }
}

// MARK: - Terminal Detector (AppleScript + Extension)

struct TerminalDetector {
    enum TerminalApp {
        case vscodeFamily
        case iterm2
        case terminalApp
        case ghostty
        case unknown
    }

    static let vscodeFamilyBundleIDs: Set<String> = [
        "com.microsoft.VSCode", "com.google.antigravity", "com.todesktop.230313mzl4w4u92",
    ]
    static let standaloneBundleIDs: [String: TerminalApp] = [
        "com.googlecode.iterm2": .iterm2,
        "com.apple.Terminal": .terminalApp,
        "com.mitchellh.ghostty": .ghostty,
    ]
    static let allBundleIDs: Set<String> = {
        var s = vscodeFamilyBundleIDs
        for k in standaloneBundleIDs.keys { s.insert(k) }
        return s
    }()

    static func classify(_ bundleID: String) -> TerminalApp {
        if vscodeFamilyBundleIDs.contains(bundleID) { return .vscodeFamily }
        return standaloneBundleIDs[bundleID] ?? .unknown
    }

    // MARK: Cache (500ms TTL to avoid repeated AppleScript calls)
    private static var _cache: (key: String, result: Bool, time: Date)?
    private static let _cacheLock = NSLock()

    /// Is this terminal the one currently receiving keyboard input?
    /// Bias toward false (show notification) — never suppress when uncertain.
    static func isActive(terminalPID: Int, terminalTTY: String, projectDir: String) -> Bool {
        // 1. Get frontmost app on main thread
        var frontBundleID: String?
        if Thread.isMainThread {
            frontBundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
        } else {
            DispatchQueue.main.sync {
                frontBundleID = NSWorkspace.shared.frontmostApplication?.bundleIdentifier
            }
        }
        guard let bid = frontBundleID, allBundleIDs.contains(bid) else {
            fputs("  TerminalDetector: frontApp=\(frontBundleID ?? "nil") not a known terminal\n", stderr)
            return false
        }

        // 2. Check cache (thread-safe)
        let cacheKey = "\(bid):\(terminalPID):\(terminalTTY):\(projectDir)"
        _cacheLock.lock()
        if let c = _cache, c.key == cacheKey, Date().timeIntervalSince(c.time) < 0.5 {
            _cacheLock.unlock()
            return c.result
        }
        _cacheLock.unlock()

        // 3. Dispatch to per-terminal checker
        let result: Bool
        switch classify(bid) {
        case .vscodeFamily:
            result = isActiveInVSCodeFamily(terminalPID: terminalPID, projectDir: projectDir)
        case .iterm2:
            result = isActiveInITerm2(tty: terminalTTY)
        case .terminalApp:
            result = isActiveInTerminalApp(tty: terminalTTY)
        case .ghostty:
            result = isActiveInGhostty(projectDir: projectDir)
        case .unknown:
            result = false
        }

        fputs("  TerminalDetector: bid=\(bid) type=\(classify(bid)) result=\(result)\n", stderr)
        _cacheLock.lock()
        _cache = (cacheKey, result, Date())
        _cacheLock.unlock()
        return result
    }

    // MARK: VS Code family — query extension API
    //
    // Note: VS Code API cannot reliably detect if the terminal panel has keyboard focus
    // (onDidChangeActiveTerminal doesn't fire when focus returns to the SAME terminal).
    // So we use a simpler check: VS Code is frontmost + activeTerminal PID matches.
    // This means notifications are suppressed when the user can see the terminal output,
    // even if the editor pane has focus. This is acceptable because the user is already
    // looking at VS Code and can see the terminal.
    private static func isActiveInVSCodeFamily(terminalPID: Int, projectDir: String) -> Bool {
        guard let port = ExtensionRegistry.findPort(for: projectDir) else {
            fputs("  VSCode: no extension port for \(projectDir)\n", stderr)
            return false
        }
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/status")!)
        req.timeoutInterval = 0.5
        var isActive = false
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            defer { sem.signal() }
            guard let data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

            // Check THIS VS Code window is focused (not another VS Code window)
            guard let windowFocused = json["windowFocused"] as? Bool, windowFocused else {
                fputs("  VSCode: windowFocused=false (different VS Code window is active)\n", stderr)
                return
            }

            // Check active terminal PID matches
            guard let activeTerminal = json["activeTerminal"] as? [String: Any],
                  let activePID = activeTerminal["pid"] as? Int else { return }

            fputs("  VSCode: windowFocused=true activePID=\(activePID) vs \(terminalPID) match=\(activePID == terminalPID)\n", stderr)
            isActive = (activePID == terminalPID)
        }.resume()
        _ = sem.wait(timeout: .now() + 0.5)
        return isActive
    }

    // MARK: Terminal.app — AppleScript via osascript
    private static func isActiveInTerminalApp(tty: String) -> Bool {
        guard !tty.isEmpty else { return false }
        // Static script — no user input embedded
        let script = "tell application \"Terminal\" to return tty of selected tab of front window"
        guard let result = runOsascript(script) else { return false }
        return result == tty
    }

    // MARK: iTerm2 — AppleScript via osascript
    private static func isActiveInITerm2(tty: String) -> Bool {
        guard !tty.isEmpty else { return false }
        let script = "tell application \"iTerm2\" to return tty of current session of current window"
        guard let result = runOsascript(script) else { return false }
        return result == tty
    }

    // MARK: Ghostty — AppleScript via osascript (cwd match, no tty available)
    private static func isActiveInGhostty(projectDir: String) -> Bool {
        guard !projectDir.isEmpty else { return false }
        let script = """
        tell application "Ghostty"
            return working directory of focused terminal of selected tab of front window
        end tell
        """
        guard let result = runOsascript(script) else { return false }
        return pathsRelated(result, projectDir)
    }

    // MARK: osascript runner with timeout and error handling
    @discardableResult
    static func runOsascript(_ script: String, timeout: TimeInterval = 0.5) -> String? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", script]
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = FileHandle.nullDevice
        do {
            try task.run()
        } catch {
            fputs("  osascript launch failed: \(error)\n", stderr)
            return nil
        }
        let deadline = Date().addingTimeInterval(timeout)
        while task.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        if task.isRunning { task.terminate(); return nil }
        guard task.terminationStatus == 0 else { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Check if two paths are related (one contains the other, with / boundary check)
    static func pathsRelated(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        let aNorm = a.hasSuffix("/") ? a : a + "/"
        let bNorm = b.hasSuffix("/") ? b : b + "/"
        return b.hasPrefix(aNorm) || a.hasPrefix(bNorm)
    }
}

// MARK: - Terminal Activator

struct TerminalActivator {
    /// Activate the terminal containing this session — bring window to front and focus terminal.
    static func activate(_ session: AgentSession) {
        DispatchQueue.global(qos: .userInitiated).async {
            let appType = resolveTerminalApp(session)
            fputs("TerminalActivator: type=\(appType) tty=\(session.terminalTTY) dir=\(session.projectDir)\n", stderr)

            switch appType {
            case .vscodeFamily:
                activateVSCodeFamily(session)
            case .iterm2:
                activateITerm2(tty: session.terminalTTY)
            case .terminalApp:
                activateTerminalApp(tty: session.terminalTTY)
            case .ghostty:
                activateGhostty(projectDir: session.projectDir)
            case .unknown:
                // Try VS Code extension first, then scan
                activateVSCodeFamily(session)
            }
        }
    }

    /// Determine terminal app type from session metadata
    private static func resolveTerminalApp(_ session: AgentSession) -> TerminalDetector.TerminalApp {
        switch session.terminalApp.lowercased() {
        case "iterm2": return .iterm2
        case "terminal": return .terminalApp
        case "ghostty": return .ghostty
        case "vscode", "cursor", "antigravity": return .vscodeFamily
        default:
            // Fallback: check extension registry
            if ExtensionRegistry.findPort(for: session.projectDir) != nil {
                return .vscodeFamily
            }
            return .unknown
        }
    }

    // MARK: VS Code family — use extension API
    private static func activateVSCodeFamily(_ session: AgentSession) {
        guard let port = ExtensionRegistry.findPort(for: session.projectDir) else {
            fputs("TerminalActivator: no extension port, scanning...\n", stderr)
            scanAndFocusExtension(projectDir: session.projectDir, terminalPID: session.terminalPID)
            return
        }

        // Get workspace info from extension
        let statusInfo = queryStatus(port: port)
        let workspacePath = statusInfo?["path"] as? String ?? session.projectDir

        // Probe to get appName for URI scheme
        let probeResult = focusTerminalViaExtension(port: port, projectDir: session.projectDir, terminalPID: 0)
        let probeName = probeResult?["appName"] as? String ?? ""
        let scheme = appNameToScheme(probeName)

        // Activate window via URI scheme
        let uriString = "\(scheme)://file\(workspacePath)"
        fputs("TerminalActivator: opening \(uriString)\n", stderr)
        if let url = URL(string: uriString) {
            DispatchQueue.main.async { NSWorkspace.shared.open(url) }
        }

        // Focus the terminal after window activates
        Thread.sleep(forTimeInterval: 0.8)
        focusTerminalViaExtension(port: port, projectDir: session.projectDir, terminalPID: session.terminalPID)
    }

    /// Validate TTY format: must be /dev/ttysNNN or /dev/ttypNNN etc.
    /// Rejects anything that could be an injection attempt.
    private static func isValidTTY(_ tty: String) -> Bool {
        let pattern = #"^/dev/ttys?\d+$"#
        return tty.range(of: pattern, options: .regularExpression) != nil
    }

    // MARK: Terminal.app — AppleScript
    private static func activateTerminalApp(tty: String) {
        guard !tty.isEmpty, isValidTTY(tty) else { return }
        let script = """
        tell application "Terminal"
            repeat with w in windows
                repeat with t in tabs of w
                    if tty of t is "\(tty)" then
                        set selected of t to true
                        set index of w to 1
                    end if
                end repeat
            end repeat
            activate
        end tell
        """
        TerminalDetector.runOsascript(script, timeout: 2)
    }

    // MARK: iTerm2 — AppleScript
    private static func activateITerm2(tty: String) {
        guard !tty.isEmpty, isValidTTY(tty) else { return }
        let script = """
        tell application "iTerm2"
            repeat with w in windows
                repeat with t in tabs of w
                    repeat with s in sessions of t
                        if tty of s is "\(tty)" then
                            select s
                            select t
                            select w
                        end if
                    end repeat
                end repeat
            end repeat
            activate
        end tell
        """
        TerminalDetector.runOsascript(script, timeout: 2)
    }

    // MARK: Ghostty — AppleScript (cwd match)
    private static func activateGhostty(projectDir: String) {
        guard !projectDir.isEmpty else { return }
        // Use static AppleScript to get all terminal working directories,
        // then match in Swift to avoid injection risks with projectDir
        let script = """
        tell application "Ghostty"
            set output to ""
            repeat with w in windows
                repeat with t in tabs of w
                    repeat with term in terminals of t
                        set d to working directory of term
                        set i to id of term
                        set output to output & i & "||" & d & "\\n"
                    end repeat
                end repeat
            end repeat
            return output
        end tell
        """
        guard let result = TerminalDetector.runOsascript(script, timeout: 2) else { return }
        // Parse output to find matching terminal, then focus it
        for line in result.components(separatedBy: "\n") where !line.isEmpty {
            let parts = line.components(separatedBy: "||")
            guard parts.count == 2 else { continue }
            let termID = parts[0]
            let cwd = parts[1]
            if TerminalDetector.pathsRelated(cwd, projectDir) {
                // Validate termID contains only safe characters (alphanumeric, hyphens, underscores)
                let safeID = termID.filter { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" }
                guard safeID == termID, !safeID.isEmpty else { continue }
                let focusScript = "tell application \"Ghostty\" to focus (first terminal whose id is \"\(safeID)\")"
                TerminalDetector.runOsascript(focusScript, timeout: 2)
                TerminalDetector.runOsascript("tell application \"Ghostty\" to activate", timeout: 1)
                return
            }
        }
        // Fallback: just activate Ghostty
        TerminalDetector.runOsascript("tell application \"Ghostty\" to activate", timeout: 1)
    }

    // MARK: Helpers

    private static let schemeMap: [String: String] = [
        "Visual Studio Code": "vscode",
        "Antigravity": "antigravity",
        "Cursor": "cursor",
    ]

    private static func appNameToScheme(_ name: String) -> String {
        schemeMap.first(where: { name.contains($0.key) })?.value ?? "vscode"
    }

    private static func queryStatus(port: UInt16) -> [String: Any]? {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/status")!)
        req.timeoutInterval = 1
        var result: [String: Any]?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, _ in
            if let data { result = try? JSONSerialization.jsonObject(with: data) as? [String: Any] }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 2)
        return result
    }

    @discardableResult
    private static func focusTerminalViaExtension(port: UInt16, projectDir: String, terminalPID: Int) -> [String: Any]? {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/focus-terminal")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 3
        var body: [String: Any] = ["projectDir": projectDir]
        if terminalPID > 0 { body["terminalPID"] = terminalPID }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        var result: [String: Any]?
        let sem = DispatchSemaphore(value: 0)
        URLSession.shared.dataTask(with: req) { data, _, err in
            if let data {
                result = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                fputs("TerminalActivator focus: \(String(data: data, encoding: .utf8) ?? "?")\n", stderr)
            } else if let err {
                fputs("TerminalActivator focus failed: \(err.localizedDescription)\n", stderr)
            }
            sem.signal()
        }.resume()
        _ = sem.wait(timeout: .now() + 4)
        return result
    }

    /// Fallback: scan ports 9528-9548 to find a workspace matching projectDir
    private static func scanAndFocusExtension(projectDir: String, terminalPID: Int) {
        let projectName = (projectDir as NSString).lastPathComponent.lowercased()
        for port in 9528...9548 {
            guard let url = URL(string: "http://127.0.0.1:\(port)/status") else { continue }
            var req = URLRequest(url: url)
            req.timeoutInterval = 0.5
            let sem = DispatchSemaphore(value: 0)
            var matched = false
            URLSession.shared.dataTask(with: req) { data, _, _ in
                defer { sem.signal() }
                guard let data,
                      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let path = json["path"] as? String else { return }
                if projectDir.hasPrefix(path) || path.lowercased().contains(projectName) {
                    matched = true
                }
            }.resume()
            _ = sem.wait(timeout: .now() + 1)
            if matched {
                fputs("TerminalActivator: scan found port \(port)\n", stderr)
                focusTerminalViaExtension(port: UInt16(port), projectDir: projectDir, terminalPID: terminalPID)
                return
            }
        }
        fputs("TerminalActivator: no matching workspace found\n", stderr)
    }
}

// MARK: - Session Manager

final class SessionManager: ObservableObject {
    @Published var sessions: [AgentSession] = []
    var decidedSessions: [String: (behavior: String, time: Date)] = [:]  // decisionID → (behavior, timestamp)
    var promptCache: [String: String] = [:]  // session_id → latest user prompt

    static let attentionEvents: Set<String> = ["PermissionRequest", "Notification", "Stop"]
    static let workingEvents: Set<String> = ["PostToolUse"]

    var waitingCount: Int { sessions.count }
    var hasAttentionNeeded: Bool { !sessions.isEmpty }

    struct HandleResult {
        let decisionID: String?
        let suppressed: Bool
    }

    /// Returns decision_id for PermissionRequest events (bridge polls this)
    func handleEvent(json: Data, source: String, permissionSuggestions: [[String: Any]] = []) -> HandleResult {
        guard let event = try? JSONDecoder().decode(IncomingEvent.self, from: json) else {
            return HandleResult(decisionID: nil, suppressed: false)
        }
        let hookName = event.hook_event_name ?? "unknown"
        let sessionId = event.session_id ?? UUID().uuidString
        let projectDir = event.cwd ?? "~"
        let termPID = event.terminal_pid ?? 0
        let termTTY = event.terminal_tty ?? ""
        let termApp = event.terminal_app ?? ""
        let toolDesc = toolDescriptionFrom(toolName: event.tool_name, toolInput: event.tool_input)
        let agentEvent = AgentEvent(type: hookName, toolName: event.tool_name,
                                     message: event.message ?? event.title, timestamp: Date())

        // UserPromptSubmit: store prompt in cache, no UI
        if hookName == "UserPromptSubmit" {
            if let prompt = event.prompt, !prompt.isEmpty {
                DispatchQueue.main.async { [weak self] in
                    self?.promptCache[sessionId] = prompt
                    // Also update existing session if visible
                    if let existing = self?.sessions.first(where: { $0.id == sessionId }) {
                        existing.recentPrompt = prompt
                    }
                }
            }
            return HandleResult(decisionID: nil, suppressed: false)
        }

        // For ALL attention events: check if this terminal is active BEFORE creating session
        // This prevents Stop/Notification from briefly flashing in the UI
        let isAttention = Self.attentionEvents.contains(hookName)
        if isAttention && (termPID > 0 || !termTTY.isEmpty) {
            let isFg = TerminalDetector.isActive(terminalPID: termPID, terminalTTY: termTTY, projectDir: projectDir)
            fputs("FG check: pid=\(termPID) tty=\(termTTY) app=\(termApp) hook=\(hookName) isForeground=\(isFg)\n", stderr)
            if isFg {
                return HandleResult(decisionID: nil, suppressed: true)
            }
        }

        var decisionID: String?
        if hookName == "PermissionRequest" {
            decisionID = UUID().uuidString
        }

        let did = decisionID
        let td = toolDesc
        let ps = permissionSuggestions
        DispatchQueue.main.async { [weak self] in
            self?.processEvent(sessionId: sessionId, source: source, projectDir: projectDir,
                              hookName: hookName, agentEvent: agentEvent, decisionID: did,
                              toolDesc: td, termPID: termPID, termTTY: termTTY, termApp: termApp,
                              permissionSuggestions: ps)
        }
        return HandleResult(decisionID: decisionID, suppressed: false)
    }

    private func processEvent(sessionId: String, source: String, projectDir: String,
                              hookName: String, agentEvent: AgentEvent,
                              decisionID: String? = nil, toolDesc: String = "",
                              termPID: Int = 0, termTTY: String = "", termApp: String = "",
                              permissionSuggestions: [[String: Any]] = []) {

        // Working events → user has responded in terminal, dismiss + mark decision
        if Self.workingEvents.contains(hookName) || hookName == "SessionEnd" {
            if let existing = sessions.first(where: { $0.id == sessionId }) {
                existing.decision = "dismissed"
                decidedSessions[existing.decisionID] = ("dismissed", Date())
            }
            sessions.removeAll { $0.id == sessionId }
            promptCache.removeValue(forKey: sessionId)
            evictStaleDecisions()
            evictStalePrompts()
            return
        }

        // Attention events → show immediately
        if Self.attentionEvents.contains(hookName) {
            if let existing = sessions.first(where: { $0.id == sessionId }) {
                existing.lastEvent = agentEvent
                existing.updatedAt = Date()
                existing.status = hookName == "Stop" ? .done : .waiting
                existing.toolDescription = toolDesc
                if !permissionSuggestions.isEmpty {
                    existing.permissionSuggestionsRaw = permissionSuggestions
                }
                // Update decisionID for repeated PermissionRequests so bridge polls the right ID
                if let did = decisionID {
                    decidedSessions[existing.decisionID] = ("dismissed", Date()) // expire old ID
                    existing.decisionID = did
                    existing.decision = nil // reset for new prompt
                }
                // Notify parent observers (CompactView etc.) that session state changed
                objectWillChange.send()
            } else {
                let session = AgentSession(id: sessionId, source: source, projectDir: projectDir,
                                           event: agentEvent, decisionID: decisionID ?? UUID().uuidString,
                                           toolDescription: toolDesc)
                session.status = hookName == "Stop" ? .done : .waiting
                session.terminalPID = termPID
                session.terminalTTY = termTTY
                session.terminalApp = termApp
                session.permissionSuggestionsRaw = permissionSuggestions
                // Attach cached prompt if available
                if let cached = promptCache[sessionId] {
                    session.recentPrompt = cached
                }
                sessions.insert(session, at: 0)
                // Play notification sound for new session (terminal is NOT active)
                NotificationSound.play()
            }
        }
    }

    /// User clicked Allow/Deny in the app
    func decide(_ session: AgentSession, behavior: String) {
        session.decision = behavior
        decidedSessions[session.decisionID] = (behavior, Date())
        promptCache.removeValue(forKey: session.id)
        sessions.removeAll { $0.id == session.id }
    }

    /// User clicked session row to handle in terminal
    func dismissToTerminal(_ session: AgentSession) {
        session.decision = "terminal"
        decidedSessions[session.decisionID] = ("terminal", Date())
        promptCache.removeValue(forKey: session.id)
        sessions.removeAll { $0.id == session.id }
    }

    /// Dismiss without affecting decision (for Stop sessions / view-only)
    func dismiss(_ session: AgentSession) {
        promptCache.removeValue(forKey: session.id)
        sessions.removeAll { $0.id == session.id }
    }

    /// Find a session by decisionID (bridge polls this)
    func findByDecisionID(_ did: String) -> AgentSession? {
        sessions.first { $0.decisionID == did }
    }

    /// Remove decided sessions older than 5 minutes to prevent unbounded memory growth
    private func evictStaleDecisions() {
        let cutoff = Date().addingTimeInterval(-300) // 5 minutes
        decidedSessions = decidedSessions.filter { $0.value.time > cutoff }
    }

    /// Remove prompt cache entries for sessions no longer active (cap at 50 entries)
    private func evictStalePrompts() {
        let activeIDs = Set(sessions.map { $0.id })
        promptCache = promptCache.filter { activeIDs.contains($0.key) }
        // Hard cap as safety net
        if promptCache.count > 50 {
            let excess = promptCache.count - 50
            promptCache = Dictionary(uniqueKeysWithValues: Array(promptCache.dropFirst(excess)))
        }
    }
}

// MARK: - HTTP Server (NWListener)

final class CompanionHTTPServer {
    private var listener: NWListener?
    private let port: UInt16
    private let sessionManager: SessionManager

    init(port: UInt16 = 9527, sessionManager: SessionManager) {
        self.port = port
        self.sessionManager = sessionManager
    }

    func start() {
        guard let nwPort = NWEndpoint.Port(rawValue: port) else { return }
        do {
            let params = NWParameters.tcp
            params.allowLocalEndpointReuse = true
            listener = try NWListener(using: params, on: nwPort)
        } catch {
            fputs("Failed to create listener: \(error)\n", stderr)
            return
        }
        listener?.stateUpdateHandler = { state in
            if case .ready = state {
                fputs("Code Companion listening on :\(self.port)\n", stderr)
            } else if case .failed(let err) = state {
                fputs("Listener failed: \(err)\n", stderr)
                self.listener?.cancel()
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { self.start() }
            }
        }
        listener?.newConnectionHandler = { [weak self] conn in self?.handle(conn) }
        listener?.start(queue: .global(qos: .userInitiated))
    }

    func stop() { listener?.cancel(); listener = nil }

    private func handle(_ conn: NWConnection) {
        conn.start(queue: .global(qos: .userInitiated))
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, _, _ in
            guard let self, let data, let raw = String(data: data, encoding: .utf8) else {
                conn.cancel(); return
            }
            let (method, path, headers, body) = self.parse(raw)
            let source = headers["x-source"] ?? "unknown"
            var code = "200 OK"; var resp = "{\"ok\":true}"

            if method == "POST" && path == "/event" {
                if let d = body.data(using: .utf8) {
                    // Two-stage parsing: extract permission_suggestions via JSONSerialization
                    var permSuggestions: [[String: Any]] = []
                    if let rawJson = try? JSONSerialization.jsonObject(with: d) as? [String: Any],
                       let ps = rawJson["permission_suggestions"] as? [[String: Any]] {
                        permSuggestions = ps
                    }
                    let result = self.sessionManager.handleEvent(json: d, source: source,
                                                                  permissionSuggestions: permSuggestions)
                    if result.suppressed {
                        resp = "{\"ok\":true,\"suppressed\":true}"
                    } else if let did = result.decisionID {
                        resp = "{\"ok\":true,\"decision_id\":\"\(did)\"}"
                    }
                } else { code = "400 Bad Request"; resp = "{\"error\":\"bad body\"}" }
            } else if method == "GET" && path.hasPrefix("/decision/") {
                let did = String(path.dropFirst("/decision/".count))
                var behavior = ""
                DispatchQueue.main.sync {
                    if let session = self.sessionManager.findByDecisionID(did) {
                        behavior = session.decision ?? ""
                    } else {
                        behavior = self.sessionManager.decidedSessions[did]?.behavior ?? ""
                    }
                }
                if behavior.isEmpty {
                    resp = "{\"behavior\":\"\"}"
                } else {
                    resp = "{\"behavior\":\"\(behavior)\"}"
                }
            } else if method == "GET" && path == "/health" {
                resp = "{\"status\":\"ok\"}"
            } else if method == "GET" && path == "/status" {
                var w = 0; var t = 0
                DispatchQueue.main.sync {
                    w = self.sessionManager.waitingCount
                    t = self.sessionManager.sessions.count
                }
                resp = "{\"waiting\":\(w),\"total\":\(t)}"
            } else { code = "404 Not Found"; resp = "{\"error\":\"not found\"}" }

            let out = "HTTP/1.1 \(code)\r\nContent-Type: application/json\r\nContent-Length: \(resp.utf8.count)\r\nConnection: close\r\n\r\n\(resp)"
            conn.send(content: out.data(using: .utf8), completion: .contentProcessed { _ in
                conn.cancel()
            })
        }
    }

    private func parse(_ raw: String) -> (String, String, [String: String], String) {
        let parts = raw.components(separatedBy: "\r\n\r\n")
        let body = parts.count > 1 ? parts.dropFirst().joined(separator: "\r\n\r\n") : ""
        let lines = parts[0].components(separatedBy: "\r\n")
        let rl = lines.first?.split(separator: " ") ?? []
        let method = rl.count > 0 ? String(rl[0]) : "GET"
        let path = rl.count > 1 ? String(rl[1]) : "/"
        var hdrs: [String: String] = [:]
        for line in lines.dropFirst() {
            if let i = line.firstIndex(of: ":") {
                hdrs[line[..<i].lowercased()] = String(line[line.index(after: i)...]).trimmingCharacters(in: .whitespaces)
            }
        }
        return (method, path, hdrs, body)
    }
}

// MARK: - Extension Registry (shared with VS Code extension)

struct ExtensionRegistryEntry: Decodable {
    let port: Int
    let workspace: String
    let path: String
    let pid: Int
}

struct ExtensionRegistry {
    static let registryFile = NSHomeDirectory() + "/.code-companion/extension-registry.json"

    /// Find the extension port for a given project directory
    static func findPort(for projectDir: String) -> UInt16? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: registryFile)),
              let entries = try? JSONDecoder().decode([ExtensionRegistryEntry].self, from: data)
        else { return nil }

        let live = entries.filter { kill(Int32($0.pid), 0) == 0 }

        // Exact path match
        if let entry = live.first(where: { projectDir.hasPrefix($0.path) }) {
            return UInt16(entry.port)
        }

        // Folder name match
        let projectName = (projectDir as NSString).lastPathComponent.lowercased()
        if let entry = live.first(where: { $0.workspace.lowercased() == projectName }) {
            return UInt16(entry.port)
        }

        // Return any live entry as fallback
        return live.first.map { UInt16($0.port) }
    }
}

// MARK: - NSScreen Extension (multi-monitor + notch detection)

extension NSScreen {
    var displayID: CGDirectDisplayID? {
        deviceDescription[NSDeviceDescriptionKey(rawValue: "NSScreenNumber")] as? CGDirectDisplayID
    }
    var isBuiltIn: Bool {
        guard let id = displayID else { return false }
        return CGDisplayIsBuiltin(id) != 0
    }
    var hasNotch: Bool { safeAreaInsets.top > 0 }
    var notchHeight: CGFloat { safeAreaInsets.top }

    /// The built-in Mac screen (with notch), falling back to primary screen
    static var builtIn: NSScreen? {
        screens.first(where: { $0.isBuiltIn }) ?? screens.first ?? main
    }
}

// MARK: - Island Panel (NSPanel subclass)

final class IslandPanel: NSPanel, ObservableObject {
    static let topEarR: CGFloat = 6
    static let topEarRExpanded: CGFloat = 10

    var dockedCompactSize: NSSize {
        let h = NSScreen.builtIn?.notchHeight ?? 0
        return NSSize(width: 250 + 2 * Self.topEarR, height: h > 0 ? h : 44)
    }
    var dockedExpandedSize: NSSize {
        NSSize(width: 520 + 2 * Self.topEarRExpanded, height: 420)
    }
    let freeCompactSize = NSSize(width: 160, height: 36)
    let expandedSize = NSSize(width: 520, height: 420)
    @Published private(set) var isExpanded = false
    @Published var isDocked = true
    private var hoverExpandTimer: Timer?
    private var hoverCollapseTimer: Timer?

    var compactSize: NSSize { isDocked ? dockedCompactSize : freeCompactSize }

    init() {
        super.init(contentRect: NSRect(origin: .zero, size: NSSize(width: 350, height: 44)),
                   styleMask: [.nonactivatingPanel, .fullSizeContentView],
                   backing: .buffered, defer: false)
        isFloatingPanel = true
        level = .init(rawValue: Int(CGShieldingWindowLevel()))
        hidesOnDeactivate = false
        isMovableByWindowBackground = true
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        animationBehavior = .none
        appearance = NSAppearance(named: .darkAqua)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]

        NotificationCenter.default.addObserver(forName: NSWindow.didMoveNotification, object: self,
                                                queue: .main) { [weak self] _ in
            guard let self else { return }
            if self.isDocked && !self.isNearDock() {
                self.isDocked = false
                let size = self.isExpanded ? self.expandedSize : self.freeCompactSize
                self.resizeAnimated(to: size, dock: false)
            } else if !self.isDocked && self.isNearDock() {
                self.snapToDock()
            }
        }

        positionAtDock(dockedCompactSize)
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    func setSwiftUIContent<V: View>(_ view: V) {
        contentView = NSHostingView(rootView: view.ignoresSafeArea())
        guard let cv = contentView else { return }
        cv.addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self, userInfo: nil))
        let click = NSClickGestureRecognizer(target: self, action: #selector(handleContentClick))
        cv.addGestureRecognizer(click)
    }

    @objc private func handleContentClick() {
        if !isDocked && !isExpanded {
            setExpanded(true)
        }
    }

    func positionAtDock(_ size: NSSize) {
        guard let screen = NSScreen.builtIn else { return }
        let sf = screen.frame
        let x = sf.midX - size.width / 2
        let y = sf.maxY - size.height
        setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
    }

    func isNearDock() -> Bool {
        guard let screen = NSScreen.builtIn else { return true }
        let sf = screen.frame
        let notchH = max(screen.notchHeight, 37)
        let dockSize = isExpanded ? dockedExpandedSize : dockedCompactSize
        let notchRect = NSRect(x: sf.midX - dockSize.width / 2,
                               y: sf.maxY - notchH,
                               width: dockSize.width,
                               height: notchH)
        return frame.intersects(notchRect)
    }

    func snapToDock() {
        isDocked = true
        let size = isExpanded ? dockedExpandedSize : dockedCompactSize
        guard let screen = NSScreen.builtIn else { return }
        let sf = screen.frame
        let target = NSRect(x: sf.midX - size.width / 2,
                            y: sf.maxY - size.height,
                            width: size.width, height: size.height)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.animator().setFrame(target, display: true)
        }
    }

    private func resizeAnimated(to size: NSSize, dock: Bool) {
        let cur = frame
        let x = dock ? (NSScreen.main?.frame.midX ?? cur.midX) - size.width / 2
                      : cur.midX - size.width / 2
        let y = cur.maxY - size.height
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.2
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            self.animator().setFrame(NSRect(x: x, y: y, width: size.width, height: size.height), display: true)
        }
    }

    func setExpanded(_ expanded: Bool) {
        guard expanded != isExpanded else { return }
        isExpanded = expanded
        let targetSize = expanded ? (isDocked ? dockedExpandedSize : expandedSize) : compactSize

        let targetFrame: NSRect
        if isDocked, let screen = NSScreen.builtIn {
            let sf = screen.frame
            targetFrame = NSRect(x: sf.midX - targetSize.width / 2,
                                 y: sf.maxY - targetSize.height,
                                 width: targetSize.width, height: targetSize.height)
        } else {
            let cur = frame
            targetFrame = NSRect(x: cur.midX - targetSize.width / 2,
                                 y: cur.maxY - targetSize.height,
                                 width: targetSize.width, height: targetSize.height)
        }

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.25
            ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            self.animator().setFrame(targetFrame, display: true)
        }
    }

    func dock() {
        isDocked = true
        let size = isExpanded ? dockedExpandedSize : dockedCompactSize
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.3
            ctx.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            self.positionAtDock(size)
        }
    }

    // MARK: Hover expand/collapse (docked mode only)

    func cancelHoverTimers() {
        hoverExpandTimer?.invalidate(); hoverExpandTimer = nil
        hoverCollapseTimer?.invalidate(); hoverCollapseTimer = nil
    }

    override func mouseDown(with event: NSEvent) {
        cancelHoverTimers()
        super.mouseDown(with: event)
        if !isDocked && isNearDock() { snapToDock() }
    }

    override func mouseEntered(with event: NSEvent) {
        super.mouseEntered(with: event)
        guard isDocked, !isExpanded else { return }
        hoverCollapseTimer?.invalidate(); hoverCollapseTimer = nil
        hoverExpandTimer = Timer.scheduledTimer(withTimeInterval: 0.3, repeats: false) { [weak self] _ in
            guard let self, self.isDocked else { return }
            self.setExpanded(true)
        }
    }

    override func mouseExited(with event: NSEvent) {
        super.mouseExited(with: event)
        hoverExpandTimer?.invalidate(); hoverExpandTimer = nil
        guard isDocked, isExpanded else { return }
        hoverCollapseTimer = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: false) { [weak self] _ in
            guard let self, self.isDocked else { return }
            self.setExpanded(false)
        }
    }
}

// MARK: - App Icon Helpers

/// Load installed app icon from bundle ID via NSWorkspace
struct AppIconView: View {
    let bundleID: String
    let size: CGFloat

    var body: some View {
        if let nsImage = Self.cachedIcon(for: bundleID) {
            Image(nsImage: nsImage)
                .resizable()
                .interpolation(.high)
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
        } else {
            Image(systemName: "terminal")
                .font(.system(size: size * 0.6))
                .foregroundStyle(.tertiary)
                .frame(width: size, height: size)
        }
    }

    private static var iconCache: [String: NSImage] = [:]

    static func cachedIcon(for bundleID: String) -> NSImage? {
        if let cached = iconCache[bundleID] { return cached }
        guard let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) else { return nil }
        let icon = NSWorkspace.shared.icon(forFile: url.path)
        icon.size = NSSize(width: 64, height: 64)
        iconCache[bundleID] = icon
        return icon
    }
}

/// Terminal app bundle ID mapping
func terminalBundleID(for app: String) -> String? {
    switch app.lowercased() {
    case "vscode": return "com.microsoft.VSCode"
    case "cursor": return "com.todesktop.230313mzl4w4u92"
    case "antigravity": return "com.google.antigravity"
    case "iterm2": return "com.googlecode.iterm2"
    case "terminal": return "com.apple.Terminal"
    case "ghostty": return "com.mitchellh.ghostty"
    default: return nil
    }
}

/// Gemini logo — four-pointed sparkle
struct GeminiLogo: View {
    let size: CGFloat
    let color: Color

    var body: some View {
        Canvas { context, canvasSize in
            let cx = canvasSize.width / 2
            let cy = canvasSize.height / 2
            let outer = min(cx, cy) * 0.9
            let inner = outer * 0.2

            var path = Path()
            for i in 0..<4 {
                let angle = Double(i) * .pi / 2.0 - .pi / 2
                let tipX = cx + outer * cos(angle)
                let tipY = cy + outer * sin(angle)
                if i == 0 {
                    path.move(to: CGPoint(x: tipX, y: tipY))
                } else {
                    path.addLine(to: CGPoint(x: tipX, y: tipY))
                }
                path.addQuadCurve(to: CGPoint(x: cx + inner * cos(angle + .pi / 4),
                                               y: cy + inner * sin(angle + .pi / 4)),
                                   control: CGPoint(x: cx, y: cy))
            }
            path.closeSubpath()
            context.fill(path, with: .color(color))
        }
        .frame(width: size, height: size)
    }
}

/// Source tool bundle ID mapping
func sourceBundleID(for source: String) -> String? {
    switch source.lowercased() {
    case "claude": return "com.anthropic.claudefordesktop"
    case "codex": return "com.openai.codex"
    default: return nil
    }
}

/// Source tool logo view — uses real app icons when available, drawn logo as fallback
struct SourceLogo: View {
    let source: String
    let size: CGFloat

    var body: some View {
        if let bid = sourceBundleID(for: source),
           AppIconView.cachedIcon(for: bid) != nil {
            AppIconView(bundleID: bid, size: size)
        } else {
            switch source.lowercased() {
            case "gemini":
                GeminiLogo(size: size, color: .blue)
            default:
                Image(systemName: "terminal.fill")
                    .font(.system(size: size * 0.6))
                    .foregroundStyle(.tertiary)
                    .frame(width: size, height: size)
            }
        }
    }
}

// MARK: - SwiftUI Views

// MARK: Design System (Atoll-inspired)

private let hoverAnimation: Animation = .bouncy.speed(1.2)
private let expandAnimation: Animation = .spring(response: 0.42, dampingFraction: 0.8)
private let contentTransitionAnim: Animation = .smooth(duration: 0.3)

private let surfaceBorder = Color.primary.opacity(0.08)
private let surfaceHover = Color.primary.opacity(0.10)

// MARK: - Activity Indicator (Dynamic Island style)

/// Fluid activity dots — like iOS Dynamic Island's music/activity indicator.
/// Idle: gray dots drifting slowly right-to-left, evenly spaced, all visible.
/// Active: green bars with randomized organic rhythm like a live audio waveform.
struct ActivityDots: View {
    var isActive: Bool
    let dotCount = 12      // 12 dot positions
    let barCount = 4       // active wave bars when notified
    let dotSize: CGFloat = 2
    let spacing: CGFloat = 1
    let maxHeight: CGFloat = 15
    let totalWidth: CGFloat = 25

    // Per-dot brightness (0=invisible, 1=full bright)
    @State private var brightness: [CGFloat]
    // Timer for idle chase animation
    @State private var chaseTimer: Timer?
    @State private var chaseStep: Int = 0

    init(isActive: Bool) {
        self.isActive = isActive
        _brightness = State(initialValue: Array(repeating: 0, count: 12))
    }

    var body: some View {
        if isActive {
            // Active: 12 green bars, all same brightness, height drives the rhythm
            HStack(alignment: .center, spacing: spacing) {
                ForEach(Array(0..<dotCount), id: \.self) { i in
                    let h = dotSize + (maxHeight - dotSize) * brightness[i]
                    RoundedRectangle(cornerRadius: dotSize / 2)
                        .fill(Color.green.opacity(0.85))
                        .shadow(color: Color.green.opacity(0.4), radius: 2, y: 0)
                        .frame(width: dotSize, height: h)
                }
            }
            .frame(width: totalWidth, height: maxHeight)
            .onAppear { stopAllTimers(); startWave() }
            .onChange(of: isActive) { _, active in
                stopAllTimers()
                if active { startWave() } else { startChase() }
            }
        } else {
            // Idle: 12 dot positions, glow sweeps through
            HStack(spacing: spacing) {
                ForEach(Array(0..<dotCount), id: \.self) { i in
                    let b = Double(brightness[i])
                    Circle()
                        .fill(Color.white.opacity(b * 0.9))
                        .shadow(color: Color.white.opacity(b * 0.8), radius: b * 4, y: 0)
                        .frame(width: dotSize, height: dotSize)
                }
            }
            .frame(width: totalWidth, height: maxHeight)
            .onAppear { stopAllTimers(); startChase() }
            .onChange(of: isActive) { _, active in
                stopAllTimers()
                if active { startWave() } else { startChase() }
            }
        }
    }

    private func stopAllTimers() {
        chaseTimer?.invalidate(); chaseTimer = nil
        waveTimer?.invalidate(); waveTimer = nil
    }

    // MARK: Active — flowing green wave with organic height jitter

    @State private var waveTimer: Timer?
    @State private var waveStep: Int = 0

    private func startWave() {
        for i in 0..<dotCount { brightness[i] = 0 }
        waveStep = 0

        waveTimer = Timer.scheduledTimer(withTimeInterval: 1.0/60.0, repeats: true) { _ in
            DispatchQueue.main.async {
                guard isActive else { return }
                waveStep += 1

                // All 12 bars always at full opacity — rhythm comes from HEIGHT only
                for i in 0..<dotCount {
                    let s1 = sin(Double(waveStep) * 0.18 + Double(i) * 1.7)
                    let s2 = sin(Double(waveStep) * 0.11 + Double(i) * 3.1)
                    let s3 = sin(Double(waveStep) * 0.29 + Double(i) * 0.9)
                    let bounce = (s1 + s2 * 0.6 + s3 * 0.4) / 2.0
                    let height = 0.1 + 0.9 * (bounce + 1.0) / 2.0  // 0.1...1.0
                    brightness[i] = CGFloat(height)
                }
            }
        }
    }

    // MARK: Idle — CSS-style chase light with glow sweep

    // Continuous phase clock: increments ~60fps, each dot calculates its own brightness
    // from a shared clock + staggered delay, replicating the CSS keyframe approach.
    private func startChase() {
        for i in 0..<dotCount { brightness[i] = 0 }
        chaseStep = 0

        // 30fps for smooth glow sweep
        chaseTimer = Timer.scheduledTimer(withTimeInterval: 1.0/60.0, repeats: true) { _ in
            DispatchQueue.main.async {
                guard !isActive else { return }
                chaseStep += 1

                // 12 dots, smooth flowing chase. ~6 dots lit at once.
                let cycle: Double = 120  // ~2s at 60fps
                let stagger: Double = cycle / Double(dotCount)
                let activeWindow: Double = 0.55  // ~6 dots lit

                for i in 0..<dotCount {
                    let delay = Double(dotCount - 1 - i) * stagger
                    let t = fmod(Double(chaseStep) - delay + cycle * 1000, cycle) / cycle

                    let half = activeWindow / 2.0
                    let b: CGFloat
                    if t < half {
                        b = CGFloat(t / half)
                    } else if t < activeWindow {
                        b = CGFloat(1.0 - (t - half) / half)
                    } else {
                        b = 0
                    }
                    brightness[i] = b
                }
            }
        }
    }
}

struct DynamicIslandShape: Shape {
    var cornerRadius: CGFloat = 10
    var earSize: CGFloat = 4
    var topEarSize: CGFloat = 6

    func path(in rect: CGRect) -> Path {
        let W = rect.width, H = rect.height
        let R = cornerRadius, E = earSize, T = topEarSize
        var p = Path()

        p.move(to: CGPoint(x: 0, y: 0))
        p.addLine(to: CGPoint(x: W, y: 0))

        p.addArc(center: CGPoint(x: W, y: T), radius: T,
                 startAngle: .degrees(270), endAngle: .degrees(180),
                 clockwise: true)

        p.addLine(to: CGPoint(x: W - T, y: H - R - E))

        p.addCurve(to: CGPoint(x: W - T - E - R, y: H),
                   control1: CGPoint(x: W - T, y: H - R),
                   control2: CGPoint(x: W - T - E, y: H))

        p.addLine(to: CGPoint(x: T + E + R, y: H))

        p.addCurve(to: CGPoint(x: T, y: H - R - E),
                   control1: CGPoint(x: T + E, y: H),
                   control2: CGPoint(x: T, y: H - R))

        p.addLine(to: CGPoint(x: T, y: T))

        p.addArc(center: CGPoint(x: 0, y: T), radius: T,
                 startAngle: .degrees(0), endAngle: .degrees(270),
                 clockwise: true)

        p.closeSubpath()
        return p
    }
}

struct CompactView: View {
    @ObservedObject var sm: SessionManager
    var isDocked: Bool
    var body: some View {
        HStack(spacing: 0) {
            HStack(spacing: 6) {
                ActivityDots(isActive: sm.hasAttentionNeeded)

                if sm.sessions.count == 1, let session = sm.sessions.first, isDocked {
                    // Single session: show inline info with real logo
                    SourceLogo(source: session.source, size: 12)
                    Text(session.projectName)
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    if session.isPermissionRequest {
                        Text("·").foregroundStyle(.tertiary)
                        Text(session.lastEvent.toolName ?? "Approve")
                            .font(.system(size: 9))
                            .foregroundColor(.orange.opacity(0.8))
                            .lineLimit(1)
                    } else if session.isStop {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 8))
                            .foregroundColor(.green.opacity(0.7))
                    }
                } else {
                    // Multiple sessions or undocked: show source logos + count
                    let sources = Array(Set(sm.sessions.map { $0.source })).prefix(3)
                    ForEach(Array(sources), id: \.self) { src in
                        SourceLogo(source: src, size: 12)
                    }

                    if !isDocked {
                        statusText
                    }
                }
            }
            .padding(.leading, 14)

            if isDocked && sm.sessions.count != 1 {
                Spacer(minLength: 0)
                statusText
            }

            Spacer(minLength: 0)
        }
        .padding(.trailing, 14).padding(.vertical, 8)
        .padding(.horizontal, isDocked ? IslandPanel.topEarR : 0)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            ZStack {
                Color.black
                // Subtle inner edge highlight
                if isDocked {
                    DynamicIslandShape()
                        .stroke(surfaceBorder, lineWidth: 0.5)
                } else {
                    Capsule()
                        .strokeBorder(surfaceBorder, lineWidth: 0.5)
                }
            }
        )
        .clipShape(isDocked
            ? AnyShape(DynamicIslandShape())
            : AnyShape(Capsule()))
        // Dual-layer shadow for undocked
        .shadow(color: .black.opacity(isDocked ? 0 : 0.15), radius: 4, y: 1)
        .shadow(color: .black.opacity(isDocked ? 0 : 0.3), radius: 12, y: 4)
    }

    var statusText: some View {
        Group {
            if sm.waitingCount > 0 {
                Text("\(sm.waitingCount)")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundColor(.green)
                    .contentTransition(.numericText())
                    .animation(contentTransitionAnim, value: sm.waitingCount)
            }
        }
    }

    func sourceColor(_ s: String) -> Color {
        switch s.lowercased() {
        case "claude": return .orange; case "codex": return .green; case "gemini": return .blue; default: return .white
        }
    }
}

struct SessionRow: View {
    @ObservedObject var session: AgentSession
    var onAllow: (() -> Void)?
    var onAlwaysAllow: (() -> Void)?
    var onDeny: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Row 1: Source icon + project name + terminal icon
            HStack(spacing: 10) {
                SourceLogo(source: session.source, size: 24)

                Text(session.projectName)
                    .font(.system(size: 14, weight: .medium))
                    .foregroundStyle(.primary)

                Spacer(minLength: 4)

                if let bid = terminalBundleID(for: session.terminalApp) {
                    AppIconView(bundleID: bid, size: 20)
                }
            }

            // Row 2: Directory path (small, subdued)
            Text(session.abbreviatedDir)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.secondary.opacity(0.6))
                .lineLimit(1)
                .truncationMode(.middle)

            // Row 3: Latest user prompt
            if let title = session.sessionTitle {
                Text(title)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            // Row 4: Action content (tool description or status)
            if session.isStop {
                HStack(spacing: 5) {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 12))
                        .foregroundStyle(.green)
                    Text("Completed")
                        .font(.system(size: 12.5))
                        .foregroundStyle(.green)
                }
            } else {
                Text(subtitle)
                    .font(.system(size: 12.5))
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            // Row 5: Buttons (permission requests only)
            if session.isPermissionRequest, let onAllow, let onDeny {
                HStack(spacing: 8) {
                    Button("Allow", action: onAllow)
                        .buttonStyle(.borderedProminent)
                        .tint(.green)
                        .controlSize(.small)

                    if let onAlwaysAllow {
                        Button(action: onAlwaysAllow) {
                            HStack(spacing: 3) {
                                Text("Always")
                                if let permDesc = session.permissionDescription {
                                    Text("· \(permDesc)")
                                        .foregroundStyle(.white.opacity(0.7))
                                }
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(.blue)
                        .controlSize(.small)
                    }

                    Button("Deny", action: onDeny)
                        .buttonStyle(.bordered)
                        .tint(.red)
                        .controlSize(.small)

                    Spacer()
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .contentShape(Rectangle())
    }

    var subtitle: String {
        if session.isStop { return "Completed" }
        if !session.toolDescription.isEmpty { return session.toolDescription }
        let e = session.lastEvent
        switch e.type {
        case "PermissionRequest": return e.toolName.map { "Approve \($0)" } ?? "Needs approval"
        case "Notification": return e.message ?? "Notification"
        default: return e.type
        }
    }
}

struct ExpandedView: View {
    @ObservedObject var sm: SessionManager
    var panel: IslandPanel?
    let onCollapse: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header: activity dots + collapse chevron + session count
            HStack(spacing: 8) {
                ActivityDots(isActive: sm.hasAttentionNeeded)

                Spacer()

                if sm.sessions.count > 1 {
                    Text("\(sm.sessions.count) sessions")
                        .font(.system(size: 10, weight: .medium))
                        .foregroundStyle(.tertiary)
                        .contentTransition(.numericText())
                        .animation(contentTransitionAnim, value: sm.sessions.count)
                }

                Image(systemName: "chevron.up")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .contentShape(Rectangle())
            .onTapGesture { onCollapse() }

            if sm.sessions.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "checkmark.circle")
                        .font(.system(size: 28, weight: .light))
                        .foregroundStyle(.tertiary)
                    Text("No active sessions")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(.tertiary)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .transition(.blurReplace)
            } else {
                ScrollView {
                    VStack(spacing: 0) {
                        ForEach(Array(sm.sessions.enumerated()), id: \.element.id) { index, session in
                            if index > 0 {
                                Divider()
                                    .padding(.leading, 52)
                            }

                            Button(action: {
                                TerminalActivator.activate(session)
                                if session.isStop {
                                    sm.dismiss(session)
                                    sm.promptCache.removeValue(forKey: session.id)
                                } else {
                                    sm.dismissToTerminal(session)
                                }
                            }) {
                                SessionRow(session: session,
                                    onAllow: { sm.decide(session, behavior: "allow") },
                                    onAlwaysAllow: { sm.decide(session, behavior: "always_allow") },
                                    onDeny: { sm.decide(session, behavior: "deny") }
                                )
                            }
                            .buttonStyle(.plain)
                            .transition(.asymmetric(
                                insertion: .move(edge: .top).combined(with: .opacity),
                                removal: .move(edge: .trailing).combined(with: .opacity)
                            ))
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(Color.primary.opacity(0.06))
                    )
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .animation(contentTransitionAnim, value: sm.sessions.count)
                }
            }
        }
        .padding(.horizontal, panel?.isDocked == true ? IslandPanel.topEarRExpanded : 0)
        .background(
            ZStack {
                Color.black
                // Glassmorphic top-to-bottom gradient border (light-from-above)
                Group {
                    if panel?.isDocked == true {
                        DynamicIslandShape(topEarSize: IslandPanel.topEarRExpanded)
                            .stroke(
                                LinearGradient(
                                    colors: [Color.primary.opacity(0.08), Color.primary.opacity(0.02)],
                                    startPoint: .top, endPoint: .bottom
                                ),
                                lineWidth: 0.5
                            )
                    } else {
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .strokeBorder(
                                LinearGradient(
                                    colors: [Color.primary.opacity(0.08), Color.primary.opacity(0.02)],
                                    startPoint: .top, endPoint: .bottom
                                ),
                                lineWidth: 0.5
                            )
                    }
                }
            }
        )
        .clipShape(panel?.isDocked == true
            ? AnyShape(DynamicIslandShape(topEarSize: IslandPanel.topEarRExpanded))
            : AnyShape(RoundedRectangle(cornerRadius: 16, style: .continuous)))
        .shadow(color: .black.opacity(panel?.isDocked == true ? 0 : 0.2), radius: 6, y: 2)
        .shadow(color: .black.opacity(panel?.isDocked == true ? 0 : 0.4), radius: 16, y: 6)
    }
}

struct IslandView: View {
    @ObservedObject var sm: SessionManager
    @ObservedObject var panel: IslandPanel

    var body: some View {
        Group {
            if panel.isExpanded {
                ExpandedView(sm: sm, panel: panel) {
                    panel.cancelHoverTimers()
                    panel.setExpanded(false)
                }
                .transition(.blurReplace)
            } else {
                CompactView(sm: sm, isDocked: panel.isDocked)
                    .transition(.blurReplace)
            }
        }
        .animation(expandAnimation, value: panel.isExpanded)
    }
}

// MARK: - App Delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    var panel: IslandPanel!
    let sessionManager = SessionManager()
    var httpServer: CompanionHTTPServer!

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Kill any existing instances (single-instance enforcement)
        let myPID = ProcessInfo.processInfo.processIdentifier
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
        proc.arguments = ["-x", "code-companion"]
        let pipe = Pipe()
        proc.standardOutput = pipe
        try? proc.run()
        proc.waitUntilExit()
        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        for line in output.split(separator: "\n") {
            if let pid = Int32(line.trimmingCharacters(in: .whitespaces)), pid != myPID {
                kill(pid, SIGKILL)
            }
        }
        Thread.sleep(forTimeInterval: 0.3)

        panel = IslandPanel()
        let view = IslandView(sm: sessionManager, panel: panel)
        panel.setSwiftUIContent(view)
        panel.orderFrontRegardless()

        let port = UInt16(ProcessInfo.processInfo.environment["COMPANION_PORT"] ?? "9527") ?? 9527
        httpServer = CompanionHTTPServer(port: port, sessionManager: sessionManager)
        httpServer.start()

        NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                object: nil, queue: .main) { [weak self] _ in
            guard let self, self.panel.isDocked else { return }
            self.panel.positionAtDock(self.panel.isExpanded ? self.panel.dockedExpandedSize : self.panel.compactSize)
        }
        fputs("Code Companion launched\n", stderr)
    }

    func applicationWillTerminate(_ notification: Notification) { httpServer?.stop() }
}

// MARK: - Entry Point

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = AppDelegate()
app.delegate = delegate
app.run()
