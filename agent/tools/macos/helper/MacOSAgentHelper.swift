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
    default:
        try writeJSON(GenericResult(ok: false, message: "未知命令 \(command)"))
    }
} catch {
    try? writeJSON(GenericResult(ok: false, message: error.localizedDescription))
    exit(1)
}
