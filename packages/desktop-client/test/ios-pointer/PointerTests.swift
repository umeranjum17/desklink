import XCTest

/**
 * The trackpad half of test/ios-flow.mjs: it drives the example app, already
 * running on an iPad simulator, with a pointer, which `axe` cannot. It also
 * turns the simulator between portrait and landscape. The flow
 * passes the steps in screen points as TEST_RUNNER_DESKLINK_POINTER; the
 * desktop's page records what arrives.
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
      // A press in place: what the flow measures an instrument's aim with.
      case "press": point.press(forDuration: step.dy ?? 0.15)
      case "drag":
        point.click(forDuration: 0.4, thenDragTo: at(step.toX ?? step.x, step.toY ?? step.y))
      case "dragTouch":
        // A finger that rests, travels, then lifts: what a phone drags with. A
        // phone takes no pointer events, so this is synthesized touch instead.
        let record = XCSynthesizedEventRecord(name: "Touch drag", interfaceOrientation: .portrait)
        let path = XCPointerEventPath(touch: CGPoint(x: step.x, y: step.y), offset: 0)
        for index in 0...2 { path.move(to: CGPoint(x: step.x, y: step.y), at: 0.15 * Double(index)) }
        for index in 1...20 {
          path.move(to: CGPoint(x: step.x + ((step.toX ?? step.x) - step.x) * Double(index) / 20,
                                y: step.y + ((step.toY ?? step.y) - step.y) * Double(index) / 20), at: 0.45 + 0.02 * Double(index))
        }
        path.lift(at: 0.95)
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
      case "landscape": XCUIDevice.shared.orientation = .landscapeLeft
      case "portrait": XCUIDevice.shared.orientation = .portrait
      default: XCTFail("unknown step \(step.action)")
      }
      // The desktop's page records each step before the next begins.
      Thread.sleep(forTimeInterval: 1)
    }
  }
}
