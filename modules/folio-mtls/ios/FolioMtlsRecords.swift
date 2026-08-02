import ExpoModulesCore

struct FolioMtlsRequestRecord: Record {
  @Field var requestId: String = ""
  @Field var clientIdentityRef: String = ""
  @Field var serverUrl: String = ""
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String?
}

struct FolioMtlsDownloadRecord: Record {
  @Field var requestId: String = ""
  @Field var clientIdentityRef: String = ""
  @Field var serverUrl: String = ""
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var destinationUri: String = ""
  @Field var maxBytes: Double = 512 * 1024 * 1024
}

struct FolioMtlsParameterRecord: Record {
  @Field var name: String = ""
  @Field var value: String = ""
}

struct FolioMtlsMultipartRecord: Record {
  @Field var requestId: String = ""
  @Field var clientIdentityRef: String = ""
  @Field var serverUrl: String = ""
  @Field var url: String = ""
  @Field var method: String = "POST"
  @Field var headers: [String: String] = [:]
  @Field var fileUri: String = ""
  @Field var fieldName: String = "document"
  @Field var fileName: String = "document"
  @Field var mimeType: String = "application/octet-stream"
  @Field var parameters: [FolioMtlsParameterRecord] = []
}

struct FolioMtlsNativeFailure: Error {
  let code: String
  let message: String
}
