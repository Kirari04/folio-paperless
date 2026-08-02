import Foundation

enum FolioMtlsCertificateSignatureAlgorithm {
  case rsaPkcs1Sha1
  case rsaPkcs1Sha224
  case rsaPkcs1Sha256
  case rsaPkcs1Sha384
  case rsaPkcs1Sha512
  case rsaPssSha1
  case rsaPssSha224
  case rsaPssSha256
  case rsaPssSha384
  case rsaPssSha512
  case ecdsaSha1
  case ecdsaSha224
  case ecdsaSha256
  case ecdsaSha384
  case ecdsaSha512
}

struct FolioMtlsCertificateFields {
  let subject: String?
  let issuer: String?
  let notBefore: Date
  let notAfter: Date
  let signedData: Data
  let signature: Data
  let signatureAlgorithm: FolioMtlsCertificateSignatureAlgorithm?
}

enum FolioMtlsCertificateParser {
  private enum ParserError: Error {
    case malformedCertificate
  }

  private struct Element {
    let tag: UInt8
    let contents: Data
    let encoded: Data
  }

  private struct Reader {
    let data: Data
    private(set) var offset = 0

    var isAtEnd: Bool { offset == data.count }
    var nextTag: UInt8? { isAtEnd ? nil : data[offset] }

    mutating func read(expectedTag: UInt8? = nil) throws -> Element {
      let start = offset
      guard offset < data.count else { throw ParserError.malformedCertificate }
      let tag = data[offset]
      offset += 1

      // All certificate fields Folio consumes use low-tag-number identifiers,
      // but skip a valid high-tag-number identifier before reading its length so
      // an unfamiliar directory value cannot desynchronize the reader.
      if tag & 0x1f == 0x1f {
        var identifierBytes = 0
        while true {
          guard offset < data.count, identifierBytes < 8 else {
            throw ParserError.malformedCertificate
          }
          let byte = data[offset]
          offset += 1
          identifierBytes += 1
          if byte & 0x80 == 0 { break }
        }
      }

      guard offset < data.count else { throw ParserError.malformedCertificate }
      let firstLengthByte = data[offset]
      offset += 1
      let length: Int
      if firstLengthByte & 0x80 == 0 {
        length = Int(firstLengthByte)
      } else {
        let byteCount = Int(firstLengthByte & 0x7f)
        guard byteCount > 0, byteCount <= MemoryLayout<Int>.size,
          byteCount <= data.count - offset
        else {
          throw ParserError.malformedCertificate
        }
        var accumulated = 0
        for _ in 0..<byteCount {
          let byte = Int(data[offset])
          offset += 1
          guard accumulated <= (Int.max - byte) / 256 else {
            throw ParserError.malformedCertificate
          }
          accumulated = accumulated * 256 + byte
        }
        length = accumulated
      }

      guard length <= data.count - offset else { throw ParserError.malformedCertificate }
      let end = offset + length
      let element = Element(
        tag: tag,
        contents: data.subdata(in: offset..<end),
        encoded: data.subdata(in: start..<end)
      )
      offset = end
      if let expectedTag, tag != expectedTag {
        throw ParserError.malformedCertificate
      }
      return element
    }
  }

  static func parse(_ certificateData: Data) throws -> FolioMtlsCertificateFields {
    var document = Reader(data: certificateData)
    let certificate = try document.read(expectedTag: 0x30)
    guard document.isAtEnd else { throw ParserError.malformedCertificate }

    var certificateReader = Reader(data: certificate.contents)
    let toBeSigned = try certificateReader.read(expectedTag: 0x30)
    let signatureAlgorithm = try certificateReader.read(expectedTag: 0x30)
    let signatureValue = try certificateReader.read(expectedTag: 0x03)
    guard certificateReader.isAtEnd else { throw ParserError.malformedCertificate }
    guard signatureValue.contents.count > 1, signatureValue.contents.first == 0 else {
      throw ParserError.malformedCertificate
    }

    var fields = Reader(data: toBeSigned.contents)
    if fields.nextTag == 0xa0 {
      _ = try fields.read(expectedTag: 0xa0) // explicit certificate version
    }
    _ = try fields.read(expectedTag: 0x02) // serial number
    _ = try fields.read(expectedTag: 0x30) // signature algorithm
    let issuer = try fields.read(expectedTag: 0x30)
    let validity = try fields.read(expectedTag: 0x30)
    let subject = try fields.read(expectedTag: 0x30)

    var validityReader = Reader(data: validity.contents)
    let notBefore = try parseTime(validityReader.read())
    let notAfter = try parseTime(validityReader.read())
    guard validityReader.isAtEnd, notBefore < notAfter else {
      throw ParserError.malformedCertificate
    }

    return FolioMtlsCertificateFields(
      subject: try? parseName(subject),
      issuer: try? parseName(issuer),
      notBefore: notBefore,
      notAfter: notAfter,
      signedData: toBeSigned.encoded,
      signature: Data(signatureValue.contents.dropFirst()),
      signatureAlgorithm: try? parseSignatureAlgorithm(signatureAlgorithm)
    )
  }

