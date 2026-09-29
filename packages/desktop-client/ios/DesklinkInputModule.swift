import ExpoModulesCore

/**
 * The iOS view's hardware input: the keys and the pointer React Native's touch
 * system cannot see. The session, the picture and touch gestures stay in
 * JavaScript; this module only reports what UIKit delivers.
 */
public final class DesklinkInputModule: Module {
  public func definition() -> ModuleDefinition {
    Name("DesklinkInput")

    View(DesklinkInputView.self) {
      Events("onKey", "onPointer", "onWheel")

      Prop("enabled") { (view: DesklinkInputView, enabled: Bool) in
        view.enabled = enabled
      }
    }
  }
}
