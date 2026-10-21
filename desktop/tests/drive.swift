// Black-box driver for the Plain Sight desktop app tests.
//
// It operates the real app the way a person does: real key events posted to
// the app's own process (CGEventPostToPid, never to any other process) and
// reads of the window, the menu bar and the page through the Accessibility
// API. The app under test needs no test hook for any of this.
//
// The program that runs it (Terminal, VS Code) needs the Accessibility
// permission. It never asks for it: `trusted` reports the state and every
// other command refuses to run without it.
//
// Usage: drive <command> [arguments]; every command prints one JSON line.

import Cocoa
import ApplicationServices

// MARK: Output

func emit(_ obj: Any) {
    let data = try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

func fail(_ message: String) -> Never {
    emit(["ok": false, "error": message])
    exit(1)
}

// MARK: Accessibility reads

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
}

func string(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }
func role(_ el: AXUIElement) -> String { string(el, kAXRoleAttribute) ?? "" }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func appElement(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }
func windows(_ pid: pid_t) -> [AXUIElement] { (attr(appElement(pid), kAXWindowsAttribute) as? [AXUIElement]) ?? [] }

func firstMatch(_ root: AXUIElement, depth: Int = 0, _ test: (AXUIElement) -> Bool) -> AXUIElement? {
    if test(root) { return root }
    if depth > 80 { return nil }
    for child in children(root) {
        if let hit = firstMatch(child, depth: depth + 1, test) { return hit }
    }
    return nil
}

func allMatches(_ root: AXUIElement, depth: Int = 0, _ test: (AXUIElement) -> Bool, into list: inout [AXUIElement]) {
    if test(root) { list.append(root) }
    if depth > 80 { return }
    for child in children(root) { allMatches(child, depth: depth + 1, test, into: &list) }
}

// The page: the first web area in the app's main window.
func webArea(_ pid: pid_t) -> AXUIElement? {
    for window in windows(pid) {
        if let area = firstMatch(window, { role($0) == "AXWebArea" }) { return area }
    }
    return nil
}

// WebKit exposes each element's DOM id as AXDOMIdentifier. Elements that are
// hidden (display: none) are not in the tree at all.
func element(_ pid: pid_t, id: String) -> AXUIElement? {
    guard let area = webArea(pid) else { return nil }
    return firstMatch(area) { string($0, "AXDOMIdentifier") == id }
}

// A control by DOM id, or else by its visible title or label.
func control(_ pid: pid_t, _ key: String) -> AXUIElement? {
    if let el = element(pid, id: key) { return el }
    guard let area = webArea(pid) else { return nil }
    let roles: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXLink"]
    return firstMatch(area) { el in
        roles.contains(role(el)) && [string(el, kAXTitleAttribute), string(el, kAXDescriptionAttribute)].contains(key)
    }
}

// Text of an element: the values of its static text descendants, one per line.
func text(of el: AXUIElement) -> String {
    var parts: [String] = []
    func walk(_ node: AXUIElement, _ depth: Int) {
        if depth > 80 { return }
        if role(node) == "AXStaticText", let value = string(node, kAXValueAttribute) { parts.append(value) }
        for child in children(node) { walk(child, depth + 1) }
    }
    walk(el, 0)
    return parts.joined(separator: "\n")
}

func describe(_ el: AXUIElement) -> [String: Any] {
    var d: [String: Any] = ["role": role(el)]
    for (key, name) in [("subrole", kAXSubroleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute), ("id", "AXDOMIdentifier")] {
        if let v = string(el, name) { d[key] = v }
    }
    if let v = attr(el, kAXValueAttribute) {
        if let s = v as? String { d["value"] = s } else if let n = v as? NSNumber { d["value"] = n }
    }
    if let enabled = attr(el, kAXEnabledAttribute) as? Bool { d["enabled"] = enabled }
    return d
}

// MARK: Key events

// A private event source: the posted events carry only the modifiers given
// here, never whatever keys a person happens to hold.
let source = CGEventSource(stateID: .privateState)

