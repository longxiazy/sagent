import Foundation
import Cocoa
import ApplicationServices

struct WindowInfo: Codable {
    let app: String
    let title: String
}

struct ObserveResult: Codable {
    let frontmostApp: String
    let frontmostWindowTitle: String
    let windows: [WindowInfo]
    let message: String
}

struct GenericResult: Codable {
    let ok: Bool
    let message: String
}

func readPayload() -> [String: Any] {
    let input = FileHandle.standardInput.readDataToEndOfFile()
    guard !input.isEmpty else { return [:] }
    let object = try? JSONSerialization.jsonObject(with: input, options: [])
    return object as? [String: Any] ?? [:]
}

func writeJSON<T: Encodable>(_ value: T) throws {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    let data = try encoder.encode(value)
    FileHandle.standardOutput.write(data)
}

func currentWindows() -> [WindowInfo] {
    guard let infoList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
        return []
    }

    return infoList.compactMap { item in
        let owner = item[kCGWindowOwnerName as String] as? String ?? ""
        let title = item[kCGWindowName as String] as? String ?? ""
        if owner.isEmpty {
            return nil
        }
        return WindowInfo(app: owner, title: title)
    }
}

func frontmostApplicationName() -> String {
    NSWorkspace.shared.frontmostApplication?.localizedName ?? ""
}

func frontmostWindowTitle() -> String {
    guard let app = NSWorkspace.shared.frontmostApplication else {
        return ""
    }

    let appElement = AXUIElementCreateApplication(app.processIdentifier)
    var focusedValue: CFTypeRef?
    let result = AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &focusedValue)
    if result != .success {
        return ""
    }

    guard let focusedWindow = focusedValue else {
        return ""
    }

    var titleValue: CFTypeRef?
    let titleResult = AXUIElementCopyAttributeValue((focusedWindow as! AXUIElement), kAXTitleAttribute as CFString, &titleValue)
    if titleResult != .success {
        return ""
    }

    return titleValue as? String ?? ""
}

func activateApp(_ name: String) throws {
    if NSWorkspace.shared.launchApplication(name) {
        return
    }

    throw NSError(domain: "MacOSAgentHelper", code: 1, userInfo: [
        NSLocalizedDescriptionKey: "无法打开应用 \(name)"
    ])
}

func openApp(_ name: String) throws {
    try activateApp(name)
}

func typeText(_ text: String) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        return
    }

    let chars = Array(text.utf16)
    let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true)
    down?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
    down?.post(tap: .cghidEventTap)

    let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: chars.count, unicodeString: chars)
    up?.post(tap: .cghidEventTap)
}

func keyCode(for key: String) -> CGKeyCode {
    switch key.lowercased() {
    case "enter", "return":
        return 36
    case "tab":
        return 48
    case "space":
        return 49
    case "escape", "esc":
        return 53
    case "left":
        return 123
    case "right":
        return 124
    case "down":
        return 125
    case "up":
        return 126
    default:
        return 36
    }
}

func flags(for modifiers: [String]) -> CGEventFlags {
    var flags: CGEventFlags = []
    for modifier in modifiers {
        switch modifier.lowercased() {
        case "command", "cmd":
            flags.insert(.maskCommand)
        case "shift":
            flags.insert(.maskShift)
        case "option", "alt":
            flags.insert(.maskAlternate)
        case "control", "ctrl":
            flags.insert(.maskControl)
        default:
            break
        }
    }
    return flags
}

func pressKey(_ key: String, modifiers: [String]) {
    guard let source = CGEventSource(stateID: .hidSystemState) else {
        return
    }

    let code = keyCode(for: key)
    let eventFlags = flags(for: modifiers)

    let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true)
    down?.flags = eventFlags
    down?.post(tap: .cghidEventTap)

    let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
    up?.flags = eventFlags
    up?.post(tap: .cghidEventTap)
}

func clickAt(x: Double, y: Double) {
    let point = CGPoint(x: x, y: y)
    let move = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    move?.post(tap: .cghidEventTap)
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    up?.post(tap: .cghidEventTap)
}

let payload = readPayload()
let command = CommandLine.arguments.dropFirst().first ?? "observe"

do {
    switch command {
    case "observe":
        try writeJSON(
            ObserveResult(
                frontmostApp: frontmostApplicationName(),
                frontmostWindowTitle: frontmostWindowTitle(),
                windows: Array(currentWindows().prefix(20)),
                message: "observed"
            )
        )
    case "activate_app":
        let app = payload["app"] as? String ?? ""
        try activateApp(app)
        try writeJSON(GenericResult(ok: true, message: "已切换到应用 \(app)"))
    case "open_app":
        let app = payload["app"] as? String ?? ""
        try openApp(app)
        try writeJSON(GenericResult(ok: true, message: "已打开应用 \(app)"))
    case "type_text":
        typeText(payload["text"] as? String ?? "")
        try writeJSON(GenericResult(ok: true, message: "已输入文本"))
    case "press_key":
        let key = payload["key"] as? String ?? "enter"
        let modifiers = payload["modifiers"] as? [String] ?? []
        pressKey(key, modifiers: modifiers)
        try writeJSON(GenericResult(ok: true, message: "已发送按键 \(key)"))
    case "click_at":
        let x = payload["x"] as? Double ?? 0
        let y = payload["y"] as? Double ?? 0
        clickAt(x: x, y: y)
        try writeJSON(GenericResult(ok: true, message: "已点击坐标 (\(Int(x)), \(Int(y)))"))
    default:
        try writeJSON(GenericResult(ok: false, message: "未知命令 \(command)"))
    }
} catch {
    try? writeJSON(GenericResult(ok: false, message: error.localizedDescription))
    exit(1)
}
