import Foundation
import Security

private let folioMtlsMethods = Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])
private let folioMtlsMaxResponseBytes = 64 * 1024 * 1024
private let folioMtlsMaxDownloadBytes: Int64 = 512 * 1024 * 1024

struct FolioMtlsTransferResponse {
  let status: Int
  let headers: [String: String]
  let responseUrl: String
  let body: String

  var dictionary: [String: Any] {
    ["status": status, "headers": headers, "responseUrl": responseUrl, "body": body]
  }
}

final class FolioMtlsTransfer: NSObject, URLSessionDataDelegate, URLSessionDownloadDelegate {
  enum Mode {
    case data(Data?)
    case download(URL, Int64)
    case upload(URL)
  }

  private let requestId: String
  private let identity: SecIdentity
  private let chain: [SecCertificate]
  private let mode: Mode
  private let progress: (Int64, Int64?) -> Void
  private let semaphore = DispatchSemaphore(value: 0)
  private let lock = NSLock()
  private var received = Data()
  private var downloadedLocation: URL?
  private var taskError: Error?
  private var response: HTTPURLResponse?
  private var signaled = false
  private(set) var task: URLSessionTask?
  private var session: URLSession?
  private var expectedProtectionSpace: (host: String, port: Int)?

  init(
    requestId: String,
    identity: SecIdentity,
    chain: [SecCertificate],
    mode: Mode,
    progress: @escaping (Int64, Int64?) -> Void
  ) {
    self.requestId = requestId
    self.identity = identity
    self.chain = chain
    self.mode = mode
    self.progress = progress
  }

  func execute(_ request: URLRequest) throws -> FolioMtlsTransferResponse {
    guard let requestUrl = request.url, let host = requestUrl.host else {
      throw FolioMtlsNativeFailure(code: "ORIGIN", message: "The request origin is unavailable.")
    }
    expectedProtectionSpace = (
      host: host.lowercased(),
      port: requestUrl.port ?? 443
    )
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCredentialStorage = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.timeoutIntervalForRequest = 20
    configuration.timeoutIntervalForResource = 5 * 60
    configuration.tlsMinimumSupportedProtocolVersion = .TLSv12
    let session = URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    self.session = session
    switch mode {
    case .data(let body):
      var request = request
      request.httpBody = body
      task = session.dataTask(with: request)
    case .download:
      task = session.downloadTask(with: request)
    case .upload(let file):
      task = session.uploadTask(with: request, fromFile: file)
    }
    task?.resume()
    semaphore.wait()
    session.finishTasksAndInvalidate()
    if let taskError {
      if let failure = taskError as? FolioMtlsNativeFailure {
        throw failure
      }
      if (taskError as NSError).code == NSURLErrorCancelled {
        throw FolioMtlsNativeFailure(code: "CANCELED", message: "The request was canceled.")
      }
      if (taskError as NSError).domain == NSURLErrorDomain {
        throw FolioMtlsNativeFailure(code: "REQUEST", message: "The certificate-aware request failed.")
      }
      throw taskError
    }
    guard let response else {
      throw FolioMtlsNativeFailure(code: "REQUEST", message: "The server returned no HTTP response.")
    }
    let headers = response.allHeaderFields.reduce(into: [String: String]()) { result, entry in
      result[String(describing: entry.key)] = String(describing: entry.value)
    }
    var body = ""
    switch mode {
    case .download(let destination, let maximum):
      guard let downloadedLocation else {
        throw FolioMtlsNativeFailure(code: "REQUEST", message: "The download returned no file.")
      }
      let downloadedSize = try downloadedLocation.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
      guard downloadedSize >= 0, Int64(downloadedSize) <= maximum else {
        throw FolioMtlsNativeFailure(
          code: "REQUEST",
          message: "The download exceeds Folio's per-file safety limit."
        )
      }
      if (200...299).contains(response.statusCode) {
        try commitDownload(downloadedLocation, to: destination)
      } else {
        let fileSize = try downloadedLocation.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard fileSize <= folioMtlsMaxResponseBytes else {
          throw FolioMtlsNativeFailure(code: "REQUEST", message: "The error response is too large.")
        }
        let data = try Data(contentsOf: downloadedLocation, options: [.mappedIfSafe])
        body = String(data: data, encoding: .utf8) ?? ""
      }
    case .data, .upload:
      body = String(data: received, encoding: .utf8) ?? ""
    }
    return FolioMtlsTransferResponse(
      status: response.statusCode,
      headers: headers,
      responseUrl: response.url?.absoluteString ?? request.url?.absoluteString ?? "",
      body: body
    )
  }

