import Foundation

/**
 * The native side of the relay route: a 127.0.0.1 listener the native peer
 * dials for its ICE-TCP checks, with every accepted connection piped through
 * the consumer's stream on the JS side.
 *
 * Reads batch by size or deadline — one `tcpData` event per flush, never one
 * per packet — and writes from JS arrive already batched the same way, so a
 * video stream crosses the bridge in a handful of calls per second. Bytes are
 * never interpreted here: DTLS and STUN pass through untouched.
 *
 * This is the iOS twin of Android's `TcpBridge.kt`: same contract (start,
 * write, close, stop, statsJson), same batching (8 KB or ~12 ms), same event
 * names (`tcpAccept`, `tcpData`, `tcpClosed`) and payloads. The JS side in
 * `src/useDesktopSession.ts` is shared, not forked per platform.
 */
final class DesklinkTcpBridge {
  /** A read that finds nothing this fast flushes what it already holds. */
  private static let readTimeoutMicroseconds: __suseconds_t = 12_000
  /** A flush carries at most this many bytes: batches, not per-packet storms. */
  private static let flushBytes = 8192

  private let lock = NSLock()
  private let work = DispatchQueue(label: "desklink-tcpbridge")
  private let onEvent: (String, [String: Any]) -> Void
  private var serverFd: Int32 = -1
  private var sockets: [Int: Int32] = [:]
  private var nextConnection = 0
  private var totalConnections = 0
  private var openConnections = 0
  private var bytesToEngine: Int64 = 0
  private var bytesFromEngine: Int64 = 0
  private var events: Int64 = 0
  private var running = false

  init(onEvent: @escaping (String, [String: Any]) -> Void) {
    self.onEvent = onEvent
  }

