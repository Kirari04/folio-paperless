import ExpoModulesCore
import Foundation
import Security
import UniformTypeIdentifiers
import UIKit

private final class FolioMtlsImportCoordinator: NSObject,
  UIDocumentPickerDelegate,
  UIAdaptivePresentationControllerDelegate {
  private weak var presenter: UIViewController?
  private let store: FolioMtlsIdentityStore
  private let completion: (Result<FolioMtlsStoredIdentity?, Error>) -> Void
  private var finished = false

  init(
    presenter: UIViewController,
    store: FolioMtlsIdentityStore,
    completion: @escaping (Result<FolioMtlsStoredIdentity?, Error>) -> Void
  ) {
    self.presenter = presenter
    self.store = store
    self.completion = completion
  }

  func present() {
    let types = [UTType(filenameExtension: "p12"), UTType(filenameExtension: "pfx")]
      .compactMap { $0 }
    let picker = UIDocumentPickerViewController(
      forOpeningContentTypes: types.isEmpty ? [.data] : types,
      asCopy: true
    )
    picker.delegate = self
    picker.presentationController?.delegate = self
    picker.allowsMultipleSelection = false
    if UIDevice.current.userInterfaceIdiom == .pad, let presenter {
      picker.modalPresentationStyle = .pageSheet
      picker.popoverPresentationController?.sourceView = presenter.view
      picker.popoverPresentationController?.sourceRect = CGRect(
        x: presenter.view.bounds.midX,
        y: presenter.view.bounds.maxY,
        width: 0,
        height: 0
      )
    }
    presenter?.present(picker, animated: true)
  }

  func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
    guard let url = urls.first, let presenter else {
      finish(.failure(FolioMtlsNativeFailure(code: "IMPORT", message: "The identity file is unavailable.")))
      return
    }
    let alert = UIAlertController(
      title: "Unlock client identity",
      message: "Enter the PKCS#12 password. It is handled only by iOS and is never sent to JavaScript.",
      preferredStyle: .alert
    )
    alert.addTextField { field in
      field.isSecureTextEntry = true
      field.textContentType = .password
      field.autocorrectionType = .no
      field.autocapitalizationType = .none
    }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
      self?.finish(.success(nil))
    })
    alert.addAction(UIAlertAction(title: "Import", style: .default) { [weak self, weak alert] _ in
      guard let self else { return }
      let password = alert?.textFields?.first?.text ?? ""
      DispatchQueue.global(qos: .userInitiated).async {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        do {
          let handle = try FileHandle(forReadingFrom: url)
          defer { try? handle.close() }
          var data = try handle.read(upToCount: folioMtlsMaxPkcs12Bytes + 1) ?? Data()
          defer { data.resetBytes(in: 0..<data.count) }
          guard !data.isEmpty, data.count <= folioMtlsMaxPkcs12Bytes else {
            throw FolioMtlsNativeFailure(
              code: "IMPORT",
              message: "The PKCS#12 identity exceeds Folio's 8 MiB safety limit."
            )
          }
          let identity = try self.store.importPKCS12(data, password: password)
          self.finish(.success(identity))
        } catch {
          self.finish(.failure(error))
        }
      }
    })
    presenter.present(alert, animated: true)
  }

  func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
    finish(.success(nil))
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    finish(.success(nil))
  }

  private func finish(_ result: Result<FolioMtlsStoredIdentity?, Error>) {
    objc_sync_enter(self)
    guard !finished else {
      objc_sync_exit(self)
      return
    }
    finished = true
    objc_sync_exit(self)
    completion(result)
  }
}

public final class FolioMtlsModule: Module {
  private let identityStore = FolioMtlsIdentityStore()
  private let transferLock = NSLock()
  private var transfers: [String: FolioMtlsTransfer] = [:]
  private var pendingTransferIds = Set<String>()
  private var canceledPendingTransferIds = Set<String>()
  private var importCoordinator: FolioMtlsImportCoordinator?
  private var identityUiActive = false

