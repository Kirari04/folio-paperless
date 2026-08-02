import CoreSpotlight
import ExpoModulesCore
import Foundation
import UniformTypeIdentifiers

private let folioProtectedStorageCoordinatorError = "ERR_FOLIO_PROTECTED_STORAGE_COORDINATOR"
private let folioProtectedStorageLeasePattern =
  "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"

/**
 Process-wide FIFO exclusion shared by foreground and headless Expo module
 instances. Random owner and lease capabilities never contain storage keys or
 values.
 */
private final class FolioProtectedStorageExclusiveCoordinator {
  static let shared = FolioProtectedStorageExclusiveCoordinator()

  private struct Request {
    let ownerId: String
    let leaseId: String
    let promise: Promise
  }

  private let lock = NSLock()
  private var registeredOwners = Set<String>()
  private var pending: [Request] = []
  private var active: Request?

  func registerOwner(_ ownerId: String) {
    lock.lock()
    defer { lock.unlock() }
    precondition(
      registeredOwners.insert(ownerId).inserted,
      "The protected-storage coordinator owner is already registered."
    )
  }

  func acquire(ownerId: String, promise: Promise) {
    var granted: Request? = nil
    lock.lock()
    let unavailable = !registeredOwners.contains(ownerId)
    if !unavailable {
      let request = Request(
        ownerId: ownerId,
        leaseId: UUID().uuidString.lowercased(),
        promise: promise
      )
      if active == nil {
        active = request
        granted = request
      } else {
        pending.append(request)
      }
    }
    lock.unlock()
    if unavailable {
      promise.reject(
        folioProtectedStorageCoordinatorError,
        "The protected-storage coordinator owner is unavailable."
      )
      return
    }
    if let granted {
      granted.promise.resolve(granted.leaseId)
    }
  }

  func release(ownerId: String, leaseId: String) throws {
    guard
      leaseId.range(of: folioProtectedStorageLeasePattern, options: .regularExpression) != nil
    else {
      throw coordinatorError("The protected-storage lease is invalid.")
    }
    lock.lock()
    guard let current = active else {
      lock.unlock()
      throw coordinatorError("No protected-storage lease is active.")
    }
    guard current.ownerId == ownerId, current.leaseId == leaseId else {
      lock.unlock()
      throw coordinatorError("The protected-storage lease is not owned by this module.")
    }
    active = nil
    let granted = takeNextLocked()
    lock.unlock()
    if let granted {
      granted.promise.resolve(granted.leaseId)
    }
  }

  func unregisterOwner(_ ownerId: String) {
    var canceled: [Request] = []
    var granted: Request? = nil
    lock.lock()
    registeredOwners.remove(ownerId)
    pending.removeAll { request in
      guard request.ownerId == ownerId else { return false }
      canceled.append(request)
      return true
    }
    if active?.ownerId == ownerId {
      active = nil
      granted = takeNextLocked()
    }
    lock.unlock()
    canceled.forEach { request in
      request.promise.reject(
        folioProtectedStorageCoordinatorError,
        "The protected-storage coordinator owner was destroyed while waiting."
      )
    }
    if let granted {
      granted.promise.resolve(granted.leaseId)
    }
  }

  private func takeNextLocked() -> Request? {
    guard !pending.isEmpty else { return nil }
    let next = pending.removeFirst()
    active = next
    return next
  }

  private func coordinatorError(_ message: String) -> NSError {
    NSError(
      domain: "app.folio.platform.protected-storage",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }
}

public final class FolioPlatformModule: Module {
  private let index = folioSearchIndex
  private let protectedStorageOwnerId: String = {
    let ownerId = UUID().uuidString.lowercased()
    FolioProtectedStorageExclusiveCoordinator.shared.registerOwner(ownerId)
    return ownerId
  }()

