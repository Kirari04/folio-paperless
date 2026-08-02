package app.folio.platform

import android.app.appsearch.AppSearchBatchResult
import android.app.appsearch.AppSearchManager
import android.app.appsearch.AppSearchResult
import android.app.appsearch.AppSearchSchema
import android.app.appsearch.AppSearchSession
import android.app.appsearch.BatchResultCallback
import android.app.appsearch.GenericDocument
import android.app.appsearch.PutDocumentsRequest
import android.app.appsearch.RemoveByDocumentIdRequest
import android.app.appsearch.SearchSpec
import android.app.appsearch.SetSchemaRequest
import android.content.Context
import android.net.Uri
import android.os.Build
import android.util.Base64
import androidx.annotation.RequiresApi
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.types.OptimizedRecord
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong
import java.util.ArrayDeque
import java.util.UUID
import java.math.BigInteger
import java.nio.charset.StandardCharsets
import java.security.KeyFactory
import java.security.Signature
import java.security.SignatureException
import java.security.spec.RSAPublicKeySpec

private const val DATABASE_NAME = "folio-documents"
// Android system surfaces understand the built-in WebPage shape and use its
// `url` as an ACTION_VIEW deep link when a result is selected. The URL carries
// only validated opaque Folio IDs; JS still performs profile, unlock, and
// object-access checks before navigation.
private const val SCHEMA_TYPE = "builtin:WebPage"
private const val PROPERTY_TITLE = "name"
private const val PROPERTY_ROUTE = "url"
private const val CLEAR_ON_BACKGROUND_KEY = "clear-on-background"
private const val CLEANUP_PENDING_KEY = "cleanup-pending"
private const val NATIVE_PREFERENCES = "folio-platform-search"
private const val PROTECTED_STORAGE_COORDINATOR_ERROR = "ERR_FOLIO_PROTECTED_STORAGE_COORDINATOR"
private val PROTECTED_STORAGE_LEASE_PATTERN = Regex(
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
)

/**
 * Process-wide FIFO exclusion shared by foreground and headless Expo module
 * instances. Lease and owner IDs are random capabilities and never contain a
 * protected-storage key or value.
 */
private object FolioProtectedStorageExclusiveCoordinator {
  private data class Request(
    val ownerId: String,
    val leaseId: String,
    val promise: Promise,
  )

  private val monitor = Any()
  private val registeredOwners = mutableSetOf<String>()
  private val pending = ArrayDeque<Request>()
  private var active: Request? = null

  fun registerOwner(ownerId: String) = synchronized(monitor) {
    check(registeredOwners.add(ownerId)) {
      "The protected-storage coordinator owner is already registered."
    }
  }

  fun acquire(ownerId: String, promise: Promise) {
    var granted: Request? = null
    val unavailable = synchronized(monitor) {
      if (!registeredOwners.contains(ownerId)) {
        true
      } else {
        val request = Request(
          ownerId = ownerId,
          leaseId = UUID.randomUUID().toString(),
          promise = promise,
        )
        if (active == null) {
          active = request
          granted = request
        } else {
          pending.addLast(request)
        }
        false
      }
    }
    if (unavailable) {
      promise.reject(
        PROTECTED_STORAGE_COORDINATOR_ERROR,
        "The protected-storage coordinator owner is unavailable.",
        null,
      )
      return
    }
    granted?.let { request -> request.promise.resolve(request.leaseId) }
  }

  fun release(ownerId: String, leaseId: String) {
    require(PROTECTED_STORAGE_LEASE_PATTERN.matches(leaseId)) {
      "The protected-storage lease is invalid."
    }
    val granted = synchronized(monitor) {
      val current = active
        ?: throw IllegalStateException("No protected-storage lease is active.")
      check(current.ownerId == ownerId && current.leaseId == leaseId) {
        "The protected-storage lease is not owned by this module."
      }
      active = null
      takeNextLocked()
    }
    granted?.let { request -> request.promise.resolve(request.leaseId) }
  }

