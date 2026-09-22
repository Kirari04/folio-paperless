package app.folio.pdfpages

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.IOException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import kotlin.math.max
import kotlin.math.roundToInt

private const val MINIMUM_WIDTH = 32
private const val MAXIMUM_WIDTH = 2_048
// Caps the long edge so a pathological page aspect ratio cannot grow the single
// bitmap beyond `maxWidth * 2048 * 4` bytes (about 3 MiB at the editor's width).
private const val MAXIMUM_HEIGHT = 2_048
private const val MAXIMUM_PAGES = 10_000
private const val JPEG_QUALITY = 80

private class FolioPdfPagesFailure(val failureCode: String, message: String) : Exception(message)

/**
 * Renders one JPEG thumbnail per PDF page with the platform renderer. Pages are
 * rasterized strictly one at a time: a single ARGB_8888 bitmap exists at any
 * moment and is recycled before the next page is opened, so a long scan costs
 * the memory of one page instead of the memory of the whole document.
 */
class FolioPdfPagesModule : Module() {
  // A single worker keeps concurrent editor sessions from rasterizing at the
  // same time, which would defeat the one-bitmap-at-a-time guarantee.
  private val executor: ExecutorService = Executors.newSingleThreadExecutor()

  private val context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("FolioPdfPages")

    AsyncFunction("renderPageThumbnails") {
      pdfUri: String,
      outputDirectoryUri: String,
      maxWidth: Int,
      promise: Promise,
      ->
      executor.execute {
        try {
          promise.resolve(renderThumbnails(pdfUri, outputDirectoryUri, maxWidth))
        } catch (error: Throwable) {
          reject(promise, error)
        }
      }
    }