// US layout key codes, for the code of typed characters and for chords.
let keyCodes: [String: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25,
    "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38,
    "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50,
    "return": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "left": 123, "right": 124, "down": 125, "up": 126
]
let shifted: [Character: String] = [
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9", ")": "0",
    "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'", "<": ",", ">": ".", "?": "/", "~": "`"
]
let modifierKeys: [(name: String, code: CGKeyCode, flag: CGEventFlags)] = [
    ("cmd", 55, .maskCommand), ("shift", 56, .maskShift), ("alt", 58, .maskAlternate), ("ctrl", 59, .maskControl)
]

func post(_ pid: pid_t, code: CGKeyCode, down: Bool, flags: CGEventFlags, unicode: String? = nil) {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down) else { fail("could not create a key event") }
    event.flags = flags
    if let unicode {
        let units = Array(unicode.utf16)
        event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
    }
    event.postToPid(pid)
    usleep(6_000)
}

// Types text one character at a time, each as a key down and a key up.
func typeText(_ pid: pid_t, _ text: String, delayMs: UInt32) {
    for ch in text {
        let lower = String(ch).lowercased()
        var flags: CGEventFlags = []
        var code: CGKeyCode = 0
        if ch == "\n" { code = 36 } else if ch == "\t" { code = 48 } else if ch == " " { code = 49 }
        else if let c = keyCodes[lower], lower.count == 1 { code = c; if ch.isUppercase { flags = .maskShift } }
        else if let base = shifted[ch], let c = keyCodes[base] { code = c; flags = .maskShift }
        let unicode = (ch == "\n") ? "\r" : String(ch)
        post(pid, code: code, down: true, flags: flags, unicode: unicode)
        post(pid, code: code, down: false, flags: flags, unicode: unicode)
        usleep(delayMs * 1000)
    }
}

// Presses a chord such as "cmd+shift+g", "escape" or "cmd+return": the
// modifiers go down in order, the key goes down and up, the modifiers lift.
func chord(_ pid: pid_t, _ spec: String) {
    let parts = spec.lowercased().split(separator: "+").map(String.init)
    guard let keyName = parts.last, let code = keyCodes[keyName] else { fail("unknown key in \(spec)") }
    var flags: CGEventFlags = []
    var held: [(code: CGKeyCode, flag: CGEventFlags)] = []
    for name in parts.dropLast() {
        guard let m = modifierKeys.first(where: { $0.name == name }) else { fail("unknown modifier \(name)") }
        flags.insert(m.flag)
        held.append((m.code, m.flag))
        post(pid, code: m.code, down: true, flags: flags)
    }
    post(pid, code: code, down: true, flags: flags)
    post(pid, code: code, down: false, flags: flags)
    for m in held.reversed() {
        flags.remove(m.flag)
        post(pid, code: m.code, down: false, flags: flags)
    }
}

// MARK: Focus, menus, clipboard, idle time

// LaunchServices' answer, read fresh by each run of this program. It is
// loginwindow while the screen is locked.
func frontmostPid() -> pid_t? { NSWorkspace.shared.frontmostApplication?.processIdentifier }
func isFrontmost(_ pid: pid_t) -> Bool { frontmostPid() == pid }

func bringToFront(_ pid: pid_t) -> Bool {
    AXUIElementSetAttributeValue(appElement(pid), kAXFrontmostAttribute as CFString, kCFBooleanTrue)
    NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    for _ in 0..<60 {
        if isFrontmost(pid) { return true }
        RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
    }
    return false
}

func menuBar(_ pid: pid_t) -> AXUIElement? {
    guard let bar = attr(appElement(pid), kAXMenuBarAttribute) else { return nil }
    return (bar as! AXUIElement)
}

func menuItems(_ menuBarItem: AXUIElement) -> [AXUIElement] {
    guard let menu = children(menuBarItem).first else { return [] }
    return children(menu)
}

// Seconds since a person last touched the keyboard, mouse or trackpad. The
// combined session state ignores the events this program posts from its
// private source; the HID idle time does not (it was reset by every posted key).
func hidIdleSeconds() -> Double {
    CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~0)!)
}

// MARK: Commands

let args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first else { fail("no command") }

func pidArg(_ i: Int = 1) -> pid_t {
    guard args.count > i, let pid = pid_t(args[i]) else { fail("missing pid") }
    return pid
}

