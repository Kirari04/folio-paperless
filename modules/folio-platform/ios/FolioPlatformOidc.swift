import Foundation
import Security

private enum FolioOidcCryptoError: LocalizedError {
  case invalidInput
  case invalidKey
  case unsupported

  var errorDescription: String? {
    switch self {
    case .invalidInput:
      return "The RS256 verification input is invalid."
    case .invalidKey:
      return "The RS256 public key is invalid."
    case .unsupported:
      return "RS256 verification is unavailable."
    }
  }
}

func folioVerifyOidcRs256(
  signingInput: String,
  signatureBase64Url: String,
  modulusBase64Url: String,
  exponentBase64Url: String
) throws -> Bool {
  let parts = signingInput.split(separator: ".", omittingEmptySubsequences: false)
  guard
    signingInput.count >= 3,
    signingInput.count <= 65_536,
    parts.count == 2,
    isBase64Url(String(parts[0])),
    isBase64Url(String(parts[1])),
    let message = signingInput.data(using: .ascii)
  else {
    throw FolioOidcCryptoError.invalidInput
  }

  let signature = try decodeBase64Url(signatureBase64Url, maximumCharacters: 16_384)
  let modulus = try decodeBase64Url(modulusBase64Url, maximumCharacters: 16_384)
  let exponent = try decodeBase64Url(exponentBase64Url, maximumCharacters: 16)
  guard
    modulus.count >= 256,
    modulus.count <= 1_024,
    modulus.first != 0,
    modulus[modulus.startIndex] & 0x80 != 0,
    signature.count == modulus.count,
    exponent.count >= 1,
    exponent.count <= 8,
    exponent.first != 0,
    let exponentValue = uint64(exponent),
    exponentValue >= 3,
    exponentValue <= UInt64(Int64.max),
    exponentValue % 2 == 1
  else {
    throw FolioOidcCryptoError.invalidKey
  }

  let keyData = derSequence(derInteger(modulus), derInteger(exponent))
  let attributes: [String: Any] = [
    kSecAttrKeyType as String: kSecAttrKeyTypeRSA,
    kSecAttrKeyClass as String: kSecAttrKeyClassPublic,
    kSecAttrKeySizeInBits as String: modulus.count * 8
  ]
  var keyError: Unmanaged<CFError>?
  guard let key = SecKeyCreateWithData(keyData as CFData, attributes as CFDictionary, &keyError) else {
    if let keyError { _ = keyError.takeRetainedValue() }
    throw FolioOidcCryptoError.invalidKey
  }
  let algorithm: SecKeyAlgorithm = .rsaSignatureMessagePKCS1v15SHA256
  guard SecKeyIsAlgorithmSupported(key, .verify, algorithm) else {
    throw FolioOidcCryptoError.unsupported
  }
  var verificationError: Unmanaged<CFError>?
  let verified = SecKeyVerifySignature(
    key,
    algorithm,
    message as CFData,
    signature as CFData,
    &verificationError
  )
  if let verificationError { _ = verificationError.takeRetainedValue() }
  return verified
}

private func isBase64Url(_ value: String) -> Bool {
  guard !value.isEmpty, value.count % 4 != 1 else { return false }
  return value.range(of: "^[A-Za-z0-9_-]+$", options: .regularExpression) != nil
}

private func decodeBase64Url(_ value: String, maximumCharacters: Int) throws -> Data {
  guard value.count <= maximumCharacters, isBase64Url(value) else {
    throw FolioOidcCryptoError.invalidInput
  }
  let normalized = value.replacingOccurrences(of: "-", with: "+")
    .replacingOccurrences(of: "_", with: "/")
  let padding = String(repeating: "=", count: (4 - normalized.count % 4) % 4)
  guard let decoded = Data(base64Encoded: normalized + padding) else {
    throw FolioOidcCryptoError.invalidInput
  }
  return decoded
}

private func uint64(_ data: Data) -> UInt64? {
  var value: UInt64 = 0
  for byte in data {
    guard value <= (UInt64.max >> 8) else { return nil }
    value = (value << 8) | UInt64(byte)
  }
  return value
}

private func derInteger(_ bytes: Data) -> Data {
  var value = bytes
  if let first = value.first, first & 0x80 != 0 {
    value.insert(0, at: value.startIndex)
  }
  var encoded = Data([0x02])
  encoded.append(derLength(value.count))
  encoded.append(value)
  return encoded
}

private func derSequence(_ values: Data...) -> Data {
  let value = values.reduce(into: Data()) { $0.append($1) }
  var encoded = Data([0x30])
  encoded.append(derLength(value.count))
  encoded.append(value)
  return encoded
}

private func derLength(_ value: Int) -> Data {
  if value < 128 { return Data([UInt8(value)]) }
  var remaining = value
  var bytes: [UInt8] = []
  while remaining > 0 {
    bytes.insert(UInt8(remaining & 0xff), at: 0)
    remaining >>= 8
  }
  return Data([0x80 | UInt8(bytes.count)] + bytes)
}
