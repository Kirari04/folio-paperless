import CoreGraphics
import ExpoModulesCore
import UIKit

struct FolioPdfPagesFailure: Error {
  let code: String
  let message: String
}

/// Renders one JPEG thumbnail per PDF page with Core Graphics. Pages are
/// rasterized strictly one at a time inside their own autorelease pool, so a
/// long scan costs the memory of a single page rather than of the whole
/// document.
public final class FolioPdfPagesModule: Module {
  private static let minimumWidth = 32
  private static let maximumWidth = 2_048
  /// Caps the long edge so a pathological page aspect ratio cannot grow the
  /// single bitmap beyond `maxWidth * 2048 * 4` bytes.
  private static let maximumHeight: CGFloat = 2_048
  private static let maximumPages = 10_000
  private static let jpegQuality: CGFloat = 0.8

  public func definition() -> ModuleDefinition {
    Name("FolioPdfPages")

    AsyncFunction("renderPageThumbnails") {
      (pdfUri: String, outputDirectoryUri: String, maxWidth: Int, promise: Promise) in
      do {
        let rendered = try Self.renderThumbnails(
          pdfUri: pdfUri,
          outputDirectoryUri: outputDirectoryUri,
          maxWidth: maxWidth
        )
        promise.resolve(rendered)
      } catch {
        Self.reject(promise, error)
      }
    }
  }

  private static func renderThumbnails(
    pdfUri: String,
    outputDirectoryUri: String,
    maxWidth: Int
  ) throws -> [String: Any] {
    guard maxWidth >= minimumWidth, maxWidth <= maximumWidth else {
      throw FolioPdfPagesFailure(
        code: "WIDTH_UNSUPPORTED",
        message: "The requested thumbnail width is outside the supported range."
      )
    }

    let sourceUrl = try fileUrl(pdfUri)
    guard FileManager.default.fileExists(atPath: sourceUrl.path) else {
      throw FolioPdfPagesFailure(
        code: "SOURCE_UNAVAILABLE",
        message: "The PDF is no longer available on this device."
      )
    }

    let outputUrl = try fileUrl(outputDirectoryUri)
    do {
      try FileManager.default.createDirectory(at: outputUrl, withIntermediateDirectories: true)
    } catch {
      throw FolioPdfPagesFailure(
        code: "OUTPUT_UNAVAILABLE",
        message: "The page preview directory could not be created."
      )
    }

    guard let document = CGPDFDocument(sourceUrl as CFURL) else {
      throw FolioPdfPagesFailure(
        code: "PDF_MALFORMED",
        message: "This PDF could not be read for page previews."
      )
    }
    guard !document.isEncrypted || document.isUnlocked else {
      throw FolioPdfPagesFailure(
        code: "PDF_PASSWORD_PROTECTED",
        message: "This PDF is password protected, so its pages cannot be previewed."
      )
    }

    let pageCount = document.numberOfPages
    guard pageCount >= 1 else {
      throw FolioPdfPagesFailure(
        code: "PDF_MALFORMED",
        message: "This PDF has no renderable pages."
      )
    }
    guard pageCount <= maximumPages else {
      throw FolioPdfPagesFailure(
        code: "PDF_TOO_MANY_PAGES",
        message: "This PDF has more pages than the editor can preview."
      )
    }

    var pages: [[String: Any]] = []
    pages.reserveCapacity(pageCount)
    for number in 1...pageCount {
      let rendered = try autoreleasepool {
        try renderPage(
          document: document,
          number: number,
          outputDirectory: outputUrl,
          maxWidth: maxWidth
        )
      }
      pages.append(rendered)
    }
    return ["pageCount": pageCount, "pages": pages]
  }