  private static func parseSignatureAlgorithm(
    _ element: Element
  ) throws -> FolioMtlsCertificateSignatureAlgorithm? {
    let identifier = try parseAlgorithmIdentifier(element)
    switch identifier.oid {
    case "1.2.840.113549.1.1.5": return .rsaPkcs1Sha1
    case "1.2.840.113549.1.1.14": return .rsaPkcs1Sha224
    case "1.2.840.113549.1.1.11": return .rsaPkcs1Sha256
    case "1.2.840.113549.1.1.12": return .rsaPkcs1Sha384
    case "1.2.840.113549.1.1.13": return .rsaPkcs1Sha512
    case "1.2.840.113549.1.1.10": return try parseRsaPss(identifier.parameters)
    case "1.2.840.10045.4.1": return .ecdsaSha1
    case "1.2.840.10045.4.3.1": return .ecdsaSha224
    case "1.2.840.10045.4.3.2": return .ecdsaSha256
    case "1.2.840.10045.4.3.3": return .ecdsaSha384
    case "1.2.840.10045.4.3.4": return .ecdsaSha512
    default: return nil
    }
  }

  private static func parseAlgorithmIdentifier(
    _ element: Element
  ) throws -> (oid: String, parameters: Element?) {
    guard element.tag == 0x30 else { throw ParserError.malformedCertificate }
    var reader = Reader(data: element.contents)
    let oid = try oidString(reader.read(expectedTag: 0x06).contents)
    let parameters = reader.isAtEnd ? nil : try reader.read()
    guard reader.isAtEnd else { throw ParserError.malformedCertificate }
    return (oid, parameters)
  }

  private static func parseRsaPss(
    _ parameters: Element?
  ) throws -> FolioMtlsCertificateSignatureAlgorithm? {
    guard let parameters, parameters.tag == 0x30 else {
      throw ParserError.malformedCertificate
    }

    // RFC 4055 defaults are SHA-1, MGF1-SHA-1, a 20-byte salt, and trailer 1.
    var hashOid = "1.3.14.3.2.26"
    var maskHashOid = "1.3.14.3.2.26"
    var saltLength = 20
    var trailerField = 1
    var seen = Set<UInt8>()
    var reader = Reader(data: parameters.contents)
    while !reader.isAtEnd {
      let field = try reader.read()
      guard (0xa0...0xa3).contains(field.tag), seen.insert(field.tag).inserted else {
        throw ParserError.malformedCertificate
      }
      var explicit = Reader(data: field.contents)
      switch field.tag {
      case 0xa0:
        let hash = try parseAlgorithmIdentifier(explicit.read(expectedTag: 0x30))
        hashOid = hash.oid
      case 0xa1:
        let mask = try parseAlgorithmIdentifier(explicit.read(expectedTag: 0x30))
        guard mask.oid == "1.2.840.113549.1.1.8", let maskParameters = mask.parameters else {
          return nil
        }
        maskHashOid = try parseAlgorithmIdentifier(maskParameters).oid
      case 0xa2:
        saltLength = try positiveInteger(explicit.read(expectedTag: 0x02).contents)
      case 0xa3:
        trailerField = try positiveInteger(explicit.read(expectedTag: 0x02).contents)
      default:
        throw ParserError.malformedCertificate
      }
      guard explicit.isAtEnd else { throw ParserError.malformedCertificate }
    }

    guard hashOid == maskHashOid, trailerField == 1 else { return nil }
    switch (hashOid, saltLength) {
    case ("1.3.14.3.2.26", 20): return .rsaPssSha1
    case ("2.16.840.1.101.3.4.2.4", 28): return .rsaPssSha224
    case ("2.16.840.1.101.3.4.2.1", 32): return .rsaPssSha256
    case ("2.16.840.1.101.3.4.2.2", 48): return .rsaPssSha384
    case ("2.16.840.1.101.3.4.2.3", 64): return .rsaPssSha512
    default: return nil
    }
  }