func needTrust() {
    if !AXIsProcessTrusted() { fail("Accessibility permission is not granted to the program running this driver") }
}

switch command {
case "trusted":
    emit(["ok": true, "accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess()])

case "idle":
    emit(["ok": true, "seconds": hidIdleSeconds()])

case "session":
    // Whether the screen is locked: while it is, macOS keeps every window's
    // contents and the keyboard away from other programs.
    let info = (CGSessionCopyCurrentDictionary() as? [String: Any]) ?? [:]
    emit(["ok": true, "locked": (info["CGSSessionScreenIsLocked"] as? Bool) ?? false, "idle": hidIdleSeconds()])

case "cgwindows":
    // cgwindows <pid>: the app's windows as the window server lists them
    // (bounds and layer need no permission; titles would).
    let pid = pidArg()
    let list = (CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let mine = list.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.map { w -> [String: Any] in
        let b = (w[kCGWindowBounds as String] as? [String: Any]) ?? [:]
        return ["layer": w[kCGWindowLayer as String] ?? -1, "onscreen": (w[kCGWindowIsOnscreen as String] as? Bool) ?? false,
                "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "width": b["Width"] ?? 0, "height": b["Height"] ?? 0]
    }
    emit(["ok": true, "windows": mine])

case "frontmost":
    needTrust()
    let pid = frontmostPid()
    emit(["ok": true, "pid": pid.map { Int($0) } ?? -1])

case "front":
    needTrust()
    let pid = pidArg()
    emit(["ok": bringToFront(pid), "pid": Int(pid)])

case "windows":
    needTrust()
    let pid = pidArg()
    let list = windows(pid).map { w -> [String: Any] in
        var d = describe(w)
        d["focused"] = (attr(w, kAXFocusedAttribute) as? Bool) ?? false
        d["minimized"] = (attr(w, kAXMinimizedAttribute) as? Bool) ?? false
        d["main"] = (attr(w, kAXMainAttribute) as? Bool) ?? false
        var origin = CGPoint.zero, size = CGSize.zero
        if let p = attr(w, kAXPositionAttribute) { AXValueGetValue(p as! AXValue, .cgPoint, &origin) }
        if let s = attr(w, kAXSizeAttribute) { AXValueGetValue(s as! AXValue, .cgSize, &size) }
        d["frame"] = [origin.x, origin.y, size.width, size.height]
        d["sheets"] = children(w).filter { role($0) == "AXSheet" }.map { describe($0) }
        d["hasWebArea"] = firstMatch(w, { role($0) == "AXWebArea" }) != nil
        return d
    }
    emit(["ok": true, "frontmost": isFrontmost(pid), "windows": list])

case "text":
    // text <pid> <dom id>: the element's text, or present=false when it is not on screen.
    needTrust()
    let pid = pidArg()
    guard args.count > 2 else { fail("missing dom id") }
    if let el = element(pid, id: args[2]) {
        emit(["ok": true, "present": true, "text": text(of: el)])
    } else {
        emit(["ok": true, "present": false, "webArea": webArea(pid) != nil])
    }

case "controls":
    // Every button, checkbox, radio button and text field on the page.
    needTrust()
    let pid = pidArg()
    guard let area = webArea(pid) else { fail("no web area") }
    var found: [AXUIElement] = []
    let roles: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXTextField", "AXTextArea", "AXLink", "AXPopUpButton"]
    allMatches(area, { roles.contains(role($0)) }, into: &found)
    emit(["ok": true, "controls": found.map { describe($0) }])

case "focused":
    needTrust()
    let pid = pidArg()
    if let el = attr(appElement(pid), kAXFocusedUIElementAttribute) {
        emit(["ok": true, "focused": describe(el as! AXUIElement)])
    } else {
        emit(["ok": true, "focused": NSNull()])
    }

case "press":
    // press <pid> <dom id or title>: the accessibility press action, as a click.
    needTrust()
    let pid = pidArg()
    guard args.count > 2, let el = control(pid, args[2]) else { fail("control not found: \(args.count > 2 ? args[2] : "")") }
    let result = AXUIElementPerformAction(el, kAXPressAction as CFString)
    emit(["ok": result == .success, "axError": result.rawValue])

case "click":
    // click <pid> <dom id or title>: a real left click at the control's centre,
    // posted to the app's process, for paths where a press is not enough.
    needTrust()
    let pid = pidArg()
    guard args.count > 2, let el = control(pid, args[2]) else { fail("control not found: \(args.count > 2 ? args[2] : "")") }
    var origin = CGPoint.zero, size = CGSize.zero
    guard let p = attr(el, kAXPositionAttribute), let s = attr(el, kAXSizeAttribute) else { fail("control has no frame") }
    AXValueGetValue(p as! AXValue, .cgPoint, &origin)
    AXValueGetValue(s as! AXValue, .cgSize, &size)
    let point = CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
    if !isFrontmost(pid) { fail("the app is not in front; the click would not reach it") }
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { fail("could not create a mouse event") }
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.postToPid(pid)
        usleep(30_000)
    }
    emit(["ok": true, "at": [point.x, point.y]])

case "quit-app":
    // quit-app <pid>: asks the app to quit the way the Dock's Quit does (a
    // quit request through LaunchServices, not a key press or a signal).
    let pid = pidArg()
    guard let running = NSRunningApplication(processIdentifier: pid) else { fail("no app with that pid") }
    emit(["ok": running.terminate(), "pid": Int(pid)])

case "close-button":
    // close-button <pid> [click]: the red close button of the app's document
    // window, pressed through Accessibility (the button sends its window
    // performClose: itself, so this works when the app is not in front), or
    // with "click" a real left click at the button's centre, posted to the
    // app's process while it is in front.
    needTrust()
    let pid = pidArg()
    guard let w = windows(pid).first(where: { (attr($0, kAXSubroleAttribute) as? String) == "AXStandardWindow" }) else { fail("no document window") }
    guard let found = attr(w, kAXCloseButtonAttribute) else { fail("the window has no close button") }
    let button = found as! AXUIElement
    if args.count > 2 && args[2] == "click" {
        var origin = CGPoint.zero, size = CGSize.zero
        guard let p = attr(button, kAXPositionAttribute), let s = attr(button, kAXSizeAttribute) else { fail("the close button has no frame") }
        AXValueGetValue(p as! AXValue, .cgPoint, &origin)
        AXValueGetValue(s as! AXValue, .cgSize, &size)
        let point = CGPoint(x: origin.x + size.width / 2, y: origin.y + size.height / 2)
        if !isFrontmost(pid) { fail("the app is not in front; the click would not reach it") }
        for type in [CGEventType.leftMouseDown, .leftMouseUp] {
            guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { fail("could not create a mouse event") }
            event.setIntegerValueField(.mouseEventClickState, value: 1)
            event.postToPid(pid)
            usleep(30_000)
        }
        emit(["ok": true, "at": [point.x, point.y]])
    } else {
        let result = AXUIElementPerformAction(button, kAXPressAction as CFString)
        emit(["ok": result == .success, "axError": result.rawValue])
    }

case "clickat":
    // clickat <pid> <x> <y>: a real left click at a screen point (top-left
    // origin), posted to the app's process, for example to put the focus on
    // the page itself.
    needTrust()
    let pid = pidArg()
    guard args.count > 3, let x = Double(args[2]), let y = Double(args[3]) else { fail("usage: clickat <pid> <x> <y>") }
    if !isFrontmost(pid) { fail("the app is not in front; the click would not reach it") }
    for type in [CGEventType.leftMouseDown, .leftMouseUp] {
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: CGPoint(x: x, y: y), mouseButton: .left) else { fail("could not create a mouse event") }
        event.setIntegerValueField(.mouseEventClickState, value: 1)
        event.postToPid(pid)
        usleep(30_000)
    }
    emit(["ok": true, "at": [x, y]])

case "tree":
    // tree <pid> [depth]: the accessibility tree of every window, for debugging.
    needTrust()
    let pid = pidArg()
    let limit = args.count > 2 ? Int(args[2]) ?? 12 : 12
    func node(_ el: AXUIElement, _ depth: Int) -> [String: Any] {
        var d = describe(el)
        if depth < limit {
            let kids = children(el)
            if !kids.isEmpty { d["children"] = kids.map { node($0, depth + 1) } }
        }
        return d
    }
    emit(["ok": true, "windows": windows(pid).map { node($0, 0) }])

case "focus":
    needTrust()
    let pid = pidArg()
    guard args.count > 2, let el = control(pid, args[2]) else { fail("control not found") }
    let result = AXUIElementSetAttributeValue(el, kAXFocusedAttribute as CFString, kCFBooleanTrue)
    emit(["ok": result == .success, "axError": result.rawValue])

case "type":
    // type <pid> <text> [delay ms]: needs the app in front so the keys reach its key window.
    needTrust()
    let pid = pidArg()
    guard args.count > 2 else { fail("missing text") }
    let delay = args.count > 3 ? UInt32(args[3]) ?? 12 : 12
    if !isFrontmost(pid) { fail("the app is not in front; keys would not reach it") }
    typeText(pid, args[2], delayMs: delay)
    emit(["ok": true, "typed": args[2].count])

case "key":
    needTrust()
    let pid = pidArg()
    guard args.count > 2 else { fail("missing chord") }
    if !isFrontmost(pid) { fail("the app is not in front; keys would not reach it") }
    chord(pid, args[2])
    emit(["ok": true, "chord": args[2]])

case "menus":
    needTrust()
    let pid = pidArg()
    guard let bar = menuBar(pid) else { fail("no menu bar") }
    let menus = children(bar).map { item -> [String: Any] in
        let entries = menuItems(item).map { mi -> [String: Any] in
            var d: [String: Any] = ["title": string(mi, kAXTitleAttribute) ?? ""]
            if let ch = string(mi, "AXMenuItemCmdChar"), !ch.isEmpty { d["key"] = ch }
            if let mods = attr(mi, "AXMenuItemCmdModifiers") as? NSNumber { d["mods"] = mods }
            if let enabled = attr(mi, kAXEnabledAttribute) as? Bool { d["enabled"] = enabled }
            return d
        }
        return ["title": string(item, kAXTitleAttribute) ?? "", "items": entries]
    }
    emit(["ok": true, "menus": menus])

case "menu":
    // menu <pid> <menu title> <item title>
    needTrust()
    let pid = pidArg()
    guard args.count > 3, let bar = menuBar(pid) else { fail("usage: menu <pid> <menu> <item>") }
    guard let top = children(bar).first(where: { string($0, kAXTitleAttribute) == args[2] }) else { fail("menu not found: \(args[2])") }
    guard let item = menuItems(top).first(where: { string($0, kAXTitleAttribute) == args[3] }) else { fail("menu item not found: \(args[3])") }
    let result = AXUIElementPerformAction(item, kAXPressAction as CFString)
    emit(["ok": result == .success, "axError": result.rawValue])

case "clip-save":
    // Keeps every item and type on the clipboard so a test can put it back.
    guard args.count > 1 else { fail("missing file") }
    var items: [[String: Data]] = []
    for item in NSPasteboard.general.pasteboardItems ?? [] {
        var entry: [String: Data] = [:]
        for type in item.types { if let data = item.data(forType: type) { entry[type.rawValue] = data } }
        items.append(entry)
    }
    let data = try! PropertyListSerialization.data(fromPropertyList: items, format: .binary, options: 0)
    try! data.write(to: URL(fileURLWithPath: args[1]))
    emit(["ok": true, "items": items.count])

case "clip-restore":
    guard args.count > 1, let data = FileManager.default.contents(atPath: args[1]),
          let items = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [[String: Data]] else { fail("unreadable clipboard file") }
    let board = NSPasteboard.general
    board.clearContents()
    let objects = items.map { entry -> NSPasteboardItem in
        let item = NSPasteboardItem()
        for (type, value) in entry { item.setData(value, forType: NSPasteboard.PasteboardType(type)) }
        return item
    }
    if !objects.isEmpty { board.writeObjects(objects) }
    emit(["ok": true, "items": objects.count])

case "clip-text":
    let value = NSPasteboard.general.string(forType: .string)
    emit(["ok": true, "text": value.map { $0 as Any } ?? NSNull()])

default:
    fail("unknown command \(command)")
}