  fun unregisterOwner(ownerId: String) {
    val canceled = mutableListOf<Request>()
    var granted: Request? = null
    synchronized(monitor) {
      registeredOwners.remove(ownerId)
      val iterator = pending.iterator()
      while (iterator.hasNext()) {
        val request = iterator.next()
        if (request.ownerId == ownerId) {
          iterator.remove()
          canceled.add(request)
        }
      }
      if (active?.ownerId == ownerId) {
        active = null
        granted = takeNextLocked()
      }
    }
    canceled.forEach { request ->
      request.promise.reject(
        PROTECTED_STORAGE_COORDINATOR_ERROR,
        "The protected-storage coordinator owner was destroyed while waiting.",
        null,
      )
    }
    granted?.let { request -> request.promise.resolve(request.leaseId) }
  }

  private fun takeNextLocked(): Request? {
    val next = pending.pollFirst() ?: return null
    active = next
    return next
  }
}

@OptimizedRecord
internal class FolioSearchEntryRecord : Record {
  @Field var identifier: String = ""
  @Field var profileId: String = ""
  @Field var documentId: String = ""
  @Field var displayTitle: String = ""
  @Field var route: String = ""
  @Field var updatedAtEpochMs: Double = 0.0
}

@RequiresApi(Build.VERSION_CODES.S)
private class FolioDocumentBuilder(namespace: String, id: String) :
  GenericDocument.Builder<FolioDocumentBuilder>(namespace, id, SCHEMA_TYPE)

class FolioPlatformModule : Module() {
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()
  private val searchAccessLock = Any()
  private val protectedStorageOwnerId = UUID.randomUUID().toString().also {
    FolioProtectedStorageExclusiveCoordinator.registerOwner(it)
  }

  @Volatile
  private var searchUnlocked = false
  private val searchAccessGeneration = AtomicLong(0)

