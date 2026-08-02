import CryptoKit
import Foundation
import Security

let folioMtlsMaxPkcs12Bytes = 8 * 1024 * 1024

struct FolioMtlsStoredIdentity {
  let reference: String
  let identity: SecIdentity
  let chain: [SecCertificate]
  let metadata: [String: Any]

  var selection: [String: Any] {
    ["identity": metadata, "clientIdentityRef": reference]
  }
}

final class FolioMtlsIdentityStore {
  private let identityPrefix = "app.folio.paperless.mtls.identity."
  private let chainService = "app.folio.paperless.mtls.certificate-chain"
  private let referencePrefix = "ios-keychain:"

  func importPKCS12(_ input: Data, password: String) throws -> FolioMtlsStoredIdentity {
    guard !input.isEmpty, input.count <= folioMtlsMaxPkcs12Bytes else {
      throw FolioMtlsNativeFailure(
        code: "IMPORT",
        message: "The PKCS#12 identity exceeds Folio's 8 MiB safety limit."
      )
    }
    var items: CFArray?
    let status = SecPKCS12Import(
      input as CFData,
      [kSecImportExportPassphrase as String: password] as CFDictionary,
      &items
    )
    guard status == errSecSuccess else {
      throw FolioMtlsNativeFailure(
        code: "IMPORT",
        message: status == errSecAuthFailed
          ? "The PKCS#12 password is incorrect or the file is damaged."
          : "The PKCS#12 identity could not be decoded."
      )
    }
    guard
      let dictionaries = items as? [[String: Any]],
      let imported = dictionaries.first,
      let identity = imported[kSecImportItemIdentity as String] as? SecIdentity
    else {
      throw FolioMtlsNativeFailure(
        code: "IDENTITY_MISSING_PRIVATE_KEY",
        message: "The PKCS#12 file does not contain a client identity."
      )
    }
    let importedChain = (imported[kSecImportItemCertChain as String] as? [SecCertificate]) ?? []
    let leaf = try certificate(for: identity)
    let fingerprint = fingerprintSha256(leaf)
    if let existing = try list().first(where: {
      $0.metadata["fingerprintSha256"] as? String == fingerprint
    }) {
      return existing
    }

    let identifier = UUID().uuidString.lowercased()
    let reference = referencePrefix + identifier
    let label = identityPrefix + identifier
    let addIdentity: [CFString: Any] = [
      kSecClass: kSecClassIdentity,
      kSecValueRef: identity,
      kSecAttrLabel: label,
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    ]
    let addStatus = SecItemAdd(addIdentity as CFDictionary, nil)
    guard addStatus == errSecSuccess else {
      throw FolioMtlsNativeFailure(code: "IMPORT", message: "The identity could not be saved in Keychain.")
    }
    do {
      let chain = normalizedChain(importedChain, leaf: leaf)
      try saveChain(chain, identifier: identifier)
      guard let stored = try load(reference) else {
        throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The saved identity could not be reopened.")
      }
      return stored
    } catch {
      try? delete(reference)
      throw error
    }
  }