  func cancel() {
    task?.cancel()
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodClientCertificate {
      let challengePort = challenge.protectionSpace.port > 0
        ? challenge.protectionSpace.port
        : 443
      guard
        let expectedProtectionSpace,
        challenge.previousFailureCount == 0,
        challenge.protectionSpace.isProxy() == false,
        challenge.protectionSpace.protocol?.lowercased() == "https",
        challenge.protectionSpace.host.lowercased() == expectedProtectionSpace.host,
        challengePort == expectedProtectionSpace.port
      else {
        completionHandler(.cancelAuthenticationChallenge, nil)
        return
      }
      let credential = URLCredential(
        identity: identity,
        certificates: chain.isEmpty ? nil : chain,
        persistence: .forSession
      )
      completionHandler(.useCredential, credential)
      return
    }
    // Server trust and every non-client-certificate challenge remain under the
    // system URL loading stack. Folio never accepts, pins, or bypasses trust here.
    completionHandler(.performDefaultHandling, nil)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping (URLRequest?) -> Void
  ) {
    self.response = response
    completionHandler(nil)
  }

  func urlSession(
    _ session: URLSession,
    dataTask: URLSessionDataTask,
    didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    guard let http = response as? HTTPURLResponse else {
      lock.lock()
      if taskError == nil {
        taskError = FolioMtlsNativeFailure(code: "REQUEST", message: "The server returned an invalid response.")
      }
      lock.unlock()
      completionHandler(.cancel)
      return
    }
    self.response = http
    let maximum = responseBodyLimit(for: http)
    if response.expectedContentLength > maximum {
      lock.lock()
      if taskError == nil {
        taskError = FolioMtlsNativeFailure(
          code: "RESPONSE_TOO_LARGE",
          message: "The response exceeds Folio's in-memory safety limit."
        )
      }
      lock.unlock()
      completionHandler(.cancel)
      return
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    lock.lock()
    defer { lock.unlock() }
    if data.count > folioMtlsMaxResponseBytes - received.count {
      taskError = FolioMtlsNativeFailure(
        code: "RESPONSE_TOO_LARGE",
        message: "The response exceeds Folio's in-memory safety limit."
      )
      dataTask.cancel()
      return
    }
    received.append(data)
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didFinishDownloadingTo location: URL
  ) {
    response = downloadTask.response as? HTTPURLResponse
    let retained = FileManager.default.temporaryDirectory
      .appendingPathComponent("folio-mtls-download-\(UUID().uuidString)")
    do {
      try FileManager.default.moveItem(at: location, to: retained)
      downloadedLocation = retained
    } catch {
      taskError = error
    }
  }

  func urlSession(
    _ session: URLSession,
    downloadTask: URLSessionDownloadTask,
    didWriteData bytesWritten: Int64,
    totalBytesWritten: Int64,
    totalBytesExpectedToWrite: Int64
  ) {
    // URLSession may start delivering file bytes before didFinishDownloadingTo
    // publishes `response`. Read it directly from the task so the caller's
    // representation-specific ceiling applies during transfer, not just after it.
    let currentResponse = (downloadTask.response as? HTTPURLResponse) ?? response
    if let currentResponse { response = currentResponse }
    let maximum = currentResponse.map { responseBodyLimit(for: $0) } ?? {
      if case .download(_, let requestedMaximum) = mode { return requestedMaximum }
      return folioMtlsMaxDownloadBytes
    }()
    if
      totalBytesWritten > maximum
      || (totalBytesExpectedToWrite > 0 && totalBytesExpectedToWrite > maximum)
    {
      lock.lock()
      if taskError == nil {
        let responseBody = maximum == Int64(folioMtlsMaxResponseBytes)
        taskError = FolioMtlsNativeFailure(
          code: responseBody ? "RESPONSE_TOO_LARGE" : "REQUEST",
          message: responseBody
            ? "The response exceeds Folio's in-memory safety limit."
            : "The download exceeds Folio's per-file safety limit."
        )
      }
      lock.unlock()
      downloadTask.cancel()
      return
    }
    progress(totalBytesWritten, totalBytesExpectedToWrite > 0 ? totalBytesExpectedToWrite : nil)
  }

  func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    didSendBodyData bytesSent: Int64,
    totalBytesSent: Int64,
    totalBytesExpectedToSend: Int64
  ) {
    progress(totalBytesSent, totalBytesExpectedToSend > 0 ? totalBytesExpectedToSend : nil)
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    lock.lock()
    if response == nil { response = task.response as? HTTPURLResponse }
    if let error, taskError == nil { taskError = error }
    let shouldSignal = !signaled
    signaled = true
    lock.unlock()
    if shouldSignal { semaphore.signal() }
  }

  private func commitDownload(_ source: URL, to destination: URL) throws {
    let manager = FileManager.default
    try manager.createDirectory(
      at: destination.deletingLastPathComponent(),
      withIntermediateDirectories: true
    )
    if manager.fileExists(atPath: destination.path) {
      try manager.removeItem(at: destination)
    }
    try manager.moveItem(at: source, to: destination)
    downloadedLocation = nil
  }

  private func responseBodyLimit(for response: HTTPURLResponse) -> Int64 {
    if case .download(_, let maximum) = mode, (200...299).contains(response.statusCode) {
      return maximum
    }
    return Int64(folioMtlsMaxResponseBytes)
  }