  override fun definition() = ModuleDefinition {
    Name("FolioPlatform")

    Events("onShortcut")

    AsyncFunction("getCapabilitiesAsync") {
      val reason = unsupportedReason()
      mapOf(
        "osSearch" to mapOf(
          "supported" to (reason == null),
          "engine" to if (reason == null) "android-platform-appsearch" else "unsupported",
          "reason" to reason,
        ),
        "shortcuts" to mapOf(
          "supported" to true,
          "transport" to "android-static-deep-link",
        ),
        "widgets" to mapOf(
          "supported" to true,
          "engine" to "android-appwidget-provider",
        ),
        "oidcRs256" to mapOf(
          "supported" to true,
          "engine" to "java-security",
        ),
      )
    }

    AsyncFunction("acquireProtectedStorageLeaseAsync") { promise: Promise ->
      FolioProtectedStorageExclusiveCoordinator.acquire(protectedStorageOwnerId, promise)
    }

    AsyncFunction("releaseProtectedStorageLeaseAsync") { leaseId: String ->
      FolioProtectedStorageExclusiveCoordinator.release(protectedStorageOwnerId, leaseId)
      null
    }

    AsyncFunction("verifyOidcRs256Async") {
      signingInput: String,
      signatureBase64Url: String,
      modulusBase64Url: String,
      exponentBase64Url: String,
      ->
      verifyOidcRs256(
        signingInput,
        signatureBase64Url,
        modulusBase64Url,
        exponentBase64Url,
      )
    }

    AsyncFunction("updateWidgetSnapshotAsync") { state: String, inboxCount: Int? ->
      val widgetState = FolioWidgetState.entries.firstOrNull { it.value == state }
        ?: throw IllegalArgumentException("Widget state is invalid.")
      FolioInboxWidgetProvider.writeSnapshot(requireContext(), widgetState, inboxCount)
      null
    }

    AsyncFunction("clearWidgetSnapshotAsync") {
      FolioInboxWidgetProvider.lock(requireContext())
      null
    }

    AsyncFunction("setSearchAccessStateAsync") {
      unlocked: Boolean,
      clearOnBackground: Boolean,
      promise: Promise,
      ->
      preferences().edit().putBoolean(CLEAR_ON_BACKGROUND_KEY, clearOnBackground).apply()
      val access = configureSearchAccess(unlocked)
      if (unsupportedReason() != null) {
        promise.resolve()
      } else if (!access.needsCleanup) {
        promise.resolve()
      } else {
        clearAllSearch(
          generation = access.generation,
          unlockAfter = unlocked,
          onSuccess = { promise.resolve() },
          onFailure = { message -> promise.reject("ERR_FOLIO_SEARCH", message, null) },
        )
      }
    }

    AsyncFunction("replaceSearchIndexAsync") {
      entries: List<FolioSearchEntryRecord>,
      promise: Promise,
      ->
      if (!requireSupported(promise)) return@AsyncFunction
      val documents = try {
        entries.map(::genericDocument)
      } catch (error: Throwable) {
        promise.reject("ERR_FOLIO_SEARCH_INVALID", error.message, error)
        return@AsyncFunction
      }
      val generation = if (documents.isEmpty()) null else beginSearchWrite()
      if (documents.isNotEmpty() && generation == null) {
        rejectLocked(promise)
        return@AsyncFunction
      }
      withConfiguredSession(promise) { session ->
        removeAll(session, {
          if (documents.isEmpty()) {
            session.close()
            promise.resolve()
          } else {
            putDocuments(session, documents, promise, generation!!)
          }
        }, { message ->
          session.close()
          promise.reject("ERR_FOLIO_SEARCH", message, null)
        })
      }
    }

    AsyncFunction("upsertSearchEntriesAsync") {
      entries: List<FolioSearchEntryRecord>,
      promise: Promise,
      ->
      if (!requireSupported(promise)) return@AsyncFunction
      val generation = beginSearchWrite()
      if (generation == null) {
        rejectLocked(promise)
        return@AsyncFunction
      }
      val documents = try {
        entries.map(::genericDocument)
      } catch (error: Throwable) {
        promise.reject("ERR_FOLIO_SEARCH_INVALID", error.message, error)
        return@AsyncFunction
      }
      if (documents.isEmpty()) {
        promise.resolve()
        return@AsyncFunction
      }
      withConfiguredSession(promise) { session ->
        putDocuments(session, documents, promise, generation)
      }
    }

    AsyncFunction("removeSearchEntriesAsync") {
      identifiers: List<String>,
      promise: Promise,
      ->
      if (!requireSupported(promise)) return@AsyncFunction
      val grouped = try {
        identifiers.map(::parseIdentifier).groupBy({ namespace(it.first) }, { it.third })
      } catch (error: Throwable) {
        promise.reject("ERR_FOLIO_SEARCH_INVALID", error.message, error)
        return@AsyncFunction
      }
      if (grouped.isEmpty()) {
        promise.resolve()
        return@AsyncFunction
      }
      withConfiguredSession(promise) { session ->
        removeIdentifierGroups(session, grouped.entries.toList(), 0, promise)
      }
    }

    AsyncFunction("removeSearchProfileAsync") { profileId: String, promise: Promise ->
      if (!requireSupported(promise)) return@AsyncFunction
      val safeProfileId = try {
        validOpaqueId(profileId, "Profile ID")
      } catch (error: Throwable) {
        promise.reject("ERR_FOLIO_SEARCH_INVALID", error.message, error)
        return@AsyncFunction
      }
      withConfiguredSession(promise) { session ->
        val spec = SearchSpec.Builder()
          .addFilterSchemas(SCHEMA_TYPE)
          .addFilterNamespaces(namespace(safeProfileId))
          .build()
        session.remove("", spec, executor) { result ->
          session.close()
          settleResult(result, promise)
        }
      }
    }

    AsyncFunction("clearSearchIndexAsync") { promise: Promise ->
      if (!requireSupported(promise)) return@AsyncFunction
      val generation = markCleanupNeeded()
      clearAllSearch(
        generation = generation,
        unlockAfter = false,
        onSuccess = { promise.resolve() },
        onFailure = { message -> promise.reject("ERR_FOLIO_SEARCH", message, null) },
      )
    }

    AsyncFunction("consumeInitialShortcutAsync") { null as String? }

    OnCreate {
      if (
        preferences().getBoolean(CLEAR_ON_BACKGROUND_KEY, false) ||
        preferences().getBoolean(CLEANUP_PENDING_KEY, false)
      ) {
        lockAndClearProtectedSearch()
      }
    }

    OnActivityEntersBackground {
      if (preferences().getBoolean(CLEAR_ON_BACKGROUND_KEY, false)) {
        lockAndClearProtectedSearch()
      }
    }

    OnDestroy {
      FolioProtectedStorageExclusiveCoordinator.unregisterOwner(protectedStorageOwnerId)
      executor.shutdown()
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext
      ?: throw IllegalStateException("Folio's Android application context is unavailable.")

  private fun verifyOidcRs256(
    signingInput: String,
    signatureBase64Url: String,
    modulusBase64Url: String,
    exponentBase64Url: String,
  ): Boolean {
    require(signingInput.length in 3..65_536) { "The RS256 signing input is invalid." }
    val signingParts = signingInput.split('.')
    require(signingParts.size == 2 && signingParts.all(::isBase64Url)) {
      "The RS256 signing input is invalid."
    }
    val signatureBytes = decodeBase64Url(signatureBase64Url, 16_384)
    val modulusBytes = decodeBase64Url(modulusBase64Url, 16_384)
    val exponentBytes = decodeBase64Url(exponentBase64Url, 16)
    require(
      modulusBytes.size in 256..1_024 &&
        modulusBytes.first() != 0.toByte() &&
        (modulusBytes.first().toInt() and 0x80) != 0 &&
        signatureBytes.size == modulusBytes.size &&
        exponentBytes.size in 1..8 &&
        exponentBytes.first() != 0.toByte()
    ) { "The RS256 public key is invalid." }
    val modulus = BigInteger(1, modulusBytes)
    val exponent = BigInteger(1, exponentBytes)
    require(exponent >= BigInteger.valueOf(3) && exponent.testBit(0) && exponent.bitLength() <= 63) {
      "The RS256 public exponent is invalid."
    }
    val publicKey = KeyFactory.getInstance("RSA")
      .generatePublic(RSAPublicKeySpec(modulus, exponent))
    val verifier = Signature.getInstance("SHA256withRSA")
    verifier.initVerify(publicKey)
    verifier.update(signingInput.toByteArray(StandardCharsets.US_ASCII))
    return try {
      verifier.verify(signatureBytes)
    } catch (_: SignatureException) {
      false
    }
  }

  private fun isBase64Url(value: String): Boolean =
    value.isNotEmpty() && value.length % 4 != 1 && BASE64_URL_PATTERN.matches(value)

  private fun decodeBase64Url(value: String, maximumCharacters: Int): ByteArray {
    require(value.length <= maximumCharacters && isBase64Url(value)) {
      "The RS256 base64url input is invalid."
    }
    return try {
      Base64.decode(value, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
    } catch (_: IllegalArgumentException) {
      throw IllegalArgumentException("The RS256 base64url input is invalid.")
    }
  }

  private fun preferences() =
    requireContext().getSharedPreferences(NATIVE_PREFERENCES, Context.MODE_PRIVATE)

  private fun lockAndClearProtectedSearch() {
    val generation = markCleanupNeeded()
    FolioInboxWidgetProvider.lock(requireContext())
    if (unsupportedReason() == null) {
      clearAllSearch(generation = generation, unlockAfter = false)
    }
  }

  private data class SearchAccessConfiguration(
    val generation: Long,
    val needsCleanup: Boolean,
  )

  private fun configureSearchAccess(unlocked: Boolean): SearchAccessConfiguration =
    synchronized(searchAccessLock) {
      val generation = searchAccessGeneration.incrementAndGet()
      val pendingCleanup = preferences().getBoolean(CLEANUP_PENDING_KEY, false)
      val needsCleanup = !unlocked || pendingCleanup
      searchUnlocked = unlocked && !pendingCleanup
      if (!unlocked) {
        preferences().edit().putBoolean(CLEANUP_PENDING_KEY, true).apply()
      }
      SearchAccessConfiguration(generation, needsCleanup)
    }

  private fun beginSearchWrite(): Long? = synchronized(searchAccessLock) {
    if (
      searchUnlocked &&
        !preferences().getBoolean(CLEANUP_PENDING_KEY, false)
    ) {
      searchAccessGeneration.get()
    } else {
      null
    }
  }

  private fun mayWrite(expectedGeneration: Long): Boolean = synchronized(searchAccessLock) {
    searchUnlocked &&
      searchAccessGeneration.get() == expectedGeneration &&
      !preferences().getBoolean(CLEANUP_PENDING_KEY, false)
  }

  private fun markCleanupNeeded(): Long = synchronized(searchAccessLock) {
    val generation = searchAccessGeneration.incrementAndGet()
    searchUnlocked = false
    preferences().edit().putBoolean(CLEANUP_PENDING_KEY, true).apply()
    generation
  }

  private fun keepCleanupPendingIfCurrent(generation: Long): Boolean =
    synchronized(searchAccessLock) {
      if (searchAccessGeneration.get() != generation) return@synchronized false
      searchUnlocked = false
      preferences().edit().putBoolean(CLEANUP_PENDING_KEY, true).apply()
      true
    }

  private fun completeCleanupIfCurrent(generation: Long, unlockAfter: Boolean) =
    synchronized(searchAccessLock) {
      if (searchAccessGeneration.get() != generation) return@synchronized
      preferences().edit().putBoolean(CLEANUP_PENDING_KEY, false).apply()
      searchUnlocked = unlockAfter
    }

  private fun unsupportedReason(): String? {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return "android-appsearch-requires-api-31"
    return if (requireContext().getSystemService(AppSearchManager::class.java) == null) {
      "android-appsearch-service-unavailable"
    } else {
      null
    }
  }

  private fun requireSupported(promise: Promise): Boolean {
    val reason = unsupportedReason() ?: return true
    promise.reject(
      "ERR_FOLIO_SEARCH_UNSUPPORTED",
      "System-visible AppSearch is unavailable: $reason.",
      null,
    )
    return false
  }

  private fun rejectLocked(promise: Promise) {
    promise.reject(
      "ERR_FOLIO_SEARCH_LOCKED",
      "Folio must be unlocked before writing OS search entries.",
      null,
    )
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun withConfiguredSession(
    promise: Promise?,
    onFailure: ((String) -> Unit)? = null,
    operation: (AppSearchSession) -> Unit,
  ) {
    val manager = requireContext().getSystemService(AppSearchManager::class.java)
    if (manager == null) {
      promise?.reject(
        "ERR_FOLIO_SEARCH_UNSUPPORTED",
        "The Android AppSearch system service is unavailable.",
        null,
      )
      onFailure?.invoke("The Android AppSearch system service is unavailable.")
      return
    }
    val searchContext = AppSearchManager.SearchContext.Builder(DATABASE_NAME).build()
    manager.createSearchSession(searchContext, executor) { sessionResult ->
      if (!sessionResult.isSuccess) {
        promise?.reject(
          "ERR_FOLIO_SEARCH",
          sessionResult.errorMessage ?: "Android could not open the AppSearch index.",
          null,
        )
        onFailure?.invoke(
          sessionResult.errorMessage ?: "Android could not open the AppSearch index.",
        )
        return@createSearchSession
      }
      val session = sessionResult.resultValue
      if (session == null) {
        promise?.reject(
          "ERR_FOLIO_SEARCH",
          "Android opened AppSearch without returning a session.",
          null,
        )
        onFailure?.invoke("Android opened AppSearch without returning a session.")
        return@createSearchSession
      }
      val schema = appSearchSchema()
      val request = SetSchemaRequest.Builder()
        .addSchemas(schema)
        .setSchemaTypeDisplayedBySystem(SCHEMA_TYPE, true)
        // The prior FolioDocument schema did not retain a launch URL. Search
        // data is a reproducible cache, so replace it during this one-time
        // schema migration instead of leaving unlaunchable results.
        .setForceOverride(true)
        .build()
      session.setSchema(request, executor, executor) { schemaResult ->
        if (!schemaResult.isSuccess) {
          session.close()
          promise?.reject(
            "ERR_FOLIO_SEARCH",
            schemaResult.errorMessage ?: "Android could not configure the AppSearch schema.",
            null,
          )
          onFailure?.invoke(
            schemaResult.errorMessage ?: "Android could not configure the AppSearch schema.",
          )
        } else {
          operation(session)
        }
      }
    }
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun appSearchSchema(): AppSearchSchema {
    val title = AppSearchSchema.StringPropertyConfig.Builder(PROPERTY_TITLE)
      .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_REQUIRED)
      .setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_PREFIXES)
      .setTokenizerType(AppSearchSchema.StringPropertyConfig.TOKENIZER_TYPE_PLAIN)
      .build()
    val route = AppSearchSchema.StringPropertyConfig.Builder(PROPERTY_ROUTE)
      .setCardinality(AppSearchSchema.PropertyConfig.CARDINALITY_REQUIRED)
      .setIndexingType(AppSearchSchema.StringPropertyConfig.INDEXING_TYPE_NONE)
      .setTokenizerType(AppSearchSchema.StringPropertyConfig.TOKENIZER_TYPE_NONE)
      .build()
    return AppSearchSchema.Builder(SCHEMA_TYPE)
      .addProperty(title)
      .addProperty(route)
      .build()
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun genericDocument(entry: FolioSearchEntryRecord): GenericDocument {
    val profileId = validOpaqueId(entry.profileId, "Profile ID")
    val documentId = validOpaqueId(entry.documentId, "Document ID")
    val expectedIdentifier = "folio:$profileId:$documentId"
    require(entry.identifier == expectedIdentifier) {
      "Search entry identifier does not match its profile and document."
    }
    require(entry.displayTitle.isNotEmpty() && entry.displayTitle.length <= 100) {
      "Search entry title must contain 1 to 100 characters."
    }
    require(entry.updatedAtEpochMs.isFinite() && entry.updatedAtEpochMs >= 0) {
      "Search entry update date is invalid."
    }
    validDocumentRoute(entry.route, profileId, documentId)
    return FolioDocumentBuilder(namespace(profileId), expectedIdentifier)
      .setPropertyString(PROPERTY_TITLE, entry.displayTitle)
      .setPropertyString(PROPERTY_ROUTE, entry.route)
      .setCreationTimestampMillis(entry.updatedAtEpochMs.toLong())
      .build()
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun putDocuments(
    session: AppSearchSession,
    documents: List<GenericDocument>,
    promise: Promise,
    expectedGeneration: Long,
  ) {
    if (!mayWrite(expectedGeneration)) {
      session.close()
      rejectLocked(promise)
      return
    }
    val request = PutDocumentsRequest.Builder().addGenericDocuments(documents).build()
    session.put(request, executor, object : BatchResultCallback<String, Void> {
      override fun onResult(result: AppSearchBatchResult<String, Void>) {
        session.close()
        if (!mayWrite(expectedGeneration)) {
          clearAfterStaleWrite(promise)
        } else if (result.isSuccess) {
          promise.resolve()
        } else {
          promise.reject(
            "ERR_FOLIO_SEARCH",
            "Android rejected ${result.failures.size} OS search entries.",
            null,
          )
        }
      }

      override fun onSystemError(error: Throwable?) {
        session.close()
        if (!mayWrite(expectedGeneration)) {
          clearAfterStaleWrite(promise)
        } else {
          promise.reject("ERR_FOLIO_SEARCH", error?.message, error)
        }
      }
    })
  }

  private fun clearAfterStaleWrite(promise: Promise) {
    val cleanupGeneration = markCleanupNeeded()
    clearAllSearch(
      generation = cleanupGeneration,
      unlockAfter = false,
      onSuccess = {
        promise.reject(
          "ERR_FOLIO_SEARCH_LOCKED",
          "Folio locked before OS search reconciliation completed.",
          null,
        )
      },
      onFailure = { message ->
        promise.reject(
          "ERR_FOLIO_SEARCH",
          "$message Folio remains locked and OS search cleanup is pending.",
          null,
        )
      },
    )
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun removeAll(
    session: AppSearchSession,
    onSuccess: () -> Unit,
    onFailure: (String) -> Unit,
  ) {
    val spec = SearchSpec.Builder().addFilterSchemas(SCHEMA_TYPE).build()
    session.remove("", spec, executor) { result ->
      if (result.isSuccess) {
        onSuccess()
      } else {
        onFailure(result.errorMessage ?: "Android could not clear the AppSearch index.")
      }
    }
  }

  private fun clearAllSearch(
    generation: Long = searchAccessGeneration.get(),
    unlockAfter: Boolean = false,
    attempt: Int = 0,
    onSuccess: (() -> Unit)? = null,
    onFailure: ((String) -> Unit)? = null,
  ) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
      onFailure?.invoke(
        "System-visible AppSearch requires Android 12 or newer.",
      )
      return
    }
    fun failed(message: String) {
      val cleanupIsCurrent = keepCleanupPendingIfCurrent(generation)
      if (cleanupIsCurrent && attempt < 2) {
        executor.execute {
          clearAllSearch(
            generation,
            unlockAfter,
            attempt + 1,
            onSuccess,
            onFailure,
          )
        }
      } else {
        onFailure?.invoke(message)
      }
    }
    withConfiguredSession(promise = null, onFailure = ::failed) { session ->
      removeAll(session, {
        session.close()
        completeCleanupIfCurrent(generation, unlockAfter)
        onSuccess?.invoke()
      }, { message ->
        session.close()
        failed(message)
      })
    }
  }

  @RequiresApi(Build.VERSION_CODES.S)
  private fun removeIdentifierGroups(
    session: AppSearchSession,
    groups: List<Map.Entry<String, List<String>>>,
    index: Int,
    promise: Promise,
  ) {
    if (index >= groups.size) {
      session.close()
      promise.resolve()
      return
    }
    val group = groups[index]
    val request = RemoveByDocumentIdRequest.Builder(group.key).addIds(group.value).build()
    session.remove(request, executor, object : BatchResultCallback<String, Void> {
      override fun onResult(result: AppSearchBatchResult<String, Void>) {
        if (!result.isSuccess) {
          session.close()
          promise.reject(
            "ERR_FOLIO_SEARCH",
            "Android rejected ${result.failures.size} OS search removals.",
            null,
          )
          return
        }
        removeIdentifierGroups(session, groups, index + 1, promise)
      }

      override fun onSystemError(error: Throwable?) {
        session.close()
        promise.reject("ERR_FOLIO_SEARCH", error?.message, error)
      }
    })
  }

  private fun settleResult(result: AppSearchResult<Void>, promise: Promise) {
    if (result.isSuccess) {
      promise.resolve()
    } else {
      promise.reject(
        "ERR_FOLIO_SEARCH",
        result.errorMessage ?: "Android rejected the OS search operation.",
        null,
      )
    }
  }

  private fun parseIdentifier(identifier: String): Triple<String, String, String> {
    val parts = identifier.split(':')
    require(parts.size == 3 && parts[0] == "folio") { "Search entry identifier is invalid." }
    val profileId = validOpaqueId(parts[1], "Profile ID")
    val documentId = validOpaqueId(parts[2], "Document ID")
    return Triple(profileId, documentId, identifier)
  }

  private fun namespace(profileId: String) = "folio-profile-$profileId"

  private fun validOpaqueId(value: String, field: String): String {
    require(OPAQUE_ID_PATTERN.matches(value)) { "$field is invalid." }
    return value
  }

  private fun validDocumentRoute(route: String, profileId: String, documentId: String) {
    require(route.length <= 2_048) { "Search entry route is too long." }
    val uri = Uri.parse(route)
    require(
      uri.scheme == "folio-paperless" &&
        uri.host == "document" &&
        uri.pathSegments == listOf(documentId) &&
        uri.fragment == null &&
        uri.queryParameterNames == setOf("profile") &&
        uri.getQueryParameters("profile") == listOf(profileId)
    ) { "Search entry route is invalid." }
  }

  private companion object {
    val OPAQUE_ID_PATTERN = Regex("^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
    val BASE64_URL_PATTERN = Regex("^[A-Za-z0-9_-]+$")
  }
}
