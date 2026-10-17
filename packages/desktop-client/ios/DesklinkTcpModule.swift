import ExpoModulesCore

/**
 * The relay route's native endpoint on iOS: one 127.0.0.1 listener per
 * session, mirroring Android's `DesklinkModule` bridge functions and event
 * names (`tcpAccept`, `tcpData`, `tcpClosed` under `onSessionEvent`) so the
 * shared JS side in `src/useDesktopSession.ts` needs no per-platform fork.
 *
 * The iOS WebRTC peer lives in JavaScript (`src/native.ios.ts`, through the
 * app's `react-native-webrtc` binding), which cannot listen on a socket: this
 * module is the listener, and JavaScript only pipes each accepted connection
 * through the consumer's stream to the engine's loopback TCP port.
 */
public final class DesklinkTcpModule: Module {
  private let lock = NSLock()
  private var bridges: [String: DesklinkTcpBridge] = [:]

  public func definition() -> ModuleDefinition {
    Name("DesklinkTcp")

    Events("onSessionEvent")

    // Relay-only route: the phone listener the peer dials for its ICE-TCP
    // checks. One bridge per session; the JS side pipes each accepted
    // connection through the consumer's stream to the engine's loopback port.
    Function("startTcpBridge") { (id: String) -> Int in
      self.bridge(for: id).start()
    }

    Function("tcpWrite") { (id: String, connection: Int, data: String) -> Bool in
      self.lock.lock()
      let bridge = self.bridges[id]
      self.lock.unlock()
      return bridge?.write(connection: connection, data: data) ?? false
    }

    Function("tcpClose") { (id: String, connection: Int) -> Bool in
      self.lock.lock()
      let bridge = self.bridges[id]
      self.lock.unlock()
      return bridge?.close(connection: connection) ?? false
    }

    Function("stopTcpBridge") { (id: String) -> Bool in
      self.lock.lock()
      let bridge = self.bridges.removeValue(forKey: id)
      self.lock.unlock()
      bridge?.stop()
      return true
    }

    Function("getTcpBridgeStats") { (id: String) -> String in
      self.lock.lock()
      let bridge = self.bridges[id]
      self.lock.unlock()
      return bridge?.statsJson() ?? "{}"
    }

    OnDestroy {
      self.lock.lock()
      let bridges = Array(self.bridges.values)
      self.bridges.removeAll()
      self.lock.unlock()
      for bridge in bridges { bridge.stop() }
    }
  }

  private func bridge(for id: String) -> DesklinkTcpBridge {
    lock.lock()
    if let bridge = bridges[id] {
      lock.unlock()
      return bridge
    }
    let bridge = DesklinkTcpBridge { [weak self] name, payload in
      self?.sendEvent("onSessionEvent", [
        "sessionId": id,
        "name": name,
        "payload": payload,
      ])
    }
    bridges[id] = bridge
    lock.unlock()
    return bridge
  }
}