  private static func renderPage(
    document: CGPDFDocument,
    number: Int,
    outputDirectory: URL,
    maxWidth: Int
  ) throws -> [String: Any] {
    guard let page = document.page(at: number) else {
      throw FolioPdfPagesFailure(
        code: "PDF_MALFORMED",
        message: "A page in this PDF could not be opened for preview."
      )
    }

    // A page without a crop box falls back to its media box; both are given in
    // the PDF coordinate space, before the page's own /Rotate is applied.
    let cropBox = page.getBoxRect(.cropBox)
    let boxType: CGPDFBox = cropBox.isEmpty ? .mediaBox : .cropBox
    let box = cropBox.isEmpty ? page.getBoxRect(.mediaBox) : cropBox
    guard box.width > 0, box.height > 0 else {
      throw FolioPdfPagesFailure(
        code: "PDF_MALFORMED",
        message: "A page in this PDF has no usable size."
      )
    }

    let quarterTurn = abs(page.rotationAngle) % 180 == 90
    let uprightWidth = quarterTurn ? box.height : box.width
    let uprightHeight = quarterTurn ? box.width : box.height

    var width = CGFloat(maxWidth)
    var height = max(1, (uprightHeight * width / uprightWidth).rounded())
    if height > maximumHeight {
      height = maximumHeight
      width = max(1, (uprightWidth * height / uprightHeight).rounded())
    }
    let pixelSize = CGSize(width: width, height: height)
    let target = CGRect(origin: .zero, size: pixelSize)

    let format = UIGraphicsImageRendererFormat.default()
    // One image pixel per point: the caller already asked for a pixel width.
    format.scale = 1
    format.opaque = true
    let image = UIGraphicsImageRenderer(size: pixelSize, format: format).image { context in
      let cgContext = context.cgContext
      cgContext.setFillColor(UIColor.white.cgColor)
      cgContext.fill(target)
      // Core Graphics draws PDF pages bottom-up; flip into the UIKit frame
      // before applying the page's own box and rotation transform.
      cgContext.translateBy(x: 0, y: pixelSize.height)
      cgContext.scaleBy(x: 1, y: -1)
      cgContext.concatenate(page.getDrawingTransform(
        boxType,
        rect: target,
        rotate: 0,
        preserveAspectRatio: true
      ))
      cgContext.drawPDFPage(page)
    }

    guard let data = image.jpegData(compressionQuality: jpegQuality) else {
      throw FolioPdfPagesFailure(
        code: "OUTPUT_UNAVAILABLE",
        message: "A page preview could not be encoded."
      )
    }
    let destination = outputDirectory.appendingPathComponent("page-\(number).jpg")
    do {
      try data.write(to: destination, options: .atomic)
    } catch {
      throw FolioPdfPagesFailure(
        code: "OUTPUT_UNAVAILABLE",
        message: "A page preview could not be written to the private cache."
      )
    }

    return [
      "page": number,
      "uri": destination.absoluteString,
      "width": Int(pixelSize.width),
      "height": Int(pixelSize.height),
    ]
  }

  /// Accepts only `file://` URLs inside the application container, so the
  /// renderer can never be pointed at another application's files.
  private static func fileUrl(_ value: String) throws -> URL {
    guard let url = URL(string: value), url.isFileURL else {
      throw FolioPdfPagesFailure(
        code: "PATH_NOT_PRIVATE",
        message: "Only app-private file URLs are supported."
      )
    }
    let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
    let container = URL(fileURLWithPath: NSHomeDirectory())
      .standardizedFileURL
      .resolvingSymlinksInPath()
    guard resolved.path == container.path
      || resolved.path.hasPrefix(container.path + "/") else {
      throw FolioPdfPagesFailure(
        code: "PATH_NOT_PRIVATE",
        message: "The file URL is outside Folio's private storage."
      )
    }
    return resolved
  }

  private static func reject(_ promise: Promise, _ error: Error) {
    if let failure = error as? FolioPdfPagesFailure {
      promise.reject("ERR_FOLIO_PDF_PAGES_\(failure.code)", failure.message)
      return
    }
    promise.reject(
      "ERR_FOLIO_PDF_PAGES_RENDER_FAILED",
      "The PDF pages could not be rendered on this device."
    )
  }
}
