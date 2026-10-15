import XCTest

/**
 * The touch half of test/ios-flow.mjs: it drives the example app, already
 * running on a simulator, with touches the XCUITest runner synthesizes at a
 * screen coordinate - a tap, a drag, two fingers, a pinch - and with taps on
 * the app's own controls, which `axe` cannot reach without a pointer. It also
 * turns the simulator between portrait and landscape. The flow passes the steps
 * in screen points as TEST_RUNNER_DESKLINK_POINTER; the desktop's page records
 * what arrives. A step that waits for the app to say something writes it to
 * DESKLINK_POINTER_NOTE, because the pill it waits for is gone long before
 * `xcodebuild` hands this test's result back to the flow.
 */
final class PointerTests: XCTestCase {
  struct Step: Decodable {
    let action: String
    let x: Double
    let y: Double
    let toX: Double?
    let toY: Double?
    let dy: Double?
    let span: Double?
    let scale: Double?
    let id: String?
    let text: String?
    let wait: Double?
    let hold: Double?
  }

  func testPointer() throws {
    let raw = try XCTUnwrap(ProcessInfo.processInfo.environment["DESKLINK_POINTER"], "the flow passes the steps")
    let steps = try JSONDecoder().decode([Step].self, from: Data(raw.utf8))
    let app = XCUIApplication(bundleIdentifier: "dev.desklink.example")
    app.activate()
    XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "the example app is in front")
    let origin = app.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
    func at(_ x: Double, _ y: Double) -> XCUICoordinate { origin.withOffset(CGVector(dx: x, dy: y)) }
    for step in steps {
      let point = at(step.x, step.y)
      switch step.action {
      case "hover": point.hover()
      // One finger down and up where it was aimed: the whole glass journey's
      // tap, delivered by UIKit's own hit-testing, not by a handler call.
      case "tap": point.tap()
      // A press in place: what the flow measures an instrument's aim with.
      case "press": point.press(forDuration: step.dy ?? 0.15)
      case "drag":
        point.click(forDuration: 0.4, thenDragTo: at(step.toX ?? step.x, step.toY ?? step.y))
      case "dragTouch":
        // A finger that rests, travels, then lifts: what a phone drags with. A
        // phone takes no pointer events, so this is synthesized touch instead.
        // The rest is longer than the app's own 500 ms arm delay, so the
        // desktop's button really goes down and the finger drags; a shorter rest
        // is a race with that timer and loses it on a busy machine. `hold: 0`
        // travels at once - the hover a pointer mark is read over.
        let hold = step.hold ?? 0.8
        let record = XCSynthesizedEventRecord(name: "Touch drag", interfaceOrientation: .portrait)
        let path = XCPointerEventPath(touch: CGPoint(x: step.x, y: step.y), offset: 0)
        if hold > 0 { for index in 0...2 { path.move(to: CGPoint(x: step.x, y: step.y), at: hold * Double(index) / 2) } }
        for index in 1...20 {
          path.move(to: CGPoint(x: step.x + ((step.toX ?? step.x) - step.x) * Double(index) / 20,
                                y: step.y + ((step.toY ?? step.y) - step.y) * Double(index) / 20), at: hold + 0.02 * Double(index))
        }
        path.lift(at: hold + 0.55)
        record.add(path)
        try record.synthesize()
      case "rightClick": point.rightClick()
      case "scroll": point.scroll(byDeltaX: 0, deltaY: step.dy ?? 0)
      case "pinch":
        let span = try XCTUnwrap(step.span)
        let scale = try XCTUnwrap(step.scale)
        XCTAssertGreaterThan(span, 0)
        XCTAssertGreaterThan(scale, 1)
        let record = XCSynthesizedEventRecord(name: "Portrait zoom", interfaceOrientation: .portrait)
        for (finger, direction) in [-1.0, 1.0].enumerated() {
          let path = XCPointerEventPath(touch: CGPoint(x: step.x + direction * span / 2, y: step.y), offset: Double(finger) * 0.05)
          for index in 0...10 {
            let factor = 1 + (scale - 1) * Double(index) / 10
            path.move(to: CGPoint(x: step.x + direction * span * factor / 2, y: step.y), at: 0.1 + Double(index) * 0.05)
          }
          path.lift(at: 0.7)
          record.add(path)
        }
        try record.synthesize()
      case "scrollTwo":
        // Two fingers travelling together: what a phone scrolls with, which a
        // single-finger drag pans the picture with instead.
        let record = XCSynthesizedEventRecord(name: "Two-finger scroll", interfaceOrientation: .portrait)
        let travel = step.dy ?? 200
        for (finger, side) in [-1.0, 1.0].enumerated() {
          let x = step.x + side * 60
          let path = XCPointerEventPath(touch: CGPoint(x: x, y: step.y), offset: Double(finger) * 0.05)
          for index in 0...10 {
            path.move(to: CGPoint(x: x, y: step.y + travel * Double(index) / 10), at: 0.1 + Double(index) * 0.05)
          }
          path.lift(at: 0.7)
          record.add(path)
        }
        try record.synthesize()
      // A button by its test id: the element's own frame, in whichever way the screen is turned.
      case "tapButton": app.buttons[try XCTUnwrap(step.id)].tap()
      // Read what the app said, while it is still saying it. The clipboard
      // confirmation pill lives a second and a half; by the time xcodebuild has
      // torn this runner down the flow cannot see it any more, so the runner
      // reads it here and hands the words back through a file. The system's own
      // paste consent is not the app's dialog: it is granted here, as a finger
      // would, instead of waiting out a prompt nobody dismissed - it arrives a
      // moment after the tap, so it is looked for while the app is still quiet.
      case "waitForText":
        let want = try XCTUnwrap(step.text)
        let deadline = Date().addingTimeInterval(step.wait ?? 15)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        var said: String?
        var checked = Date.distantPast
        while Date() < deadline && said == nil {
          if Date().timeIntervalSince(checked) > 0.5 {
            checked = Date()
            for candidate in [springboard, app] {
              let allow = candidate.buttons["Allow Paste"]
              if allow.exists { allow.tap(); Thread.sleep(forTimeInterval: 0.3) }
            }
          }
          said = app.descendants(matching: .any).allElementsBoundByIndex
            .compactMap { $0.label.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first { $0.contains(want) }
          if said == nil { Thread.sleep(forTimeInterval: 0.1) }
        }
        if let note = ProcessInfo.processInfo.environment["DESKLINK_POINTER_NOTE"] {
          try? (said ?? "").write(toFile: note, atomically: true, encoding: .utf8)
        }
        XCTAssertNotNil(said, "the app never said \(want)")
      case "landscape": XCUIDevice.shared.orientation = .landscapeLeft
      case "portrait": XCUIDevice.shared.orientation = .portrait
      default: XCTFail("unknown step \(step.action)")
      }
      // The desktop's page records each step before the next begins.
      Thread.sleep(forTimeInterval: 1)
    }
  }
}
