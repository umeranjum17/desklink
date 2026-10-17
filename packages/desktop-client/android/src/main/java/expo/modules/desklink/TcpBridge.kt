package expo.modules.desklink

import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.json.JSONObject

private const val TAG = "DesklinkTcpBridge"
/** A read that finds nothing this fast flushes what it already holds. */
private const val READ_TIMEOUT_MS = 12
/** A flush carries at most this many bytes: batches, not per-packet storms. */
private const val FLUSH_BYTES = 8192

/**
 * The native side of the relay route: a 127.0.0.1 listener the native peer
 * dials for its ICE-TCP checks, with every accepted connection piped through
 * the consumer's stream on the JS side.
 *
 * Reads batch by size or deadline — one `tcpData` event per flush, never one
 * per packet — and writes from JS arrive already batched the same way, so a
 * video stream crosses the bridge in a handful of calls per second. Bytes are
 * never interpreted here: DTLS and STUN pass through untouched.
 */
class TcpBridge(private val onEvent: (String, Map<String, Any?>) -> Unit) {
  private val ui = Handler(Looper.getMainLooper())
  private val pool = Executors.newCachedThreadPool { runnable ->
    Thread(runnable, "desklink-tcpbridge").apply { isDaemon = true }
  }
  private var server: ServerSocket? = null
  private val sockets = ConcurrentHashMap<Int, Socket>()
  /** One writer per connection: its batches leave in submit order, one at a time. */
  private val writers = ConcurrentHashMap<Int, ExecutorService>()
  private var nextConnection = 0
  private val totalConnections = AtomicInteger(0)
  private val openConnections = AtomicInteger(0)
  private val bytesToEngine = AtomicLong(0)
  private val bytesFromEngine = AtomicLong(0)
  private val events = AtomicLong(0)
  @Volatile private var running = false

  /** Bind the phone listener; the port, or 0 when it cannot start. */
  @Synchronized
  fun start(): Int {
    if (running) return server?.localPort ?: 0
    return try {
      val bound = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
      server = bound
      running = true
      pool.execute { acceptLoop(bound) }
      bound.localPort
    } catch (error: IOException) {
      Log.w(TAG, "Could not bind the relay listener", error)
      0
    }
  }

  fun port(): Int = server?.localPort ?: 0

  private fun acceptLoop(bound: ServerSocket) {
    try {
      while (running) {
        val socket = bound.accept()
        if (!running) {
          runCatching { socket.close() }
          break
        }
        val connection = synchronized(this) { ++nextConnection }
        writers[connection] = Executors.newSingleThreadExecutor { runnable ->
          Thread(runnable, "desklink-tcpbridge-writer").apply { isDaemon = true }
        }
        sockets[connection] = socket
        totalConnections.incrementAndGet()
        openConnections.incrementAndGet()
        emit("tcpAccept", mapOf("connection" to connection))
        pool.execute { pump(connection, socket) }
      }
    } catch (error: IOException) {
      // The server socket closed under stop(): the loop is done.
      if (running) Log.w(TAG, "The relay listener failed", error)
    }
  }

  private fun pump(connection: Int, socket: Socket) {
    val chunk = ByteArray(FLUSH_BYTES)
    val pending = ByteArrayOutputStream()
    try {
      socket.soTimeout = READ_TIMEOUT_MS
      val input = socket.getInputStream()
      while (running && sockets[connection] === socket && !socket.isClosed) {
        val read = try {
          input.read(chunk)
        } catch (timeout: SocketTimeoutException) {
          TIMEOUT
        }
        if (read == -1) break
        if (read > 0) pending.write(chunk, 0, read)
        if (pending.size() >= FLUSH_BYTES || (read == TIMEOUT && pending.size() > 0)) {
          flush(connection, pending)
        }
      }
    } catch (error: IOException) {
      // A reset peer reads as a close below.
    }
    if (pending.size() > 0) flush(connection, pending)
    close(connection, true)
  }

  private fun flush(connection: Int, pending: ByteArrayOutputStream) {
    val bytes = pending.toByteArray()
    pending.reset()
    if (bytes.isEmpty()) return
    bytesFromEngine.addAndGet(bytes.size.toLong())
    events.incrementAndGet()
    emit("tcpData", mapOf(
      "connection" to connection,
      "data" to Base64.encodeToString(bytes, Base64.NO_WRAP),
    ))
  }

  /** Bytes toward the engine on one connection; already batched by the caller. */
  fun write(connection: Int, data: String): Boolean {
    val socket = sockets[connection] ?: return false
    val writer = writers[connection] ?: return false
    val bytes = try {
      Base64.decode(data, Base64.DEFAULT)
    } catch (error: IllegalArgumentException) {
      return false
    }
    return try {
      writer.execute {
        try {
          val output = socket.getOutputStream()
          output.write(bytes)
          output.flush()
          bytesToEngine.addAndGet(bytes.size.toLong())
        } catch (error: IOException) {
          close(connection, true)
        }
      }
      true
    } catch (error: RejectedExecutionException) {
      // The connection closed between the lookup and the submit.
      false
    }
  }

  /** End one connection; the consumer asked, or its socket died. */
  fun close(connection: Int): Boolean {
    return close(connection, false)
  }

  private fun close(connection: Int, emit: Boolean): Boolean {
    val socket = sockets.remove(connection) ?: return false
    writers.remove(connection)?.shutdownNow()
    openConnections.decrementAndGet()
    runCatching { socket.close() }
    if (emit) emit("tcpClosed", mapOf("connection" to connection))
    return true
  }

  /** End the listener and every connection. */
  fun stop() {
    running = false
    runCatching { server?.close() }
    server = null
    for (connection in sockets.keys.toList()) close(connection, false)
    runCatching { pool.shutdown() }
  }

  fun statsJson(): String = JSONObject(mapOf(
    "port" to port(),
    "connections" to totalConnections.get(),
    "open" to openConnections.get(),
    "bytesToEngine" to bytesToEngine.get(),
    "bytesFromEngine" to bytesFromEngine.get(),
    "events" to events.get(),
  )).toString()

  private fun emit(name: String, payload: Map<String, Any?>) {
    ui.post { onEvent(name, payload) }
  }

  companion object {
    private const val TIMEOUT = -2
  }
}
