import CoreSpotlight
import ExpoModulesCore
import UIKit

public final class FolioPlatformAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    clearProtectedSearchIndexIfNeeded()
    guard
      let item = launchOptions?[.shortcutItem] as? UIApplicationShortcutItem,
      let shortcut = Self.shortcutId(for: item.type)
    else {
      return false
    }
    FolioShortcutRegistry.shared.deliver(shortcut)
    return true
  }

  public func applicationDidEnterBackground(_ application: UIApplication) {
    clearProtectedSearchIndexIfNeeded()
  }

  public func application(
    _ application: UIApplication,
    performActionFor shortcutItem: UIApplicationShortcutItem,
    completionHandler: @escaping (Bool) -> Void
  ) {
    guard let shortcut = Self.shortcutId(for: shortcutItem.type) else {
      completionHandler(false)
      return
    }
    FolioShortcutRegistry.shared.deliver(shortcut)
    completionHandler(true)
  }

  public func application(
    _ application: UIApplication,
    continue userActivity: NSUserActivity,
    restorationHandler: @escaping ([any UIUserActivityRestoring]?) -> Void
  ) -> Bool {
    guard
      userActivity.activityType == CSSearchableItemActionType,
      let identifier = userActivity.userInfo?[CSSearchableItemActivityIdentifier] as? String,
      let route = Self.searchRoute(for: identifier)
    else {
      return false
    }
    FolioOpenUrlRegistry.shared.deliver(route)
    return true
  }

  private func clearProtectedSearchIndexIfNeeded() {
    guard FolioSearchPrivacyState.shared.lockForBackgroundIfRequired() else { return }
    clearProtectedSearchIndex(attempt: 0)
  }

  private func clearProtectedSearchIndex(attempt: Int) {
    folioSearchIndex.deleteAllSearchableItems { error in
      if error == nil {
        FolioSearchPrivacyState.shared.markCleanupSucceeded(unlockAfter: false)
      } else if attempt < 2 {
        DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + 0.25) {
          self.clearProtectedSearchIndex(attempt: attempt + 1)
        }
      } else {
        FolioSearchPrivacyState.shared.markCleanupNeeded()
      }
    }
  }

  private static func shortcutId(for nativeType: String) -> String? {
    switch nativeType {
    case "app.folio.paperless.quick-scan":
      return "quick-scan"
    case "app.folio.paperless.inbox":
      return "inbox"
    case "app.folio.paperless.search":
      return "search"
    default:
      return nil
    }
  }

  private static func searchRoute(for identifier: String) -> String? {
    let components = identifier.split(separator: ":", omittingEmptySubsequences: false)
    guard
      components.count == 3,
      components[0] == "folio",
      isValidOpaqueId(String(components[1])),
      isValidOpaqueId(String(components[2]))
    else {
      return nil
    }
    return "folio-paperless://document/\(components[2])?profile=\(components[1])"
  }

  private static func isValidOpaqueId(_ value: String) -> Bool {
    return
      value.count >= 1
      && value.count <= 128
      && value.range(
        of: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        options: .regularExpression
      ) != nil
  }
}
