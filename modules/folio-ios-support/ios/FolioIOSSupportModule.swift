import ExpoModulesCore
import UIKit

public final class FolioIOSSupportModule: Module {
  private static let maximumPageCount = 24
  private static let a4PageBounds = CGRect(x: 0, y: 0, width: 595, height: 842)

  public func definition() -> ModuleDefinition {
    Name("FolioIOSSupport")

    AsyncFunction("createPdfAsync") { (pageUris: [String]) throws -> String in
      guard pageUris.count >= 2 else {
        throw Self.error("At least two scanned pages are required to assemble a PDF.")
      }
      guard pageUris.count <= Self.maximumPageCount else {
        throw Self.error("A scan can contain at most \(Self.maximumPageCount) pages.")
      }

      let pageUrls = try pageUris.map { value -> URL in
        guard let url = URL(string: value), url.isFileURL else {
          throw Self.error("A scanned page does not have a readable local file URL.")
        }
        guard FileManager.default.fileExists(atPath: url.path) else {
          throw Self.error("A scanned page is no longer available on this device.")
        }
        return url
      }

      let outputUrl = FileManager.default.temporaryDirectory
        .appendingPathComponent("folio-scan-\(UUID().uuidString)")
        .appendingPathExtension("pdf")
      let renderer = UIGraphicsPDFRenderer(bounds: Self.a4PageBounds)
      var renderingError: Error?

      do {
        try renderer.writePDF(to: outputUrl) { context in
          for pageUrl in pageUrls {
            if renderingError != nil { break }
            context.beginPage()

            autoreleasepool {
              guard let image = UIImage(contentsOfFile: pageUrl.path), image.size.width > 0,
                    image.size.height > 0 else {
                renderingError = Self.error("A scanned page could not be decoded for PDF export.")
                return
              }

              let scale = min(
                Self.a4PageBounds.width / image.size.width,
                Self.a4PageBounds.height / image.size.height
              )
              let targetSize = CGSize(
                width: image.size.width * scale,
                height: image.size.height * scale
              )
              let targetRect = CGRect(
                x: (Self.a4PageBounds.width - targetSize.width) / 2,
                y: (Self.a4PageBounds.height - targetSize.height) / 2,
                width: targetSize.width,
                height: targetSize.height
              )
              image.draw(in: targetRect)
            }
          }
        }
      } catch {
        try? FileManager.default.removeItem(at: outputUrl)
        throw Self.error("iOS could not create a PDF from these scanned pages: \(error.localizedDescription)")
      }

      if let renderingError {
        try? FileManager.default.removeItem(at: outputUrl)
        throw renderingError
      }

      return outputUrl.absoluteString
    }
  }

  private static func error(_ message: String) -> NSError {
    NSError(
      domain: "app.folio.paperless.ios-support",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }
}