  public func definition() -> ModuleDefinition {
    Name("FolioMtls")
    Events("onTransferProgress")

    AsyncFunction("getCapabilitiesAsync") { () -> [String: Any] in
      ["available": true, "platform": "ios-keychain"]
    }

    AsyncFunction("listManagedClientIdentityRefsAsync") { () -> [String] in
      try identityStore.list().map(\.reference)
    }

    AsyncFunction("selectClientIdentityAsync") {
      (serverUrl: String, suggestedClientIdentityRef: String?, promise: Promise) in
      do {
        _ = try FolioMtlsRequestValidator.request(
          serverUrl: serverUrl,
          requestUrl: serverUrl,
          method: "GET",
          headers: [:]
        )
        guard !identityUiActive else {
          reject(promise, FolioMtlsNativeFailure(code: "BUSY", message: "Another identity operation is active."))
          return
        }
        guard let presenter = appContext?.utilities?.currentViewController() else {
          reject(promise, FolioMtlsNativeFailure(code: "UNAVAILABLE", message: "The identity picker cannot be presented."))
          return
        }
        let identities = try identityStore.list()
        if identities.isEmpty {
          promise.resolve(nil)
          return
        }
        identityUiActive = true
        let alert = UIAlertController(
          title: "Choose client identity",
          message: "Only certificate details are shown. Private keys remain in Keychain.",
          preferredStyle: .actionSheet
        )
        for item in identities {
          let subject = item.metadata["subject"] as? String ?? "Client identity"
          let expiry = item.metadata["expiresAt"] as? String ?? "unknown expiry"
          let selected = item.reference == suggestedClientIdentityRef
          alert.addAction(UIAlertAction(
            title: "\(selected ? "✓ " : "")\(subject) · \(expiry)",
            style: .default
          ) { [weak self] _ in
            self?.identityUiActive = false
            promise.resolve(item.selection)
          })
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
          self?.identityUiActive = false
          promise.resolve(nil)
        })
        if UIDevice.current.userInterfaceIdiom == .pad {
          alert.popoverPresentationController?.sourceView = presenter.view
          alert.popoverPresentationController?.sourceRect = CGRect(
            x: presenter.view.bounds.midX,
            y: presenter.view.bounds.maxY,
            width: 0,
            height: 0
          )
        }
        presenter.present(alert, animated: true)
      } catch {
        reject(promise, error)
      }
    }.runOnQueue(.main)

    AsyncFunction("importClientIdentityAsync") { (serverUrl: String, promise: Promise) in
      do {
        _ = try FolioMtlsRequestValidator.request(
          serverUrl: serverUrl,
          requestUrl: serverUrl,
          method: "GET",
          headers: [:]
        )
        guard !identityUiActive else {
          reject(promise, FolioMtlsNativeFailure(code: "BUSY", message: "Another identity operation is active."))
          return
        }
        guard let presenter = appContext?.utilities?.currentViewController() else {
          reject(promise, FolioMtlsNativeFailure(code: "UNAVAILABLE", message: "The identity importer cannot be presented."))
          return
        }
        identityUiActive = true
        let coordinator = FolioMtlsImportCoordinator(
          presenter: presenter,
          store: identityStore
        ) { [weak self] result in
          DispatchQueue.main.async {
            self?.identityUiActive = false
            self?.importCoordinator = nil
            switch result {
            case .success(let identity): promise.resolve(identity?.selection)
            case .failure(let error): self?.reject(promise, error)
            }
          }
        }
        importCoordinator = coordinator
        coordinator.present()
      } catch {
        identityUiActive = false
        reject(promise, error)
      }
    }.runOnQueue(.main)