  /** Bind the phone listener; the port, or 0 when it cannot start. */
  func start() -> Int {
    lock.lock()
    if running {
      let port = boundPortLocked()
      lock.unlock()
      return port
    }
    let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { lock.unlock(); return 0 }
    var reuse: Int32 = 1
    withUnsafePointer(to: &reuse) { pointer in
      _ = Darwin.setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, pointer, socklen_t(MemoryLayout<Int32>.size))
    }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = 0
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    let bound: Int32 = withUnsafePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sock in
        Darwin.bind(fd, sock, socklen_t(MemoryLayout<sockaddr_in>.size))
      }
    }
    guard bound == 0, Darwin.listen(fd, 16) == 0 else {
      Darwin.close(fd)
      lock.unlock()
      return 0
    }
    let port = boundPort(fd: fd)
    guard port > 0 else {
      Darwin.close(fd)
      lock.unlock()
      return 0
    }
    serverFd = fd
    running = true
    lock.unlock()
    work.async { [weak self] in self?.acceptLoop() }
    return port
  }

  func port() -> Int {
    lock.lock()
    defer { lock.unlock() }
    return boundPortLocked()
  }

  /** Bytes toward the engine on one connection; already batched by the caller. */
  @discardableResult
  func write(connection: Int, data: String) -> Bool {
    lock.lock()
    guard let fd = sockets[connection] else { lock.unlock(); return false }
    lock.unlock()
    guard let bytes = Data(base64Encoded: data, options: .ignoreUnknownCharacters), !bytes.isEmpty else {
      return true
    }
    work.async { [weak self] in
      guard let self else { return }
      self.lock.lock()
      // The connection may have closed meanwhile; a bare fd could be recycled.
      guard self.sockets[connection] == fd else { self.lock.unlock(); return }
      self.lock.unlock()
      var sent = 0
      let count = bytes.count
      let ok = bytes.withUnsafeBytes { raw -> Bool in
        guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return false }
        while sent < count {
          let written = Darwin.send(fd, base.advanced(by: sent), count - sent, 0)
          if written <= 0 { return false }
          sent += written
        }
        return true
      }
      if ok {
        self.lock.lock()
        self.bytesToEngine += Int64(count)
        self.lock.unlock()
      } else {
        self.close(connection: connection, emit: true)
      }
    }
    return true
  }

  /** End one connection; the consumer asked, or its socket died. */
  @discardableResult
  func close(connection: Int) -> Bool {
    close(connection: connection, emit: false)
  }

  /** End the listener and every connection. */
  func stop() {
    lock.lock()
    running = false
    let fd = serverFd
    serverFd = -1
    let fds = Array(sockets.values)
    sockets.removeAll()
    openConnections = 0
    lock.unlock()
    if fd >= 0 {
      Darwin.shutdown(fd, SHUT_RDWR)
      Darwin.close(fd)
    }
    for socket in fds {
      Darwin.shutdown(socket, SHUT_RDWR)
      Darwin.close(socket)
    }
  }

  func statsJson() -> String {
    lock.lock()
    let snapshot: [String: Any] = [
      "port": boundPortLocked(),
      "connections": totalConnections,
      "open": openConnections,
      "bytesToEngine": bytesToEngine,
      "bytesFromEngine": bytesFromEngine,
      "events": events,
    ]
    lock.unlock()
    guard let data = try? JSONSerialization.data(withJSONObject: snapshot),
      let text = String(data: data, encoding: .utf8)
    else { return "{}" }
    return text
  }

  // MARK: - Private

  private func boundPortLocked() -> Int {
    guard serverFd >= 0 else { return 0 }
    return DesklinkTcpBridge.boundPort(fd: serverFd)
  }

  private static func boundPort(fd: Int32) -> Int {
    var address = sockaddr_in()
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    let ok: Int32 = withUnsafeMutablePointer(to: &address) { pointer in
      pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sock in
        Darwin.getsockname(fd, sock, &length)
      }
    }
    guard ok == 0 else { return 0 }
    return Int(CFSwapInt16BigToHost(address.sin_port))
  }

  private func acceptLoop() {
    while true {
      lock.lock()
      let fd = serverFd
      let alive = running
      lock.unlock()
      guard alive, fd >= 0 else { return }
      var peer = sockaddr_in()
      var length = socklen_t(MemoryLayout<sockaddr_in>.size)
      let accepted: Int32 = withUnsafeMutablePointer(to: &peer) { pointer in
        pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { sock in
          Darwin.accept(fd, sock, &length)
        }
      }
      guard accepted >= 0 else {
        // The server socket closed under stop(): the loop is done.
        lock.lock()
        let done = !running
        lock.unlock()
        if done { return }
        continue
      }
      var noPipe: Int32 = 1
      withUnsafePointer(to: &noPipe) { pointer in
        _ = Darwin.setsockopt(accepted, SOL_SOCKET, SO_NOSIGPIPE, pointer, socklen_t(MemoryLayout<Int32>.size))
      }
      var timeout = timeval(tv_sec: 0, tv_usec: Self.readTimeoutMicroseconds)
      withUnsafePointer(to: &timeout) { pointer in
        _ = Darwin.setsockopt(accepted, SOL_SOCKET, SO_RCVTIMEO, pointer, socklen_t(MemoryLayout<timeval>.size))
      }
      lock.lock()
      guard running else {
        lock.unlock()
        Darwin.close(accepted)
        continue
      }
      nextConnection += 1
      let connection = nextConnection
      sockets[connection] = accepted
      totalConnections += 1
      openConnections += 1
      lock.unlock()
      emit("tcpAccept", ["connection": connection])
      let captured = accepted
      work.async { [weak self] in self?.pump(connection: connection, fd: captured) }
    }
  }

  private func pump(connection: Int, fd: Int32) {
    var chunk = [UInt8](repeating: 0, count: Self.flushBytes)
    var pending = Data()
    while true {
      lock.lock()
      let current = sockets[connection]
      let alive = running
      lock.unlock()
      guard alive, current == fd else { break }
      let (read, status): (Int, Int32) = chunk.withUnsafeMutableBytes { raw -> (Int, Int32) in
        guard let base = raw.bindMemory(to: UInt8.self).baseAddress else { return (-1, EINVAL) }
        let count = Darwin.recv(fd, base, Self.flushBytes, 0)
        return (count, count < 0 ? errno : 0)
      }
      if read == 0 { break } // The peer closed.
      if read > 0 { pending.append(contentsOf: chunk.prefix(read)) }
      let timedOut = read < 0 && (status == EAGAIN || status == EWOULDBLOCK)
      // A read that finds nothing (timeout) flushes what it already holds;
      // an error reads as a close below.
      if pending.count >= Self.flushBytes || (timedOut && !pending.isEmpty) {
        flush(connection: connection, bytes: pending)
        pending.removeAll(keepingCapacity: true)
      }
      if read < 0 && !timedOut { break }
    }
    if !pending.isEmpty { flush(connection: connection, bytes: pending) }
    close(connection: connection, emit: true)
  }

  private func flush(connection: Int, bytes: Data) {
    guard !bytes.isEmpty else { return }
    lock.lock()
    bytesFromEngine += Int64(bytes.count)
    events += 1
    lock.unlock()
    emit("tcpData", ["connection": connection, "data": bytes.base64EncodedString()])
  }

  @discardableResult
  private func close(connection: Int, emit shouldEmit: Bool) -> Bool {
    lock.lock()
    guard let fd = sockets.removeValue(forKey: connection) else { lock.unlock(); return false }
    openConnections = max(0, openConnections - 1)
    lock.unlock()
    Darwin.shutdown(fd, SHUT_RDWR)
    Darwin.close(fd)
    if shouldEmit { emit("tcpClosed", ["connection": connection]) }
    return true
  }

  private func emit(_ name: String, _ payload: [String: Any]) {
    DispatchQueue.main.async { [onEvent] in onEvent(name, payload) }
  }
}