  deinit {
    if let downloadedLocation { try? FileManager.default.removeItem(at: downloadedLocation) }
    session?.invalidateAndCancel()
  }
}

enum FolioMtlsRequestValidator {
  static func request(
    serverUrl: String,
    requestUrl: String,
    method: String,
    headers: [String: String]
  ) throws -> URLRequest {
    guard
      let base = URLComponents(string: serverUrl),
      let target = URLComponents(string: requestUrl),
      base.scheme?.lowercased() == "https",
      target.scheme?.lowercased() == "https",
      let baseHost = base.host?.lowercased(),
      let targetHost = target.host?.lowercased(),
      baseHost == targetHost,
      (base.port ?? 443) == (target.port ?? 443),
      base.user == nil,
      base.password == nil,
      target.user == nil,
      target.password == nil,
      target.fragment == nil,
      let url = target.url
    else {
      throw FolioMtlsNativeFailure(code: "ORIGIN", message: "The request origin is not allowed.")
    }
    let basePath = base.path.replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
    guard basePath.isEmpty || target.path == basePath || target.path.hasPrefix(basePath + "/") else {
      throw FolioMtlsNativeFailure(code: "ORIGIN", message: "The request path is outside the saved server subpath.")
    }
    let normalizedMethod = method.uppercased()
    guard folioMtlsMethods.contains(normalizedMethod) else {
      throw FolioMtlsNativeFailure(code: "INVALID", message: "The HTTP method is unsupported.")
    }
    guard headers.count <= 64 else {
      throw FolioMtlsNativeFailure(code: "INVALID", message: "Too many request headers were supplied.")
    }
    let token = try NSRegularExpression(pattern: "^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")
    var request = URLRequest(url: url)
    request.httpMethod = normalizedMethod
    request.httpShouldHandleCookies = false
    for (name, value) in headers {
      let range = NSRange(name.startIndex..<name.endIndex, in: name)
      guard
        token.firstMatch(in: name, range: range) != nil,
        value.utf8.count <= 16_384,
        !value.contains("\r"),
        !value.contains("\n")
      else {
        throw FolioMtlsNativeFailure(code: "INVALID", message: "A request header is invalid.")
      }
      request.setValue(value, forHTTPHeaderField: name)
    }
    return request
  }

  static func privateFile(_ value: String, forWriting: Bool) throws -> URL {
    guard let url = URL(string: value), url.isFileURL else {
      throw FolioMtlsNativeFailure(code: "INVALID", message: "Only app-private file URLs are supported.")
    }
    let candidate = url.standardizedFileURL
    let manager = FileManager.default
    let roots = [
      manager.urls(for: .documentDirectory, in: .userDomainMask).first,
      manager.urls(for: .cachesDirectory, in: .userDomainMask).first,
      manager.temporaryDirectory
    ].compactMap { $0?.standardizedFileURL }
    guard roots.contains(where: {
      candidate.path == $0.path || candidate.path.hasPrefix($0.path + "/")
    }) else {
      throw FolioMtlsNativeFailure(code: "INVALID", message: "The file URL is outside Folio's private storage.")
    }
    if forWriting {
      try manager.createDirectory(
        at: candidate.deletingLastPathComponent(),
        withIntermediateDirectories: true
      )
    }
    return candidate
  }
}

enum FolioMtlsMultipartBuilder {
  static func create(
    request: FolioMtlsMultipartRecord,
    source: URL,
    boundary: String
  ) throws -> URL {
    func safe(_ value: String) throws -> String {
      guard !value.contains("\r"), !value.contains("\n"), !value.contains("\"") else {
        throw FolioMtlsNativeFailure(code: "INVALID", message: "Multipart metadata is invalid.")
      }
      return value
    }
    guard request.parameters.count <= 100 else {
      throw FolioMtlsNativeFailure(code: "INVALID", message: "Too many multipart fields were supplied.")
    }
    let target = FileManager.default.temporaryDirectory
      .appendingPathComponent("folio-mtls-upload-\(UUID().uuidString)")
    FileManager.default.createFile(atPath: target.path, contents: nil)
    let output = try FileHandle(forWritingTo: target)
    do {
      for parameter in request.parameters {
        let text = "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(try safe(parameter.name))\"\r\n\r\n\(parameter.value)\r\n"
        try output.write(contentsOf: Data(text.utf8))
      }
      let fileHeader = "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(try safe(request.fieldName))\"; filename=\"\(try safe(request.fileName))\"\r\nContent-Type: \(try safe(request.mimeType))\r\n\r\n"
      try output.write(contentsOf: Data(fileHeader.utf8))
      let input = try FileHandle(forReadingFrom: source)
      defer { try? input.close() }
      while let chunk = try input.read(upToCount: 64 * 1024), !chunk.isEmpty {
        try output.write(contentsOf: chunk)
      }
      try output.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
      try output.close()
      return target
    } catch {
      try? output.close()
      try? FileManager.default.removeItem(at: target)
      throw error
    }
  }
}