    AsyncFunction("describeClientIdentityAsync") {
      (clientIdentityRef: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          promise.resolve(try self.identityStore.load(clientIdentityRef)?.metadata)
        } catch {
          self.reject(promise, error)
        }
      }
    }

    AsyncFunction("removeClientIdentityAsync") {
      (clientIdentityRef: String, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        do {
          try self.identityStore.delete(clientIdentityRef)
          promise.resolve(nil)
        } catch {
          self.reject(promise, error)
        }
      }
    }

    AsyncFunction("requestAsync") { (record: FolioMtlsRequestRecord, promise: Promise) in
      runTransfer(
        requestId: record.requestId,
        identityRef: record.clientIdentityRef,
        promise: promise
      ) { identity in
        var request = try FolioMtlsRequestValidator.request(
          serverUrl: record.serverUrl,
          requestUrl: record.url,
          method: record.method,
          headers: record.headers
        )
        let body = record.body.map { Data($0.utf8) }
        if let body { request.setValue(String(body.count), forHTTPHeaderField: "Content-Length") }
        return (request, .data(body), nil)
      }
    }

    AsyncFunction("downloadAsync") { (record: FolioMtlsDownloadRecord, promise: Promise) in
      runTransfer(
        requestId: record.requestId,
        identityRef: record.clientIdentityRef,
        promise: promise
      ) { identity in
        let request = try FolioMtlsRequestValidator.request(
          serverUrl: record.serverUrl,
          requestUrl: record.url,
          method: record.method,
          headers: record.headers
        )
        let destination = try FolioMtlsRequestValidator.privateFile(
          record.destinationUri,
          forWriting: true
        )
        guard
          record.maxBytes.isFinite,
          record.maxBytes >= 1,
          record.maxBytes <= Double(512 * 1024 * 1024),
          record.maxBytes.rounded(.down) == record.maxBytes
        else {
          throw FolioMtlsNativeFailure(code: "INVALID", message: "The download size limit is invalid.")
        }
        return (request, .download(destination, Int64(record.maxBytes)), nil)
      }
    }

    AsyncFunction("uploadMultipartAsync") { (record: FolioMtlsMultipartRecord, promise: Promise) in
      runTransfer(
        requestId: record.requestId,
        identityRef: record.clientIdentityRef,
        promise: promise
      ) { identity in
        let source = try FolioMtlsRequestValidator.privateFile(record.fileUri, forWriting: false)
        let attributes = try FileManager.default.attributesOfItem(atPath: source.path)
        guard (attributes[.size] as? NSNumber)?.int64Value ?? 0 > 0 else {
          throw FolioMtlsNativeFailure(code: "INVALID", message: "The upload source is unavailable.")
        }
        let boundary = "folio-\(UUID().uuidString.lowercased())"
        let multipart = try FolioMtlsMultipartBuilder.create(
          request: record,
          source: source,
          boundary: boundary
        )
        var headers = record.headers
        headers["Content-Type"] = "multipart/form-data; boundary=\(boundary)"
        let request = try FolioMtlsRequestValidator.request(
          serverUrl: record.serverUrl,
          requestUrl: record.url,
          method: record.method,
          headers: headers
        )
        return (request, .upload(multipart), multipart)
      }
    }

    AsyncFunction("cancelRequestAsync") { (requestId: String) in
      transferLock.lock()
      let transfer = transfers[requestId]
      if transfer == nil, pendingTransferIds.contains(requestId) {
        canceledPendingTransferIds.insert(requestId)
      }
      transferLock.unlock()
      transfer?.cancel()
    }

    OnDestroy {
      transferLock.lock()
      let pending = Array(transfers.values)
      canceledPendingTransferIds.formUnion(pendingTransferIds)
      transfers.removeAll()
      transferLock.unlock()
      pending.forEach { $0.cancel() }
      importCoordinator = nil
      identityUiActive = false
    }
  }

  private func runTransfer(
    requestId: String,
    identityRef: String,
    promise: Promise,
    build: @escaping (FolioMtlsStoredIdentity) throws -> (URLRequest, FolioMtlsTransfer.Mode, URL?)
  ) {
    guard requestId.range(of: "^[A-Za-z0-9._-]{1,128}$", options: .regularExpression) != nil else {
      reject(promise, FolioMtlsNativeFailure(code: "INVALID", message: "The request identifier is invalid."))
      return
    }
    transferLock.lock()
    let duplicate = transfers[requestId] != nil || pendingTransferIds.contains(requestId)
    if !duplicate { pendingTransferIds.insert(requestId) }
    transferLock.unlock()
    guard !duplicate else {
      reject(promise, FolioMtlsNativeFailure(code: "INVALID", message: "The request identifier is already active."))
      return
    }
    DispatchQueue.global(qos: .userInitiated).async {
      var cleanup: URL?
      defer {
        self.transferLock.lock()
        self.pendingTransferIds.remove(requestId)
        self.canceledPendingTransferIds.remove(requestId)
        self.transfers.removeValue(forKey: requestId)
        self.transferLock.unlock()
        if let cleanup { try? FileManager.default.removeItem(at: cleanup) }
      }
      do {
        guard let identity = try self.identityStore.load(identityRef) else {
          throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The client identity is unavailable.")
        }
        try self.assertUsable(identity)
        let (request, mode, temporary) = try build(identity)
        cleanup = temporary
        let transfer = FolioMtlsTransfer(
          requestId: requestId,
          identity: identity.identity,
          chain: identity.chain,
          mode: mode
        ) { completed, total in
          self.sendEvent("onTransferProgress", [
            "requestId": requestId,
            "completedBytes": completed,
            "totalBytes": total as Any
          ])
        }
        self.transferLock.lock()
        self.pendingTransferIds.remove(requestId)
        let canceled = self.canceledPendingTransferIds.remove(requestId) != nil
        if !canceled {
          self.transfers[requestId] = transfer
        }
        self.transferLock.unlock()
        if canceled {
          throw FolioMtlsNativeFailure(code: "CANCELED", message: "The request was canceled.")
        }
        promise.resolve(try transfer.execute(request).dictionary)
      } catch {
        self.reject(promise, error)
      }
    }
  }

  private func assertUsable(_ identity: FolioMtlsStoredIdentity) throws {
    guard identity.metadata["hasPrivateKey"] as? Bool == true else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_MISSING_PRIVATE_KEY", message: "The client identity has no private key.")
    }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    guard
      let notBeforeValue = identity.metadata["notBefore"] as? String,
      let expiryValue = identity.metadata["expiresAt"] as? String,
      let notBefore = formatter.date(from: notBeforeValue),
      let expiry = formatter.date(from: expiryValue)
    else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_EXPIRED", message: "The certificate validity period is unreadable.")
    }
    let now = Date()
    if now < notBefore {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_YET_VALID", message: "The certificate is not valid yet.")
    }
    if now >= expiry {
      throw FolioMtlsNativeFailure(code: "IDENTITY_EXPIRED", message: "The certificate has expired.")
    }
  }

  private func reject(_ promise: Promise, _ error: Error) {
    if let failure = error as? FolioMtlsNativeFailure {
      promise.reject("ERR_FOLIO_MTLS_\(failure.code)", failure.message)
    } else {
      promise.reject("ERR_FOLIO_MTLS_REQUEST", "The certificate-aware native operation failed.")
    }
  }
}
