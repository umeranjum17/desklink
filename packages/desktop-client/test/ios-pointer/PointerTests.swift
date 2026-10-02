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
      case "drag": point.click(forDuration: 0.4, thenDragTo: at(step.toX ?? step.x, step.toY ?? step.y))
      case "rightClick": point.rightClick()
      case "scroll": point.scroll(byDeltaX: 0, deltaY: step.dy ?? 0)
      case "landscape": XCUIDevice.shared.orientation = .landscapeLeft
      case "portrait": XCUIDevice.shared.orientation = .portrait
      default: XCTFail("unknown step \(step.action)")
      }
      // The desktop's page records each step before the next begins.
      Thread.sleep(forTimeInterval: 1)
    }
  }
}
