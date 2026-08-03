import CoreSpotlight
import ExpoModulesCore
import Foundation

let folioShortcutEventName = "onShortcut"
let folioOpenUrlEventName = "onOpenUrl"
let folioSearchIndex = CSSearchableIndex(
  name: "FolioDocuments",
  protectionClass: .complete
)

final class FolioSearchPrivacyState: @unchecked Sendable {
  static let shared = FolioSearchPrivacyState()
  static let clearOnBackgroundKey = "app.folio.paperless.search.clear-on-background"
  static let cleanupPendingKey = "app.folio.paperless.search.cleanup-pending"

  private let lock = NSLock()
  private var unlocked = false
  private var generation: UInt64 = 0

  private init() {}

  /// Returns true when a successful clear must complete before writes may resume.
  func configure(
    unlocked requestedUnlocked: Bool,
    clearOnBackground: Bool
  ) -> (needsCleanup: Bool, generation: UInt64) {
    UserDefaults.standard.set(clearOnBackground, forKey: Self.clearOnBackgroundKey)
    lock.lock()
    generation &+= 1
    let pending = UserDefaults.standard.bool(forKey: Self.cleanupPendingKey)
    if requestedUnlocked && !pending {
      unlocked = true
    } else {
      unlocked = false
      if !requestedUnlocked {
        UserDefaults.standard.set(true, forKey: Self.cleanupPendingKey)
      }
    }
    let configuredGeneration = generation
    lock.unlock()
    return (!requestedUnlocked || pending, configuredGeneration)
  }

  func beginWrite() -> UInt64? {
    lock.lock()
    defer { lock.unlock() }
    guard unlocked, !UserDefaults.standard.bool(forKey: Self.cleanupPendingKey) else { return nil }
    return generation
  }

  func mayWrite(generation expectedGeneration: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return
      unlocked
      && generation == expectedGeneration
      && !UserDefaults.standard.bool(forKey: Self.cleanupPendingKey)
  }

  func markCleanupNeeded() {
    lock.lock()
    generation &+= 1
    unlocked = false
    UserDefaults.standard.set(true, forKey: Self.cleanupPendingKey)
    lock.unlock()
  }

  func markCleanupSucceeded(unlockAfter: Bool, expectedGeneration: UInt64? = nil) {
    lock.lock()
    let generationIsCurrent = expectedGeneration == nil || generation == expectedGeneration
    generation &+= 1
    UserDefaults.standard.set(false, forKey: Self.cleanupPendingKey)
    unlocked = generationIsCurrent ? unlockAfter : false
    lock.unlock()
  }

  func lockForBackgroundIfRequired() -> Bool {
    let defaults = UserDefaults.standard
    guard
      defaults.bool(forKey: Self.clearOnBackgroundKey)
      || defaults.bool(forKey: Self.cleanupPendingKey)
    else { return false }
    lock.lock()
    generation &+= 1
    unlocked = false
    defaults.set(true, forKey: Self.cleanupPendingKey)
    lock.unlock()
    return true
  }
}

final class FolioShortcutRegistry: @unchecked Sendable {
  static let shared = FolioShortcutRegistry()

  private let lock = NSLock()
  private var pendingShortcut: String?
  private var observer: ((String) -> Void)?

  private init() {}

  func setObserver(_ observer: ((String) -> Void)?) {
    lock.lock()
    self.observer = observer
    lock.unlock()
  }

  func deliver(_ shortcut: String) {
    lock.lock()
    let callback = observer
    if callback == nil {
      pendingShortcut = shortcut
    }
    lock.unlock()

    if let callback {
      DispatchQueue.main.async { callback(shortcut) }
    }
  }

  func consumePending() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let shortcut = pendingShortcut
    pendingShortcut = nil
    return shortcut
  }
}

final class FolioOpenUrlRegistry: @unchecked Sendable {
  static let shared = FolioOpenUrlRegistry()

  private let lock = NSLock()
  private var pendingUrl: String?
  private var observer: ((String) -> Void)?

  private init() {}

  func setObserver(_ observer: ((String) -> Void)?) {
    lock.lock()
    self.observer = observer
    lock.unlock()
  }

  func deliver(_ url: String) {
    lock.lock()
    let callback = observer
    if callback == nil {
      pendingUrl = url
    }
    lock.unlock()

    if let callback {
      DispatchQueue.main.async { callback(url) }
    }
  }

  func consumePending() -> String? {
    lock.lock()
    defer { lock.unlock() }
    let url = pendingUrl
    pendingUrl = nil
    return url
  }
}

enum FolioPlatformNativeError {
  static func reject(_ promise: Promise, code: String, message: String) {
    promise.reject(code, message)
  }
}
