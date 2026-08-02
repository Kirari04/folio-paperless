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
      let identity = secIdentity(imported[kSecImportItemIdentity as String])
    else {
      throw FolioMtlsNativeFailure(
        code: "IDENTITY_MISSING_PRIVATE_KEY",
        message: "The PKCS#12 file does not contain a client identity."
      )
    }
    guard let importedTrust = secTrust(imported[kSecImportItemTrust as String]) else {
      throw invalidChain("The PKCS#12 identity does not contain an evaluable certificate chain.")
    }
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
      let chain = try intermediates(from: importedTrust, leaf: leaf)
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
        let identity = secIdentity(entry[kSecValueRef as String])
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
    guard status == errSecSuccess, let identity = secIdentity(result) else {
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

  private func intermediates(
    from trust: SecTrust,
    leaf: SecCertificate
  ) throws -> [SecCertificate] {
    let leafData = SecCertificateCopyData(leaf) as Data
    let evaluated = try certificateChain(from: trust)
    guard let first = evaluated.first,
      SecCertificateCopyData(first) as Data == leafData
    else {
      throw invalidChain("The evaluated client certificate chain does not begin with its identity.")
    }

    var seen = Set<Data>()
    for certificate in evaluated {
      let data = SecCertificateCopyData(certificate) as Data
      guard seen.insert(data).inserted else {
        throw invalidChain("The evaluated client certificate chain contains a duplicate certificate.")
      }
    }

    // SecTrust establishes the ordered path cryptographically. Rechecking each
    // edge with an anchor-limited two-certificate trust also protects chains
    // reconstructed from persisted public certificates below.
    if evaluated.count > 1 {
      for index in 0..<(evaluated.count - 1) {
        guard try certificate(evaluated[index], wasIssuedBy: evaluated[index + 1]) else {
          throw invalidChain("The evaluated client certificate chain has an invalid issuer relationship.")
        }
      }
    }

    var result = Array(evaluated.dropFirst())
    // URLCredential receives the leaf through `identity`; its certificate list
    // therefore contains only intermediates. Omit only a self-issued certificate
    // whose signature verifies under its own public key. A cross-signed or local
    // non-self-signed anchor may still be required by the peer and must remain.
    if let last = result.last, isCryptographicallySelfSigned(last) {
      result.removeLast()
    }
    return result
  }

  private func rebuiltIntermediates(
    _ stored: [SecCertificate],
    leaf: SecCertificate
  ) throws -> [SecCertificate] {
    let leafData = SecCertificateCopyData(leaf) as Data
    var seen = Set<Data>([leafData])
    let candidates = stored.filter { certificate in
      seen.insert(SecCertificateCopyData(certificate) as Data).inserted
    }
    guard !candidates.isEmpty else { return [] }

    let trust = try makeTrust(certificates: [leaf] + candidates)
    guard SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess else {
      throw invalidChain("The saved client certificate chain could not be evaluated safely.")
    }
    _ = SecTrustEvaluateWithError(trust, nil)
    return try intermediates(from: trust, leaf: leaf)
  }

  private func certificate(
    _ certificate: SecCertificate,
    wasIssuedBy issuer: SecCertificate
  ) throws -> Bool {
    let trust = try makeTrust(certificates: [certificate, issuer])
    guard SecTrustSetAnchorCertificates(trust, [issuer] as CFArray) == errSecSuccess,
      SecTrustSetAnchorCertificatesOnly(trust, true) == errSecSuccess,
      SecTrustSetNetworkFetchAllowed(trust, false) == errSecSuccess,
      SecTrustSetVerifyDate(trust, try verificationDate(for: [certificate, issuer]) as CFDate) == errSecSuccess,
      SecTrustEvaluateWithError(trust, nil)
    else {
      return false
    }

    let evaluated = try certificateChain(from: trust)
    return evaluated.count == 2
      && SecCertificateCopyData(evaluated[0]) as Data == SecCertificateCopyData(certificate) as Data
      && SecCertificateCopyData(evaluated[1]) as Data == SecCertificateCopyData(issuer) as Data
  }

  private func isCryptographicallySelfSigned(_ certificate: SecCertificate) -> Bool {
    guard
      let normalizedSubject = SecCertificateCopyNormalizedSubjectSequence(certificate) as Data?,
      let normalizedIssuer = SecCertificateCopyNormalizedIssuerSequence(certificate) as Data?,
      normalizedSubject == normalizedIssuer,
      let fields = try? FolioMtlsCertificateParser.parse(SecCertificateCopyData(certificate) as Data),
      let signatureAlgorithm = fields.signatureAlgorithm,
      let publicKey = SecCertificateCopyKey(certificate)
    else { return false }
    let algorithm = securityAlgorithm(signatureAlgorithm)
    guard SecKeyIsAlgorithmSupported(publicKey, .verify, algorithm) else { return false }
    return SecKeyVerifySignature(
      publicKey,
      algorithm,
      fields.signedData as CFData,
      fields.signature as CFData,
      nil
    )
  }

  private func securityAlgorithm(
    _ algorithm: FolioMtlsCertificateSignatureAlgorithm
  ) -> SecKeyAlgorithm {
    switch algorithm {
    case .rsaPkcs1Sha1: return .rsaSignatureMessagePKCS1v15SHA1
    case .rsaPkcs1Sha224: return .rsaSignatureMessagePKCS1v15SHA224
    case .rsaPkcs1Sha256: return .rsaSignatureMessagePKCS1v15SHA256
    case .rsaPkcs1Sha384: return .rsaSignatureMessagePKCS1v15SHA384
    case .rsaPkcs1Sha512: return .rsaSignatureMessagePKCS1v15SHA512
    case .rsaPssSha1: return .rsaSignatureMessagePSSSHA1
    case .rsaPssSha224: return .rsaSignatureMessagePSSSHA224
    case .rsaPssSha256: return .rsaSignatureMessagePSSSHA256
    case .rsaPssSha384: return .rsaSignatureMessagePSSSHA384
    case .rsaPssSha512: return .rsaSignatureMessagePSSSHA512
    case .ecdsaSha1: return .ecdsaSignatureMessageX962SHA1
    case .ecdsaSha224: return .ecdsaSignatureMessageX962SHA224
    case .ecdsaSha256: return .ecdsaSignatureMessageX962SHA256
    case .ecdsaSha384: return .ecdsaSignatureMessageX962SHA384
    case .ecdsaSha512: return .ecdsaSignatureMessageX962SHA512
    }
  }

  private func verificationDate(for certificates: [SecCertificate]) throws -> Date {
    let fields: [FolioMtlsCertificateFields]
    do {
      fields = try certificates.map {
        try FolioMtlsCertificateParser.parse(SecCertificateCopyData($0) as Data)
      }
    } catch {
      throw invalidChain("The client certificate chain validity period is unreadable.")
    }
    guard
      let lowerBound = fields.map(\.notBefore).max(),
      let upperBound = fields.map(\.notAfter).min(),
      lowerBound < upperBound
    else {
      throw invalidChain("The client certificate chain has no common validity period.")
    }
    return lowerBound.addingTimeInterval(upperBound.timeIntervalSince(lowerBound) / 2)
  }

  private func makeTrust(certificates: [SecCertificate]) throws -> SecTrust {
    var trust: SecTrust?
    let status = SecTrustCreateWithCertificates(
      certificates as CFArray,
      SecPolicyCreateBasicX509(),
      &trust
    )
    guard status == errSecSuccess, let trust else {
      throw invalidChain("The client certificate chain could not be evaluated.")
    }
    return trust
  }

  private func certificateChain(from trust: SecTrust) throws -> [SecCertificate] {
    guard let values = SecTrustCopyCertificateChain(trust) as? [Any] else {
      throw invalidChain("The client certificate chain is unavailable.")
    }
    let certificates = values.compactMap { secCertificate($0) }
    guard certificates.count == values.count, !certificates.isEmpty else {
      throw invalidChain("The client certificate chain is malformed.")
    }
    return certificates
  }

  private func invalidChain(_ message: String) -> FolioMtlsNativeFailure {
    FolioMtlsNativeFailure(code: "IMPORT", message: message)
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
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let data = result as? Data else {
      throw FolioMtlsNativeFailure(code: "IDENTITY_NOT_FOUND", message: "The certificate chain is unavailable.")
    }
    let propertyList = try PropertyListSerialization.propertyList(from: data, format: nil)
    guard let raw = propertyList as? [Data] else {
      throw invalidChain("The saved client certificate chain is malformed.")
    }
    let certificates = raw.compactMap { SecCertificateCreateWithData(nil, $0 as CFData) }
    guard certificates.count == raw.count else {
      throw invalidChain("The saved client certificate chain is malformed.")
    }
    return try rebuiltIntermediates(certificates, leaf: leaf)
  }

  private func metadata(certificate: SecCertificate, identityId: String) throws -> [String: Any] {
    let summary = SecCertificateCopySubjectSummary(certificate).map { $0 as String }
    let fields: FolioMtlsCertificateFields
    do {
      fields = try FolioMtlsCertificateParser.parse(SecCertificateCopyData(certificate) as Data)
    } catch {
      throw FolioMtlsNativeFailure(code: "IMPORT", message: "The certificate validity period is unreadable.")
    }
    return [
      "identityId": identityId,
      "subject": fields.subject ?? summary ?? "Unknown subject",
      "issuer": fields.issuer ?? "Unknown issuer",
      "notBefore": iso8601(fields.notBefore),
      "expiresAt": iso8601(fields.notAfter),
      "fingerprintSha256": fingerprintSha256(certificate),
      "hasPrivateKey": true,
      "source": "managed-native-identity"
    ]
  }

  private func secIdentity(_ value: Any?) -> SecIdentity? {
    guard let value else { return nil }
    let reference = value as CFTypeRef
    guard CFGetTypeID(reference) == SecIdentityGetTypeID() else { return nil }
    // Security returns opaque CFTypeRef values. Swift 6 rejects a conditional
    // Core Foundation downcast, so narrow only after checking the runtime type.
    return unsafeDowncast(reference, to: SecIdentity.self)
  }

  private func secTrust(_ value: Any?) -> SecTrust? {
    guard let value else { return nil }
    let reference = value as CFTypeRef
    guard CFGetTypeID(reference) == SecTrustGetTypeID() else { return nil }
    return unsafeDowncast(reference, to: SecTrust.self)
  }

  private func secCertificate(_ value: Any?) -> SecCertificate? {
    guard let value else { return nil }
    let reference = value as CFTypeRef
    guard CFGetTypeID(reference) == SecCertificateGetTypeID() else { return nil }
    return unsafeDowncast(reference, to: SecCertificate.self)
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