  public func definition() -> ModuleDefinition {
    Name("FolioPlatform")

    Events(folioShortcutEventName, folioOpenUrlEventName)

    OnStartObserving(folioShortcutEventName) {
      FolioShortcutRegistry.shared.setObserver { [weak self] shortcut in
        self?.sendEvent(folioShortcutEventName, ["id": shortcut])
      }
    }

    OnStopObserving(folioShortcutEventName) {
      FolioShortcutRegistry.shared.setObserver(nil)
    }

    OnStartObserving(folioOpenUrlEventName) {
      FolioOpenUrlRegistry.shared.setObserver { [weak self] url in
        self?.sendEvent(folioOpenUrlEventName, ["url": url])
      }
    }

    OnStopObserving(folioOpenUrlEventName) {
      FolioOpenUrlRegistry.shared.setObserver(nil)
    }

    AsyncFunction("getCapabilitiesAsync") { () -> [String: Any] in
      let available = CSSearchableIndex.isIndexingAvailable()
      return [
        "osSearch": [
          "supported": available,
          "engine": available ? "ios-core-spotlight" : "unsupported",
          "reason": available ? NSNull() : "core-spotlight-unavailable"
        ],
        "shortcuts": [
          "supported": true,
          "transport": "ios-app-delegate"
        ],
        "oidcRs256": [
          "supported": true,
          "engine": "security-framework"
        ]
      ]
    }

    AsyncFunction("acquireProtectedStorageLeaseAsync") { (promise: Promise) in
      FolioProtectedStorageExclusiveCoordinator.shared.acquire(
        ownerId: self.protectedStorageOwnerId,
        promise: promise
      )
    }

    AsyncFunction("releaseProtectedStorageLeaseAsync") { (leaseId: String) throws -> Void in
      try FolioProtectedStorageExclusiveCoordinator.shared.release(
        ownerId: self.protectedStorageOwnerId,
        leaseId: leaseId
      )
    }

    AsyncFunction("setSearchAccessStateAsync") {
      (unlocked: Bool, clearOnBackground: Bool, promise: Promise) in
      let access = FolioSearchPrivacyState.shared.configure(
        unlocked: unlocked,
        clearOnBackground: clearOnBackground
      )
      guard access.needsCleanup else {
        promise.resolve()
        return
      }
      guard CSSearchableIndex.isIndexingAvailable() else {
        promise.resolve()
        return
      }
      self.clearIndex(
        promise,
        unlockAfter: unlocked,
        expectedGeneration: access.generation
      )
    }

    AsyncFunction("replaceSearchIndexAsync") {
      (entries: [FolioSearchEntryRecord], promise: Promise) in
      guard self.requireIndexAvailable(promise) else { return }
      do {
        let items = try entries.map(self.searchableItem)
        guard let generation = FolioSearchPrivacyState.shared.beginWrite() else {
          FolioPlatformNativeError.reject(
            promise,
            code: "ERR_FOLIO_SEARCH_LOCKED",
            message: "Folio must be unlocked before writing OS search entries."
          )
          return
        }
        self.index.deleteAllSearchableItems { error in
          if let error {
            promise.reject(error)
            return
          }
          guard !items.isEmpty else {
            promise.resolve()
            return
          }
          guard FolioSearchPrivacyState.shared.mayWrite(generation: generation) else {
            self.clearAfterStaleWrite(promise)
            return
          }
          self.index.indexSearchableItems(items) { indexError in
            if let indexError {
              promise.reject(indexError)
            } else if !FolioSearchPrivacyState.shared.mayWrite(generation: generation) {
              self.clearAfterStaleWrite(promise)
            } else {
              promise.resolve()
            }
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("upsertSearchEntriesAsync") {
      (entries: [FolioSearchEntryRecord], promise: Promise) in
      guard self.requireIndexAvailable(promise) else { return }
      guard let generation = FolioSearchPrivacyState.shared.beginWrite() else {
        FolioPlatformNativeError.reject(
          promise,
          code: "ERR_FOLIO_SEARCH_LOCKED",
          message: "Folio must be unlocked before writing OS search entries."
        )
        return
      }
      do {
        let items = try entries.map(self.searchableItem)
        guard !items.isEmpty else {
          promise.resolve()
          return
        }
        self.index.indexSearchableItems(items) { error in
          if let error {
            promise.reject(error)
          } else if !FolioSearchPrivacyState.shared.mayWrite(generation: generation) {
            self.clearAfterStaleWrite(promise)
          } else {
            promise.resolve()
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("removeSearchEntriesAsync") {
      (identifiers: [String], promise: Promise) in
      guard self.requireIndexAvailable(promise) else { return }
      do {
        let safeIdentifiers = try identifiers.map(self.validIdentifier)
        guard !safeIdentifiers.isEmpty else {
          promise.resolve()
          return
        }
        self.index.deleteSearchableItems(withIdentifiers: safeIdentifiers) { error in
          if let error {
            promise.reject(error)
          } else {
            promise.resolve()
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("removeSearchProfileAsync") {
      (profileId: String, promise: Promise) in
      guard self.requireIndexAvailable(promise) else { return }
      do {
        let domain = try self.profileDomain(profileId)
        self.index.deleteSearchableItems(withDomainIdentifiers: [domain]) { error in
          if let error {
            promise.reject(error)
          } else {
            promise.resolve()
          }
        }
      } catch {
        promise.reject(error)
      }
    }

    AsyncFunction("clearSearchIndexAsync") { (promise: Promise) in
      FolioSearchPrivacyState.shared.markCleanupNeeded()
      self.clearIndex(promise, unlockAfter: false, expectedGeneration: nil)
    }

    AsyncFunction("consumeInitialShortcutAsync") { () -> String? in
      return FolioShortcutRegistry.shared.consumePending()
    }

    AsyncFunction("consumeInitialUrlAsync") { () -> String? in
      return FolioOpenUrlRegistry.shared.consumePending()
    }

    AsyncFunction("verifyOidcRs256Async") {
      (
        signingInput: String,
        signatureBase64Url: String,
        modulusBase64Url: String,
        exponentBase64Url: String
      ) throws -> Bool in
      return try folioVerifyOidcRs256(
        signingInput: signingInput,
        signatureBase64Url: signatureBase64Url,
        modulusBase64Url: modulusBase64Url,
        exponentBase64Url: exponentBase64Url
      )
    }

    AsyncFunction("excludeFileFromBackupAsync") { (fileUri: String) throws -> Void in
      guard
        let source = URL(string: fileUri),
        source.isFileURL,
        source.host == nil || source.host?.isEmpty == true,
        source.query == nil,
        source.fragment == nil
      else {
        throw self.validationError("The sensitive file URI is invalid.")
      }
      let file = source.standardizedFileURL.resolvingSymlinksInPath()
      guard let documents = FileManager.default.urls(
        for: .documentDirectory,
        in: .userDomainMask
      ).first else {
        throw self.validationError("The private document directory is unavailable.")
      }
      let stagingRoot = documents
        .appendingPathComponent("folio", isDirectory: true)
        .appendingPathComponent("profiles", isDirectory: true)
        .standardizedFileURL
        .resolvingSymlinksInPath()
      let rootPath = stagingRoot.path.hasSuffix("/") ? stagingRoot.path : "\(stagingRoot.path)/"
      guard file.path.hasPrefix(rootPath) else {
        throw self.validationError("The sensitive file is outside Folio private staging.")
      }
      let values = try file.resourceValues(forKeys: [.isRegularFileKey])
      guard values.isRegularFile == true else {
        throw self.validationError("The sensitive staging file is unavailable.")
      }
      var protectedFile = file
      var protection = URLResourceValues()
      protection.isExcludedFromBackup = true
      try protectedFile.setResourceValues(protection)
      let readback = try protectedFile.resourceValues(forKeys: [.isExcludedFromBackupKey])
      guard readback.isExcludedFromBackup == true else {
        throw self.validationError("The sensitive file could not be excluded from backup.")
      }
    }

    OnDestroy {
      FolioProtectedStorageExclusiveCoordinator.shared.unregisterOwner(
        self.protectedStorageOwnerId
      )
    }
  }

  private func clearIndex(
    _ promise: Promise,
    unlockAfter: Bool,
    expectedGeneration: UInt64?
  ) {
    guard requireIndexAvailable(promise) else { return }
    index.deleteAllSearchableItems { error in
      if let error {
        FolioSearchPrivacyState.shared.markCleanupNeeded()
        promise.reject(error)
      } else {
        FolioSearchPrivacyState.shared.markCleanupSucceeded(
          unlockAfter: unlockAfter,
          expectedGeneration: expectedGeneration
        )
        promise.resolve()
      }
    }
  }

  private func clearAfterStaleWrite(_ promise: Promise) {
    FolioSearchPrivacyState.shared.markCleanupNeeded()
    index.deleteAllSearchableItems { error in
      if let error {
        promise.reject(error)
      } else {
        FolioSearchPrivacyState.shared.markCleanupSucceeded(unlockAfter: false)
        FolioPlatformNativeError.reject(
          promise,
          code: "ERR_FOLIO_SEARCH_LOCKED",
          message: "Folio locked before OS search reconciliation completed."
        )
      }
    }
  }

  private func requireIndexAvailable(_ promise: Promise) -> Bool {
    guard CSSearchableIndex.isIndexingAvailable() else {
      FolioPlatformNativeError.reject(
        promise,
        code: "ERR_FOLIO_SEARCH_UNSUPPORTED",
        message: "Core Spotlight indexing is unavailable on this device."
      )
      return false
    }
    return true
  }

  private func searchableItem(_ entry: FolioSearchEntryRecord) throws -> CSSearchableItem {
    let profileId = try validOpaqueId(entry.profileId, field: "Profile ID")
    let documentId = try validOpaqueId(entry.documentId, field: "Document ID")
    let expectedIdentifier = "folio:\(profileId):\(documentId)"
    guard entry.identifier == expectedIdentifier else {
      throw validationError("Search entry identifier does not match its profile and document.")
    }
    guard !entry.displayTitle.isEmpty, entry.displayTitle.count <= 100 else {
      throw validationError("Search entry title must contain 1 to 100 characters.")
    }
    guard entry.updatedAtEpochMs.isFinite, entry.updatedAtEpochMs >= 0 else {
      throw validationError("Search entry update date is invalid.")
    }
    _ = try validDocumentRoute(
      entry.route,
      profileId: profileId,
      documentId: documentId
    )

    let attributes = CSSearchableItemAttributeSet(contentType: UTType.item)
    attributes.title = entry.displayTitle
    attributes.contentModificationDate = Date(timeIntervalSince1970: entry.updatedAtEpochMs / 1_000)
    let item = CSSearchableItem(
      uniqueIdentifier: expectedIdentifier,
      domainIdentifier: try profileDomain(profileId),
      attributeSet: attributes
    )
    item.expirationDate = nil
    return item
  }

  private func validIdentifier(_ identifier: String) throws -> String {
    let components = identifier.split(separator: ":", omittingEmptySubsequences: false)
    guard components.count == 3, components[0] == "folio" else {
      throw validationError("Search entry identifier is invalid.")
    }
    _ = try validOpaqueId(String(components[1]), field: "Profile ID")
    _ = try validOpaqueId(String(components[2]), field: "Document ID")
    return identifier
  }

  private func profileDomain(_ profileId: String) throws -> String {
    return "app.folio.paperless.search.\(try validOpaqueId(profileId, field: "Profile ID"))"
  }

  private func validOpaqueId(_ value: String, field: String) throws -> String {
    guard
      value.count >= 1,
      value.count <= 128,
      value.range(of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$", options: .regularExpression) != nil
    else {
      throw validationError("\(field) is invalid.")
    }
    return value
  }

  private func validDocumentRoute(
    _ value: String,
    profileId: String,
    documentId: String
  ) throws -> URL {
    guard
      value.count <= 2_048,
      let components = URLComponents(string: value),
      components.scheme == "folio-paperless",
      components.host == "document",
      components.path == "/\(documentId)",
      components.fragment == nil,
      let queryItems = components.queryItems,
      queryItems.count == 1,
      queryItems[0].name == "profile",
      queryItems[0].value == profileId,
      let url = components.url
    else {
      throw validationError("Search entry route is invalid.")
    }
    return url
  }

  private func validationError(_ message: String) -> Error {
    return NSError(
      domain: "app.folio.platform",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }
}