  func list() throws -> [FolioMtlsStoredIdentity] {
    let query: [CFString: Any] = [
      kSecClass: kSecClassIdentity,
      kSecMatchLimit: kSecMatchLimitAll,
      kSecReturnAttributes: true,
      kSecReturnRef: true
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "Keychain identities could not be read.")
    }
    let entries: [[String: Any]]
    if let many = result as? [[String: Any]] {
      entries = many
    } else if let one = result as? [String: Any] {
      entries = [one]
    } else {
      entries = []
    }
    return try entries.compactMap { entry in
      guard
        let label = entry[kSecAttrLabel as String] as? String,
        label.hasPrefix(identityPrefix),
        let identity = entry[kSecValueRef as String] as? SecIdentity
      else { return nil }
      let identifier = String(label.dropFirst(identityPrefix.count))
      let reference = referencePrefix + identifier
      return try storedIdentity(reference: reference, identifier: identifier, identity: identity)
    }
  }

  func load(_ reference: String) throws -> FolioMtlsStoredIdentity? {
    let identifier = try identifier(from: reference)
    let query: [CFString: Any] = [
      kSecClass: kSecClassIdentity,
      kSecAttrLabel: identityPrefix + identifier,
      kSecMatchLimit: kSecMatchLimitOne,
      kSecReturnRef: true
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let identity = result as? SecIdentity else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The Keychain identity is unavailable.")
    }
    return try storedIdentity(reference: reference, identifier: identifier, identity: identity)
  }

  func delete(_ reference: String) throws {
    let identifier = try identifier(from: reference)
    let identityStatus = SecItemDelete([
      kSecClass: kSecClassIdentity,
      kSecAttrLabel: identityPrefix + identifier
    ] as CFDictionary)
    guard identityStatus == errSecSuccess || identityStatus == errSecItemNotFound else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The Keychain identity could not be removed.")
    }
    let chainStatus = SecItemDelete([
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: chainService,
      kSecAttrAccount: identifier
    ] as CFDictionary)
    guard chainStatus == errSecSuccess || chainStatus == errSecItemNotFound else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The certificate chain could not be removed.")
    }
  }

  private func storedIdentity(
    reference: String,
    identifier: String,
    identity: SecIdentity
  ) throws -> FolioMtlsStoredIdentity {
    let leaf = try certificate(for: identity)
    let chain = try loadChain(identifier: identifier, leaf: leaf)
    return FolioMtlsStoredIdentity(
      reference: reference,
      identity: identity,
      chain: chain,
      metadata: try metadata(certificate: leaf, identityId: identifier)
    )
  }

  private func certificate(for identity: SecIdentity) throws -> SecCertificate {
    var certificate: SecCertificate?
    let status = SecIdentityCopyCertificate(identity, &certificate)
    guard status == errSecSuccess, let certificate else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The identity certificate is unavailable.")
    }
    return certificate
  }

  private func normalizedChain(
    _ imported: [SecCertificate],
    leaf: SecCertificate
  ) -> [SecCertificate] {
    let leafData = SecCertificateCopyData(leaf) as Data
    let remaining = imported.filter { SecCertificateCopyData($0) as Data != leafData }
    return [leaf] + remaining
  }

  private func saveChain(_ chain: [SecCertificate], identifier: String) throws {
    let data = try PropertyListSerialization.data(
      fromPropertyList: chain.map { SecCertificateCopyData($0) as Data },
      format: .binary,
      options: 0
    )
    let status = SecItemAdd([
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: chainService,
      kSecAttrAccount: identifier,
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecValueData: data
    ] as CFDictionary, nil)
    guard status == errSecSuccess else {
      throw FolioMtlsNativeFailure(code: "IMPORT", message: "The certificate chain could not be saved.")
    }
  }

  private func loadChain(identifier: String, leaf: SecCertificate) throws -> [SecCertificate] {
    var result: CFTypeRef?
    let status = SecItemCopyMatching([
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: chainService,
      kSecAttrAccount: identifier,
      kSecMatchLimit: kSecMatchLimitOne,
      kSecReturnData: true
    ] as CFDictionary, &result)
    if status == errSecItemNotFound { return [leaf] }
    guard status == errSecSuccess, let data = result as? Data else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The certificate chain is unavailable.")
    }
    let raw = try PropertyListSerialization.propertyList(from: data, format: nil) as? [Data] ?? []
    let certificates = raw.compactMap { SecCertificateCreateWithData(nil, $0 as CFData) }
    return certificates.isEmpty ? [leaf] : certificates
  }

  private func metadata(certificate: SecCertificate, identityId: String) throws -> [String: Any] {
    let summary = SecCertificateCopySubjectSummary(certificate).map { $0 as String }
    let subject = distinguishedName(certificate, oid: kSecOIDX509V1SubjectName)
      ?? summary
      ?? "Unknown subject"
    let issuer = distinguishedName(certificate, oid: kSecOIDX509V1IssuerName)
      ?? "Unknown issuer"
    guard
      let notBefore = certificateDate(certificate, oid: kSecOIDX509V1ValidityNotBefore),
      let expiresAt = certificateDate(certificate, oid: kSecOIDX509V1ValidityNotAfter)
    else {
      throw FolioMtlsNativeFailure(code: "IMPORT", message: "The certificate validity period is unreadable.")
    }
    return [
      "identityId": identityId,
      "subject": subject,
      "issuer": issuer,
      "notBefore": iso8601(notBefore),
      "expiresAt": iso8601(expiresAt),
      "fingerprintSha256": fingerprintSha256(certificate),
      "hasPrivateKey": true,
      "source": "managed-native-identity"
    ]
  }

  private func certificateProperty(_ certificate: SecCertificate, oid: CFString) -> [String: Any]? {
    guard
      let values = SecCertificateCopyValues(certificate, [oid] as CFArray, nil) as? [String: Any],
      let property = values[oid as String] as? [String: Any]
    else { return nil }
    return property
  }

  private func certificateDate(_ certificate: SecCertificate, oid: CFString) -> Date? {
    certificateProperty(certificate, oid: oid)?[kSecPropertyKeyValue as String] as? Date
  }

  private func distinguishedName(_ certificate: SecCertificate, oid: CFString) -> String? {
    guard
      let fields = certificateProperty(certificate, oid: oid)?[kSecPropertyKeyValue as String]
        as? [[String: Any]]
    else { return nil }
    let components = fields.compactMap { field -> String? in
      let label = field[kSecPropertyKeyLabel as String] as? String
      let value = field[kSecPropertyKeyValue as String]
      guard let label, let value else { return nil }
      return "\(label)=\(value)"
    }
    return components.isEmpty ? nil : components.joined(separator: ", ")
  }

  private func fingerprintSha256(_ certificate: SecCertificate) -> String {
    SHA256.hash(data: SecCertificateCopyData(certificate) as Data)
      .map { String(format: "%02X", $0) }
      .joined(separator: ":")
  }

  private func identifier(from reference: String) throws -> String {
    guard reference.hasPrefix(referencePrefix) else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The identity reference is invalid.")
    }
    let value = String(reference.dropFirst(referencePrefix.count))
    guard UUID(uuidString: value) != nil else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The identity reference is invalid.")
    }
    return value.lowercased()
  }

  private func iso8601(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}
