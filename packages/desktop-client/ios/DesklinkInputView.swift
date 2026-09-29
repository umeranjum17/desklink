import ExpoModulesCore
import UIKit

/**
 * The desktop surface on iOS: the view around the picture and the hidden text
 * field, reporting the input React Native's touch system never sees.
 *
 * Keys: while control is enabled this view is the first responder, so a
 * hardware keyboard's presses arrive here with their down and up — arrows,
 * Esc, Tab and Command chords a text field does not report. The hidden text
 * field takes over while the app shows the on-screen keyboard; keys it does not
 * use still bubble up to this view, and the view takes the keyboard back when
 * the field lets go.
 *
 * Pointer: an iPad trackpad or mouse hovering the view and its scroll. Its
 * presses arrive with the button that made them only once the app sets
 * `UIApplicationSupportsIndirectInputEvents` (the package's config plugin);
 * until then UIKit hands them to React Native as touches.
 */
final class DesklinkInputView: ExpoView {
  let onKey = EventDispatcher()
  let onPointer = EventDispatcher()
  let onWheel = EventDispatcher()

  var enabled = false {
    didSet {
      guard enabled != oldValue else { return }
      if enabled {
        takeKeyboard(fromTouch: false)
      } else {
        releaseKeys()
        if isFirstResponder { resignFirstResponder() }
      }
    }
  }

  /** Keys pressed here and not yet released, so none stays down on the desktop. */
  private var held: [UIKeyboardHIDUsage: UIKey] = [:]

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    addGestureRecognizer(UIHoverGestureRecognizer(target: self, action: #selector(hovered(_:))))
    // A trackpad's or wheel's scroll only: touches stay with React Native.
    let scroll = UIPanGestureRecognizer(target: self, action: #selector(scrolled(_:)))
    scroll.allowedScrollTypesMask = .all
    scroll.allowedTouchTypes = []
    addGestureRecognizer(scroll)
    NotificationCenter.default.addObserver(
      self, selector: #selector(editingEnded(_:)), name: UITextField.textDidEndEditingNotification, object: nil)
  }

  // MARK: - Keyboard focus

  override var canBecomeFirstResponder: Bool { enabled }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil { releaseKeys() } else { takeKeyboard(fromTouch: false) }
  }

  override func resignFirstResponder() -> Bool {
    let resigned = super.resignFirstResponder()
    if resigned { releaseKeys() }
    return resigned
  }

  /**
   * Become the keyboard's target. On its own the view never takes the keyboard
   * from a responder that has it — another field of the app, say. A touch on
   * the desktop does, like a tap on any field, except from the view's own text
   * field, which keeps the on-screen keyboard up.
   */
  private func takeKeyboard(fromTouch: Bool) {
    guard enabled, window != nil, !isFirstResponder else { return }
    if let current = DesklinkInputView.currentFirstResponder() {
      if !fromTouch { return }
      if let view = current as? UIView, view.isDescendant(of: self) { return }
    }
    becomeFirstResponder()
  }

  @objc private func editingEnded(_ notification: Notification) {
    guard let field = notification.object as? UIView, field.isDescendant(of: self) else { return }
    // Once the field has let go, the keyboard comes back to the desktop.
    DispatchQueue.main.async { [weak self] in self?.takeKeyboard(fromTouch: false) }
  }

  fileprivate static weak var found: UIResponder?

  static func currentFirstResponder() -> UIResponder? {
    found = nil
    UIApplication.shared.sendAction(#selector(UIResponder.desklinkReportFirstResponder), to: nil, from: nil, for: nil)
    // With no first responder the action ends at the application itself.
    return found?.isFirstResponder == true ? found : nil
  }

  // MARK: - Keys

  override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    var rest = Set<UIPress>()
    for press in presses {
      guard enabled, let key = press.key else { rest.insert(press); continue }
      held[key.keyCode] = key
      report(key, down: true)
    }
    if !rest.isEmpty { super.pressesBegan(rest, with: event) }
  }

  override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let rest = release(presses)
    if !rest.isEmpty { super.pressesEnded(rest, with: event) }
  }

  override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
    let rest = release(presses)
    if !rest.isEmpty { super.pressesCancelled(rest, with: event) }
  }

  /** Report the keys among `presses` that went down here; the rest belong to someone else. */
  private func release(_ presses: Set<UIPress>) -> Set<UIPress> {
    var rest = Set<UIPress>()
    for press in presses {
      guard let key = press.key, held.removeValue(forKey: key.keyCode) != nil else { rest.insert(press); continue }
      report(key, down: false)
    }
    return rest
  }

  /** Let go of every key still down: the desktop must not keep one held. */
  private func releaseKeys() {
    for key in held.values { report(key, down: false) }
    held.removeAll()
  }

  /** The key's HID usage and the characters it types; JavaScript names it. Command is the desktop's Meta. */
  private func report(_ key: UIKey, down: Bool) {
    var modifiers: [String] = []
    if key.modifierFlags.contains(.control) { modifiers.append("Control") }
    if key.modifierFlags.contains(.alternate) { modifiers.append("Alt") }
    if key.modifierFlags.contains(.command) { modifiers.append("Meta") }
    if key.modifierFlags.contains(.shift) { modifiers.append("Shift") }
    onKey(["down": down, "usage": key.keyCode.rawValue, "characters": key.characters, "modifiers": modifiers])
  }

  // MARK: - Pointer

  override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesBegan(touches, with: event)
    guard enabled else { return }
    takeKeyboard(fromTouch: true)
    report(touches, phase: "down", event)
  }

  override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesMoved(touches, with: event)
    if enabled { report(touches, phase: "move", event) }
  }

  override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesEnded(touches, with: event)
    if enabled { report(touches, phase: "up", event) }
  }

  override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) {
    super.touchesCancelled(touches, with: event)
    if enabled { report(touches, phase: "cancel", event) }
  }

  /**
   * A press of a trackpad or mouse with the button that made it. The touch's
   * timestamp is the one React Native reports for the same touch, so the view
   * can tell this press from a finger.
   */
  private func report(_ touches: Set<UITouch>, phase: String, _ event: UIEvent?) {
    for touch in touches where touch.type == .indirectPointer {
      let at = touch.location(in: self)
      onPointer([
        "phase": phase, "x": at.x, "y": at.y,
        "buttons": event?.buttonMask.rawValue ?? 0, "timestamp": touch.timestamp * 1000,
      ])
    }
  }

  @objc private func hovered(_ recognizer: UIHoverGestureRecognizer) {
    guard enabled, recognizer.state == .began || recognizer.state == .changed else { return }
    let at = recognizer.location(in: self)
    onPointer(["phase": "hover", "x": at.x, "y": at.y])
  }

  @objc private func scrolled(_ recognizer: UIPanGestureRecognizer) {
    guard enabled else { return }
    let at = recognizer.location(in: self)
    let moved = recognizer.translation(in: self)
    recognizer.setTranslation(.zero, in: self)
    let phase: String
    switch recognizer.state {
    case .began: phase = "begin"
    case .changed: phase = "move"
    default: phase = "end"
    }
    onWheel(["phase": phase, "dx": moved.x, "dy": moved.y, "x": at.x, "y": at.y])
  }
}

extension UIResponder {
  @objc fileprivate func desklinkReportFirstResponder() {
    DesklinkInputView.found = self
  }
}
