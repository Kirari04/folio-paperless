package app.folio.mtls

import android.app.Activity
import android.content.Context
import android.net.Uri
import android.security.KeyChain
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileOutputStream
import java.net.URI
import java.net.URL
import java.nio.charset.StandardCharsets
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.X509ExtendedKeyManager

private const val INSTALL_REQUEST_CODE = 7419
private const val MAX_RESPONSE_BYTES = 64L * 1024 * 1024
private const val MAX_DOWNLOAD_BYTES = 512L * 1024 * 1024
private const val CONNECT_TIMEOUT_MS = 20_000
private const val READ_TIMEOUT_MS = 5 * 60_000
private const val REF_PREFIX = "android-keychain:"
private val HTTP_METHODS = setOf("GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS")

@OptimizedRecord
internal class FolioMtlsRequestRecord : Record {
  @Field var requestId: String = ""
  @Field var clientIdentityRef: String = ""
  @Field var serverUrl: String = ""
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String? = null
}

@OptimizedRecord
internal class FolioMtlsDownloadRecord : Record {
  @Field var requestId: String = ""
  @Field var clientIdentityRef: String = ""
  @Field var serverUrl: String = ""
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var destinationUri: String = ""
  @Field var maxBytes: Double = MAX_DOWNLOAD_BYTES.toDouble()
}

@OptimizedRecord
internal class FolioMtlsParameterRecord : Record {
  @Field var name: String = ""
  @Field var value: String = ""
}

@OptimizedRecord
internal class FolioMtlsMultipartRecord : Record {
  @Field var requestId: String = ""
  @Field var clientIdentityRef: String = ""
  @Field var serverUrl: String = ""
  @Field var url: String = ""
  @Field var method: String = "POST"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var fileUri: String = ""
  @Field var fieldName: String = "document"
  @Field var fileName: String = "document"
  @Field var mimeType: String = "application/octet-stream"
  @Field var parameters: List<FolioMtlsParameterRecord> = emptyList()
}

private data class ActiveRequest(
  val canceled: AtomicBoolean = AtomicBoolean(false),
  @Volatile var connection: HttpsURLConnection? = null,
)

private class AliasKeyManager(
  private val context: Context,
  private val alias: String,
) : X509ExtendedKeyManager() {
  override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?): Array<String> =
    arrayOf(alias)
  override fun chooseClientAlias(
    keyType: Array<out String>?,
    issuers: Array<out Principal>?,
    socket: java.net.Socket?,
  ): String = alias
  override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
  override fun chooseServerAlias(
    keyType: String?,
    issuers: Array<out Principal>?,
    socket: java.net.Socket?,
  ): String? = null
  override fun getCertificateChain(ignored: String?): Array<X509Certificate> =
    KeyChain.getCertificateChain(context, alias) ?: emptyArray()
  override fun getPrivateKey(ignored: String?): PrivateKey? = KeyChain.getPrivateKey(context, alias)
}

class FolioMtlsModule : Module() {
  private val executor: ExecutorService = Executors.newCachedThreadPool()
  private val activeRequests = ConcurrentHashMap<String, ActiveRequest>()
  private var pendingInstall: Pair<String, Promise>? = null
  private var pendingSelection: Promise? = null

  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FolioMtls")
    Events("onTransferProgress")

    AsyncFunction("getCapabilitiesAsync") {
      mapOf("available" to true, "platform" to "android-keychain")
    }

    AsyncFunction("listManagedClientIdentityRefsAsync") {
      // Android KeyChain credentials remain user/system-owned. Folio must not
      // enumerate them as app-managed deletion candidates.
      emptyList<String>()
    }

    AsyncFunction("selectClientIdentityAsync") {
      serverUrl: String,
      suggestedClientIdentityRef: String?,
      promise: Promise,
      ->
      ensureHttpsBase(serverUrl)
      if (pendingSelection != null || pendingInstall != null) {
        reject(promise, "BUSY", "Another client identity operation is already active.")
        return@AsyncFunction
      }
      pendingSelection = promise
      chooseIdentity(serverUrl, suggestedClientIdentityRef, promise)
    }

    AsyncFunction("importClientIdentityAsync") { serverUrl: String, promise: Promise ->
      ensureHttpsBase(serverUrl)
      if (pendingSelection != null || pendingInstall != null) {
        reject(promise, "BUSY", "Another client identity operation is already active.")
        return@AsyncFunction
      }
      pendingInstall = serverUrl to promise
      appContext.throwingActivity.startActivityForResult(KeyChain.createInstallIntent(), INSTALL_REQUEST_CODE)
    }

