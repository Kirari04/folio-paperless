import ExpoModulesCore
import ImageIO
import UIKit

public final class FolioIOSSupportModule: Module {
  // 3508 px is the long edge of an A4 page at 300 dpi. It preserves print-quality
  // text while bounding the decoded bitmap for each scanned page to predictable memory.
  private static let maximumRasterDimension = 3_508
  private static let maximumPageDimension: CGFloat = 842
  private static let referencePageBounds = CGRect(x: 0, y: 0, width: 595, height: 842)

  public func definition() -> ModuleDefinition {
    Name("FolioIOSSupport")

    AsyncFunction("createPdfAsync") { (pageUris: [String]) throws -> String in
      guard !pageUris.isEmpty else {
        throw Self.error("At least one scanned page is required to assemble a PDF.")
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
      let format = UIGraphicsPDFRendererFormat()
      format.documentInfo = [kCGPDFContextCreator as String: "Folio for Paperless"]
      let renderer = UIGraphicsPDFRenderer(bounds: Self.referencePageBounds, format: format)
      var renderingError: Error?

      do {
        try renderer.writePDF(to: outputUrl) { context in
          for pageUrl in pageUrls {
            if renderingError != nil { break }

            autoreleasepool {
              guard let image = Self.loadPageImage(at: pageUrl) else {
                renderingError = Self.error("A scanned page could not be decoded for PDF export.")
                return
              }

              let pageBounds = Self.pageBounds(for: image.size)
              context.beginPage(withBounds: pageBounds, pageInfo: [:])
              context.cgContext.setFillColor(UIColor.white.cgColor)
              context.cgContext.fill(pageBounds)
              image.draw(in: pageBounds)
            }
          }
        }

        let values = try outputUrl.resourceValues(forKeys: [.fileSizeKey])
        guard let fileSize = values.fileSize, fileSize > 0 else {
          throw Self.error("iOS created an empty PDF for this scan.")
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

  private static func loadPageImage(at url: URL) -> UIImage? {
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithURL(url as CFURL, sourceOptions) else {
      return nil
    }

    let thumbnailOptions: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: maximumRasterDimension,
    ]
    guard let image = CGImageSourceCreateThumbnailAtIndex(
      source,
      0,
      thumbnailOptions as CFDictionary
    ) else {
      return nil
    }
    return UIImage(cgImage: image)
  }

  private static func pageBounds(for imageSize: CGSize) -> CGRect {
    guard imageSize.width > 0, imageSize.height > 0 else { return referencePageBounds }
    let scale = maximumPageDimension / max(imageSize.width, imageSize.height)
    return CGRect(
      origin: .zero,
      size: CGSize(width: imageSize.width * scale, height: imageSize.height * scale)
    )
  }

  private static func error(_ message: String) -> NSError {
    NSError(
      domain: "app.folio.paperless.ios-support",
      code: 1,
      userInfo: [NSLocalizedDescriptionKey: message]
    )
  }
}