  private static func positiveInteger(_ data: Data) throws -> Int {
    let bytes = [UInt8](data)
    guard !bytes.isEmpty, bytes[0] & 0x80 == 0 else {
      throw ParserError.malformedCertificate
    }
    var value = 0
    for byte in bytes {
      guard value <= (Int.max - Int(byte)) / 256 else {
        throw ParserError.malformedCertificate
      }
      value = value * 256 + Int(byte)
    }
    return value
  }

  private static func parseTime(_ element: Element) throws -> Date {
    let bytes = [UInt8](element.contents)
    guard bytes.last == 0x5a else { throw ParserError.malformedCertificate } // Z

    let year: Int
    let componentOffset: Int
    var nanosecond = 0
    switch element.tag {
    case 0x17: // UTCTime, which RFC 5280 requires through the year 2049.
      guard bytes.count == 13 else { throw ParserError.malformedCertificate }
      let shortYear = try decimal(bytes, offset: 0, count: 2)
      year = shortYear >= 50 ? 1900 + shortYear : 2000 + shortYear
      componentOffset = 2
    case 0x18: // GeneralizedTime, required by RFC 5280 from the year 2050.
      guard bytes.count >= 15 else { throw ParserError.malformedCertificate }
      year = try decimal(bytes, offset: 0, count: 4)
      componentOffset = 4
      if bytes.count > 15 {
        guard (bytes[14] == 0x2e || bytes[14] == 0x2c), bytes.count > 16 else {
          throw ParserError.malformedCertificate
        }
        let fraction = Array(bytes[15..<(bytes.count - 1)])
        guard !fraction.isEmpty, fraction.allSatisfy({ (0x30...0x39).contains($0) }) else {
          throw ParserError.malformedCertificate
        }
        let firstNine = Array(fraction.prefix(9))
        let digits = try decimal(firstNine, offset: 0, count: firstNine.count)
        nanosecond = digits
        for _ in firstNine.count..<9 { nanosecond *= 10 }
      }
    default:
      throw ParserError.malformedCertificate
    }

    let month = try decimal(bytes, offset: componentOffset, count: 2)
    let day = try decimal(bytes, offset: componentOffset + 2, count: 2)
    let hour = try decimal(bytes, offset: componentOffset + 4, count: 2)
    let minute = try decimal(bytes, offset: componentOffset + 6, count: 2)
    let second = try decimal(bytes, offset: componentOffset + 8, count: 2)
    guard (1...12).contains(month), (1...31).contains(day), (0...23).contains(hour),
      (0...59).contains(minute), (0...59).contains(second)
    else {
      throw ParserError.malformedCertificate
    }

    var calendar = Calendar(identifier: .gregorian)
    guard let utc = TimeZone(secondsFromGMT: 0) else { throw ParserError.malformedCertificate }
    calendar.timeZone = utc
    let components = DateComponents(
      calendar: calendar,
      timeZone: utc,
      year: year,
      month: month,
      day: day,
      hour: hour,
      minute: minute,
      second: second,
      nanosecond: nanosecond
    )
    guard let date = calendar.date(from: components) else {
      throw ParserError.malformedCertificate
    }
    let verified = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    guard verified.year == year, verified.month == month, verified.day == day,
      verified.hour == hour, verified.minute == minute, verified.second == second
    else {
      throw ParserError.malformedCertificate
    }
    return date
  }

  private static func decimal(_ bytes: [UInt8], offset: Int, count: Int) throws -> Int {
    guard count > 0, offset >= 0, offset <= bytes.count,
      count <= bytes.count - offset
    else {
      throw ParserError.malformedCertificate
    }
    var value = 0
    for byte in bytes[offset..<(offset + count)] {
      guard (0x30...0x39).contains(byte) else { throw ParserError.malformedCertificate }
      value = value * 10 + Int(byte - 0x30)
    }
    return value
  }