    AsyncFunction("describeClientIdentityAsync") { clientIdentityRef: String, promise: Promise ->
      executor.execute {
        try {
          promise.resolve(describeIdentity(aliasFromRef(clientIdentityRef)))
        } catch (error: Throwable) {
          rejectIdentityError(promise, error)
        }
      }
    }

    AsyncFunction("removeClientIdentityAsync") { clientIdentityRef: String ->
      // Android KeyChain credentials are user/system-owned. Folio deletes its
      // per-profile alias reference but must not silently delete the system identity.
      aliasFromRef(clientIdentityRef)
    }

    AsyncFunction("requestAsync") { request: FolioMtlsRequestRecord, promise: Promise ->
      runRequest(request.requestId, promise) { active ->
        val connection = openConnection(
          request.clientIdentityRef,
          request.serverUrl,
          request.url,
          request.method,
          request.headers,
          active,
        )
        request.body?.let { body ->
          val bytes = body.toByteArray(StandardCharsets.UTF_8)
          connection.doOutput = true
          connection.setFixedLengthStreamingMode(bytes.size)
          connection.outputStream.use { it.write(bytes) }
        }
        readTextResponse(connection, active)
      }
    }

    AsyncFunction("downloadAsync") { request: FolioMtlsDownloadRecord, promise: Promise ->
      runRequest(request.requestId, promise) { active ->
        require(request.maxBytes.isFinite() && request.maxBytes >= 1.0 && request.maxBytes <= MAX_DOWNLOAD_BYTES.toDouble()) {
          "The download size limit is invalid."
        }
        val maxBytes = request.maxBytes.toLong()
        val destination = privateFile(request.destinationUri, write = true)
        val connection = openConnection(
          request.clientIdentityRef,
          request.serverUrl,
          request.url,
          request.method,
          request.headers,
          active,
        )
        val status = connection.responseCode
        if (status !in 200..299) return@runRequest readTextResponse(connection, active, status)
        val declaredLength = connection.contentLengthLong
        require(declaredLength < 0 || declaredLength <= maxBytes) {
          "The download exceeds Folio's per-file safety limit."
        }
        val part = File(destination.parentFile, ".${destination.name}.${request.requestId}.part")
        if (part.exists()) part.delete()
        try {
          BufferedInputStream(connection.inputStream).use { input ->
            BufferedOutputStream(FileOutputStream(part)).use { output ->
              copyWithProgress(input, output, request.requestId, declaredLength, maxBytes, active)
            }
          }
          if (destination.exists() && !destination.delete()) {
            throw IllegalStateException("The existing destination could not be replaced.")
          }
          if (!part.renameTo(destination)) {
            throw IllegalStateException("The completed download could not be committed.")
          }
        } finally {
          if (part.exists()) part.delete()
        }
        responseMap(connection, status, "")
      }
    }