    OnDestroy {
      executor.shutdown()
    }
  }

  private fun renderThumbnails(
    pdfUri: String,
    outputDirectoryUri: String,
    maxWidth: Int,
  ): Map<String, Any> {
    if (maxWidth < MINIMUM_WIDTH || maxWidth > MAXIMUM_WIDTH) {
      throw FolioPdfPagesFailure(
        "WIDTH_UNSUPPORTED",
        "The requested thumbnail width is outside the supported range.",
      )
    }

    val source = privateFile(pdfUri)
    if (!source.isFile || source.length() <= 0L) {
      throw FolioPdfPagesFailure(
        "SOURCE_UNAVAILABLE",
        "The PDF is no longer available on this device.",
      )
    }

    val outputDirectory = privateFile(outputDirectoryUri)
    if (!outputDirectory.exists() && !outputDirectory.mkdirs()) {
      throw FolioPdfPagesFailure(
        "OUTPUT_UNAVAILABLE",
        "The page preview directory could not be created.",
      )
    }
    if (!outputDirectory.isDirectory) {
      throw FolioPdfPagesFailure(
        "OUTPUT_UNAVAILABLE",
        "The page preview destination is not a directory.",
      )
    }

    val descriptor = try {
      ParcelFileDescriptor.open(source, ParcelFileDescriptor.MODE_READ_ONLY)
    } catch (error: IOException) {
      throw FolioPdfPagesFailure(
        "SOURCE_UNREADABLE",
        "The PDF could not be opened for page previews.",
      )
    }

    var renderer: PdfRenderer? = null
    try {
      renderer = try {
        PdfRenderer(descriptor)
      } catch (error: SecurityException) {
        throw FolioPdfPagesFailure(
          "PDF_PASSWORD_PROTECTED",
          "This PDF is password protected, so its pages cannot be previewed.",
        )
      } catch (error: IOException) {
        throw FolioPdfPagesFailure(
          "PDF_MALFORMED",
          "This PDF could not be read for page previews.",
        )
      }

      val pageCount = renderer.pageCount
      if (pageCount < 1) {
        throw FolioPdfPagesFailure("PDF_MALFORMED", "This PDF has no renderable pages.")
      }
      if (pageCount > MAXIMUM_PAGES) {
        throw FolioPdfPagesFailure(
          "PDF_TOO_MANY_PAGES",
          "This PDF has more pages than the editor can preview.",
        )
      }

      val pages = ArrayList<Map<String, Any>>(pageCount)
      for (index in 0 until pageCount) {
        pages.add(renderPage(renderer, index, outputDirectory, maxWidth))
      }
      return mapOf("pageCount" to pageCount, "pages" to pages)
    } finally {
      try {
        renderer?.close()
      } catch (ignored: Throwable) {
        // A close failure must not mask the rendering outcome.
      }
      try {
        // PdfRenderer.close() already released this descriptor on the happy
        // path; closing an already-closed descriptor is a no-op.
        descriptor.close()
      } catch (ignored: IOException) {
        // Ignored for the same reason.
      }
    }
  }

  private fun renderPage(
    renderer: PdfRenderer,
    index: Int,
    outputDirectory: File,
    maxWidth: Int,
  ): Map<String, Any> {
    var page: PdfRenderer.Page? = null
    var bitmap: Bitmap? = null
    try {
      val current = try {
        renderer.openPage(index)
      } catch (error: Throwable) {
        throw FolioPdfPagesFailure(
          "PDF_MALFORMED",
          "A page in this PDF could not be opened for preview.",
        )
      }
      page = current

      val sourceWidth = current.width
      val sourceHeight = current.height
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        throw FolioPdfPagesFailure(
          "PDF_MALFORMED",
          "A page in this PDF has no usable size.",
        )
      }

      var width = maxWidth
      var height = max(
        1,
        (sourceHeight.toDouble() * width.toDouble() / sourceWidth.toDouble()).roundToInt(),
      )
      if (height > MAXIMUM_HEIGHT) {
        height = MAXIMUM_HEIGHT
        width = max(
          1,
          (sourceWidth.toDouble() * height.toDouble() / sourceHeight.toDouble()).roundToInt(),
        )
      }

      val pageBitmap = try {
        Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
      } catch (error: OutOfMemoryError) {
        throw FolioPdfPagesFailure(
          "RENDER_OUT_OF_MEMORY",
          "This device could not allocate a preview for one of the pages.",
        )
      }
      bitmap = pageBitmap
      // PdfRenderer composites onto the destination, so an opaque white page
      // needs an explicitly white bitmap rather than the default transparency.
      pageBitmap.eraseColor(Color.WHITE)
      current.render(pageBitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY)
      current.close()
      page = null

      val destination = File(outputDirectory, "page-${index + 1}.jpg")
      val compressed = destination.outputStream().use { stream ->
        val ok = pageBitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, stream)
        stream.flush()
        ok
      }
      if (!compressed) {
        throw FolioPdfPagesFailure(
          "OUTPUT_UNAVAILABLE",
          "A page preview could not be written to the private cache.",
        )
      }

      return mapOf(
        "page" to index + 1,
        "uri" to Uri.fromFile(destination).toString(),
        "width" to width,
        "height" to height,
      )
    } finally {
      try {
        page?.close()
      } catch (ignored: Throwable) {
        // Ignored: the renderer is closed by the caller either way.
      }
      bitmap?.recycle()
    }
  }

  /**
   * Accepts only `file://` URLs inside Folio's own sandbox, so the renderer can
   * never be pointed at shared storage or another application's files.
   */
  private fun privateFile(value: String): File {
    val uri = Uri.parse(value)
    val path = uri.path
    if (uri.scheme != "file" || path.isNullOrEmpty()) {
      throw FolioPdfPagesFailure(
        "PATH_NOT_PRIVATE",
        "Only app-private file URLs are supported.",
      )
    }
    val file = File(path).canonicalFile
    val roots = listOf(context.filesDir, context.cacheDir, context.noBackupFilesDir)
      .map { it.canonicalFile }
    if (!roots.any { file.path == it.path || file.path.startsWith(it.path + File.separator) }) {
      throw FolioPdfPagesFailure(
        "PATH_NOT_PRIVATE",
        "The file URL is outside Folio's private storage.",
      )
    }
    return file
  }

  private fun reject(promise: Promise, error: Throwable) {
    val failure = error as? FolioPdfPagesFailure
    promise.reject(
      "ERR_FOLIO_PDF_PAGES_${failure?.failureCode ?: "RENDER_FAILED"}",
      failure?.message ?: "The PDF pages could not be rendered on this device.",
      null,
    )
  }
}