  private static func parseName(_ name: Element) throws -> String? {
    guard name.tag == 0x30 else { throw ParserError.malformedCertificate }
    var nameReader = Reader(data: name.contents)
    var relativeNames: [String] = []
    while !nameReader.isAtEnd {
      let set = try nameReader.read(expectedTag: 0x31)
      var setReader = Reader(data: set.contents)
      var attributes: [String] = []
      while !setReader.isAtEnd {
        let attribute = try setReader.read(expectedTag: 0x30)
        var attributeReader = Reader(data: attribute.contents)
        let oid = try attributeReader.read(expectedTag: 0x06)
        let value = try attributeReader.read()
        guard attributeReader.isAtEnd else { throw ParserError.malformedCertificate }
        let identifier = try oidString(oid.contents)
        let label = oidLabels[identifier] ?? identifier
        attributes.append("\(label)=\(directoryValue(value))")
      }
      if !attributes.isEmpty { relativeNames.append(attributes.joined(separator: "+")) }
    }
    return relativeNames.isEmpty ? nil : relativeNames.joined(separator: ", ")
  }

  private static func oidString(_ data: Data) throws -> String {
    let bytes = [UInt8](data)
    guard !bytes.isEmpty else { throw ParserError.malformedCertificate }
    var values: [UInt64] = []
    var value: UInt64 = 0
    var hasTerminator = true
    for byte in bytes {
      hasTerminator = byte & 0x80 == 0
      guard value <= (UInt64.max - UInt64(byte & 0x7f)) / 128 else {
        throw ParserError.malformedCertificate
      }
      value = value * 128 + UInt64(byte & 0x7f)
      if hasTerminator {
        values.append(value)
        value = 0
      }
    }
    guard hasTerminator, let first = values.first else {
      throw ParserError.malformedCertificate
    }
    let firstArc: UInt64 = first < 40 ? 0 : (first < 80 ? 1 : 2)
    let secondArc = first - firstArc * 40
    var components = [firstArc, secondArc]
    components.append(contentsOf: values.dropFirst())
    return components.map { String($0) }.joined(separator: ".")
  }

  private static func directoryValue(_ element: Element) -> String {
    let encoding: String.Encoding?
    switch element.tag {
    case 0x0c: encoding = .utf8
    case 0x12, 0x13, 0x16, 0x1a: encoding = .ascii
    case 0x14: encoding = .isoLatin1
    case 0x1c: encoding = .utf32BigEndian
    case 0x1e: encoding = .utf16BigEndian
    default: encoding = nil
    }
    guard let encoding, let value = String(data: element.contents, encoding: encoding) else {
      return "#" + element.encoded.map { String(format: "%02X", $0) }.joined()
    }
    return escapeDistinguishedNameValue(value)
  }

  private static func escapeDistinguishedNameValue(_ value: String) -> String {
    let scalars = Array(value.unicodeScalars)
    var result = ""
    for (index, scalar) in scalars.enumerated() {
      let isEdgeSpace = scalar.value == 0x20 && (index == 0 || index == scalars.count - 1)
      let isLeadingHash = scalar.value == 0x23 && index == 0
      let isSpecial = [0x22, 0x2b, 0x2c, 0x3b, 0x3c, 0x3d, 0x3e, 0x5c].contains(scalar.value)
      if scalar.value < 0x20 || scalar.value == 0x7f {
        result += String(format: "\\%02X", scalar.value)
      } else {
        if isEdgeSpace || isLeadingHash || isSpecial { result += "\\" }
        result.append(Character(String(scalar)))
      }
    }
    return result
  }

  private static let oidLabels: [String: String] = [
    "1.2.840.113549.1.9.1": "emailAddress",
    "2.5.4.3": "CN",
    "2.5.4.4": "SN",
    "2.5.4.5": "serialNumber",
    "2.5.4.6": "C",
    "2.5.4.7": "L",
    "2.5.4.8": "ST",
    "2.5.4.9": "STREET",
    "2.5.4.10": "O",
    "2.5.4.11": "OU",
    "2.5.4.12": "T",
    "2.5.4.42": "GN",
    "2.5.4.46": "dnQualifier",
    "2.5.4.65": "pseudonym"
  ]
}