    AsyncFunction("uploadMultipartAsync") { request: FolioMtlsMultipartRecord, promise: Promise ->
      runRequest(request.requestId, promise) { active ->
        val source = privateFile(request.fileUri, write = false)
        require(source.isFile && source.length() > 0) { "The upload source is unavailable." }
        val boundary = "folio-${request.requestId.replace(Regex("[^A-Za-z0-9]"), "").take(48)}"
        val prefix = multipartPrefix(request, boundary)
        val suffix = "\r\n--$boundary--\r\n".toByteArray(StandardCharsets.UTF_8)
        val total = prefix.size.toLong() + source.length() + suffix.size
        val headers = request.headers.toMutableMap().apply {
          this["Content-Type"] = "multipart/form-data; boundary=$boundary"
        }
        val connection = openConnection(
          request.clientIdentityRef,
          request.serverUrl,
          request.url,
          request.method,
          headers,
          active,
        )
        connection.doOutput = true
        connection.setFixedLengthStreamingMode(total)
        BufferedOutputStream(connection.outputStream).use { output ->
          output.write(prefix)
          var completed = prefix.size.toLong()
          emitProgress(request.requestId, completed, total)
          BufferedInputStream(source.inputStream()).use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
              ensureNotCanceled(active)
              val count = input.read(buffer)
              if (count < 0) break
              output.write(buffer, 0, count)
              completed += count
              emitProgress(request.requestId, completed, total)
            }
          }
          output.write(suffix)
          emitProgress(request.requestId, total, total)
        }
        readTextResponse(connection, active)
      }
    }

    AsyncFunction("cancelRequestAsync") { requestId: String ->
      activeRequests[requestId]?.let {
        it.canceled.set(true)
        it.connection?.disconnect()
      }
    }

    OnActivityResult { _, (requestCode, resultCode) ->
      if (requestCode != INSTALL_REQUEST_CODE) return@OnActivityResult
      val pending = pendingInstall ?: return@OnActivityResult
      pendingInstall = null
      if (resultCode != Activity.RESULT_OK) {
        pending.second.resolve(null)
        return@OnActivityResult
      }
      pendingSelection = pending.second
      chooseIdentity(pending.first, null, pending.second)
    }

    OnDestroy {
      activeRequests.values.forEach {
        it.canceled.set(true)
        it.connection?.disconnect()
      }
      activeRequests.clear()
      executor.shutdownNow()
    }
  }

  private fun chooseIdentity(serverUrl: String, suggestedRef: String?, promise: Promise) {
    val uri = Uri.parse(serverUrl)
    val suggestedAlias = suggestedRef?.let {
      try { aliasFromRef(it) } catch (_: Throwable) { null }
    }
    KeyChain.choosePrivateKeyAlias(
      appContext.throwingActivity,
      { alias ->
        if (alias == null) {
          pendingSelection = null
          promise.resolve(null)
        } else {
          executor.execute {
            try {
              promise.resolve(selection(alias))
            } catch (error: Throwable) {
              rejectIdentityError(promise, error)
            } finally {
              pendingSelection = null
            }
          }
        }
      },
      arrayOf("RSA", "EC"),
      null,
      uri,
      suggestedAlias,
    )
  }

  private fun selection(alias: String) = mapOf(
    "identity" to (describeIdentity(alias)
      ?: throw IllegalStateException("The selected identity is unavailable.")),
    "clientIdentityRef" to refForAlias(alias),
  )

  private fun describeIdentity(alias: String): Map<String, Any>? {
    val chain = KeyChain.getCertificateChain(context, alias) ?: return null
    val certificate = chain.firstOrNull() ?: return null
    val key = KeyChain.getPrivateKey(context, alias)
    return identityMetadata(certificate, key != null)
  }

  private fun identityMetadata(certificate: X509Certificate, hasPrivateKey: Boolean): Map<String, Any> {
    val formatter = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
      timeZone = TimeZone.getTimeZone("UTC")
    }
    return mapOf(
      "identityId" to sha256(certificate.encoded),
      "subject" to certificate.subjectX500Principal.name,
      "issuer" to certificate.issuerX500Principal.name,
      "notBefore" to formatter.format(certificate.notBefore),
      "expiresAt" to formatter.format(certificate.notAfter),
      "fingerprintSha256" to sha256(certificate.encoded),
      "hasPrivateKey" to hasPrivateKey,
      "source" to "os-credential-store",
    )
  }

  private fun openConnection(
    identityRef: String,
    serverUrl: String,
    requestUrl: String,
    method: String,
    headers: Map<String, String>,
    active: ActiveRequest,
  ): HttpsURLConnection {
    val target = validateRequestUrl(serverUrl, requestUrl)
    val normalizedMethod = method.uppercase(Locale.US)
    require(normalizedMethod in HTTP_METHODS) { "Unsupported HTTP method." }
    validateHeaders(headers)
    val alias = aliasFromRef(identityRef)
    val metadata = describeIdentity(alias)
      ?: throw IdentityException("IDENTITY_NOT_FOUND", "The identity is unavailable.")
    ensureIdentityValidity(metadata)
    val ssl = SSLContext.getInstance("TLS")
    // A null TrustManager array deliberately selects the platform default trust
    // store. The default HttpsURLConnection hostname verifier remains installed.
    ssl.init(arrayOf(AliasKeyManager(context, alias)), null, null)
    val connection = target.toURL().openConnection() as? HttpsURLConnection
      ?: throw IllegalArgumentException("Mutual TLS requires HTTPS.")
    connection.sslSocketFactory = ssl.socketFactory
    connection.instanceFollowRedirects = false
    connection.connectTimeout = CONNECT_TIMEOUT_MS
    connection.readTimeout = READ_TIMEOUT_MS
    connection.requestMethod = normalizedMethod
    connection.useCaches = false
    headers.forEach(connection::setRequestProperty)
    active.connection = connection
    ensureNotCanceled(active)
    return connection
  }

  private fun runRequest(
    id: String,
    promise: Promise,
    operation: (ActiveRequest) -> Map<String, Any>,
  ) {
    if (!id.matches(Regex("^[A-Za-z0-9._-]{1,128}$"))) {
      reject(promise, "INVALID", "The request identifier is invalid.")
      return
    }
    val active = ActiveRequest()
    if (activeRequests.putIfAbsent(id, active) != null) {
      reject(promise, "INVALID", "The request identifier is already active.")
      return
    }
    executor.execute {
      try {
        promise.resolve(operation(active))
      } catch (error: Throwable) {
        when {
          active.canceled.get() -> reject(promise, "CANCELED", "The request was canceled.")
          error is IdentityException -> reject(promise, error.code, error.message ?: "Identity error.")
          error is ResponseTooLargeException -> reject(promise, "RESPONSE_TOO_LARGE", error.message ?: "The response is too large.")
          error is javax.net.ssl.SSLException -> reject(promise, "TLS", "TLS verification or client authentication failed.")
          error is IllegalArgumentException -> reject(promise, "INVALID", error.message ?: "The request is invalid.")
          else -> reject(promise, "REQUEST", "The certificate-aware request failed.")
        }
      } finally {
        active.connection?.disconnect()
        activeRequests.remove(id)
      }
    }
  }

  private fun readTextResponse(
    connection: HttpsURLConnection,
    active: ActiveRequest,
    knownStatus: Int? = null,
  ): Map<String, Any> {
    val status = knownStatus ?: connection.responseCode
    ensureNotCanceled(active)
    val declaredLength = connection.contentLengthLong
    if (declaredLength > MAX_RESPONSE_BYTES) throw ResponseTooLargeException()
    val stream = if (status >= 400) connection.errorStream else connection.inputStream
    val body = if (stream == null) "" else BufferedInputStream(stream).use { input ->
      val output = ByteArrayOutputStream()
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      var total = 0L
      while (true) {
        ensureNotCanceled(active)
        val count = input.read(buffer)
        if (count < 0) break
        total += count.toLong()
        if (total > MAX_RESPONSE_BYTES) throw ResponseTooLargeException()
        output.write(buffer, 0, count)
      }
      output.toString(StandardCharsets.UTF_8.name())
    }
    return responseMap(connection, status, body)
  }

  private fun responseMap(connection: HttpsURLConnection, status: Int, body: String) = mapOf(
    "status" to status,
    "headers" to connection.headerFields
      .filterKeys { it != null }
      .mapValues { (_, values) -> values.joinToString(", ") },
    "responseUrl" to connection.url.toString(),
    "body" to body,
  )

  private fun multipartPrefix(request: FolioMtlsMultipartRecord, boundary: String): ByteArray {
    fun safe(value: String): String {
      require(!value.contains('\r') && !value.contains('\n') && !value.contains('"')) {
        "Multipart metadata contains invalid characters."
      }
      return value
    }
    require(request.parameters.size <= 100) { "Too many multipart fields." }
    val text = buildString {
      request.parameters.forEach { parameter ->
        append("--$boundary\r\n")
        append("Content-Disposition: form-data; name=\"")
        append(safe(parameter.name))
        append("\"\r\n\r\n")
        append(parameter.value)
        append("\r\n")
      }
      append("--$boundary\r\n")
      append("Content-Disposition: form-data; name=\"")
      append(safe(request.fieldName))
      append("\"; filename=\"")
      append(safe(request.fileName))
      append("\"\r\nContent-Type: ")
      append(safe(request.mimeType))
      append("\r\n\r\n")
    }
    return text.toByteArray(StandardCharsets.UTF_8)
  }

  private fun copyWithProgress(
    input: BufferedInputStream,
    output: BufferedOutputStream,
    requestId: String,
    total: Long,
    maxBytes: Long,
    active: ActiveRequest,
  ) {
    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
    var completed = 0L
    while (true) {
      ensureNotCanceled(active)
      val count = input.read(buffer)
      if (count < 0) break
      completed += count
      require(completed <= maxBytes) {
        "The download exceeds Folio's per-file safety limit."
      }
      output.write(buffer, 0, count)
      emitProgress(requestId, completed, if (total >= 0) total else null)
    }
  }

  private fun emitProgress(requestId: String, completed: Long, total: Long?) {
    sendEvent(
      "onTransferProgress",
      mapOf("requestId" to requestId, "completedBytes" to completed, "totalBytes" to total),
    )
  }

  private fun ensureIdentityValidity(metadata: Map<String, Any>) {
    val expires = parseUtc(metadata["expiresAt"] as String)
    val notBefore = parseUtc(metadata["notBefore"] as String)
    val now = Date()
    if (now.before(notBefore)) throw IdentityException("IDENTITY_NOT_YET_VALID", "Identity not valid yet.")
    if (!now.before(expires)) throw IdentityException("IDENTITY_EXPIRED", "Identity expired.")
    if (metadata["hasPrivateKey"] != true) {
      throw IdentityException("IDENTITY_MISSING_PRIVATE_KEY", "Identity has no private key.")
    }
  }

  private fun ensureNotCanceled(active: ActiveRequest) {
    if (active.canceled.get()) throw InterruptedException("Request canceled.")
  }

  private fun ensureHttpsBase(value: String) {
    val uri = URI(value)
    require(uri.scheme.equals("https", ignoreCase = true) && uri.host != null && uri.userInfo == null) {
      "Mutual TLS requires an HTTPS server URL without embedded credentials."
    }
  }

  private fun validateRequestUrl(serverUrl: String, requestUrl: String): URI {
    val base = URI(serverUrl)
    val target = URI(requestUrl)
    ensureHttpsBase(serverUrl)
    require(target.scheme.equals("https", ignoreCase = true)) { "Mutual TLS requires HTTPS." }
    require(target.userInfo == null && target.fragment == null) { "The request URL is unsafe." }
    fun port(uri: URI) = if (uri.port >= 0) uri.port else 443
    require(base.host.equals(target.host, ignoreCase = true) && port(base) == port(target)) {
      "The request origin does not match the saved server."
    }
    val basePath = (base.path ?: "").trimEnd('/')
    val targetPath = target.path ?: ""
    require(basePath.isEmpty() || targetPath == basePath || targetPath.startsWith("$basePath/")) {
      "The request path is outside the saved server subpath."
    }
    return target
  }

  private fun validateHeaders(headers: Map<String, String>) {
    require(headers.size <= 64) { "Too many request headers." }
    val token = Regex("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
    headers.forEach { (name, value) ->
      require(token.matches(name) && value.length <= 16_384 && !value.contains('\r') && !value.contains('\n')) {
        "A request header is invalid."
      }
    }
  }

  private fun privateFile(value: String, write: Boolean): File {
    val uri = Uri.parse(value)
    require(uri.scheme == "file" && uri.path != null) { "Only app-private file URLs are supported." }
    val file = File(uri.path!!).canonicalFile
    val roots = listOf(context.filesDir, context.cacheDir, context.noBackupFilesDir)
      .map { it.canonicalFile }
    require(roots.any { file.path == it.path || file.path.startsWith(it.path + File.separator) }) {
      "The file URL is outside Folio's private storage."
    }
    if (write) file.parentFile?.mkdirs()
    return file
  }

  private fun refForAlias(alias: String): String = REF_PREFIX + Base64.encodeToString(
    alias.toByteArray(StandardCharsets.UTF_8),
    Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
  )

  private fun aliasFromRef(value: String): String {
    require(value.startsWith(REF_PREFIX)) { "The Android identity reference is invalid." }
    val alias = String(
      Base64.decode(value.removePrefix(REF_PREFIX), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING),
      StandardCharsets.UTF_8,
    )
    require(alias.isNotEmpty() && alias.length <= 512) { "The Android identity reference is invalid." }
    return alias
  }

  private fun sha256(bytes: ByteArray) = MessageDigest.getInstance("SHA-256")
    .digest(bytes)
    .joinToString(":") { "%02X".format(it) }

  private fun parseUtc(value: String): Date = SimpleDateFormat(
    "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'",
    Locale.US,
  ).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(value)
    ?: throw IllegalArgumentException("Invalid certificate date.")

  private fun rejectIdentityError(promise: Promise, error: Throwable) {
    when (error) {
      is IdentityException -> reject(promise, error.code, error.message ?: "Identity error.")
      else -> reject(promise, "IDENTITY_NOT_FOUND", "The client identity is unavailable.")
    }
  }

  private fun reject(promise: Promise, suffix: String, message: String) {
    promise.reject("ERR_FOLIO_MTLS_$suffix", message, null)
  }
}

private class IdentityException(val code: String, message: String) : Exception(message)

private class ResponseTooLargeException : Exception(
  "The response exceeds Folio's in-memory safety limit.",
)
