package app.folio.platform

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.pdf.PdfRenderer
import android.net.Uri
import android.os.ParcelFileDescriptor
import expo.modules.kotlin.Promise
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

// FairScan (GPL-3, https://github.com/pynicolas/FairScan) is a libre Android
// document scanner. Its README documents an experimental implicit intent,
// "Experimental: Scan to PDF via intent", that Folio uses as an alternative to
// the bundled ML Kit scanner: the ML Kit scanner needs Google Play Services,
// which no F-Droid build and no de-Googled phone can offer.
//
// The contract is deliberately narrow, and FairScan states that it may change
// between versions:
//   * no extras are sent and none are expected back;
//   * `RESULT_OK` carries the PDF in `Intent.getData()` (mirrored in
//     `clipData`) behind a temporary `FLAG_GRANT_READ_URI_PERMISSION` grant;
//   * `RESULT_CANCELED` means the person backed out;
//   * FairScan deletes its own copy, so the bytes must be read while the
//     activity result is being delivered.
internal const val FAIRSCAN_SCAN_TO_PDF_ACTION = "org.fairscan.app.action.SCAN_TO_PDF"
internal const val FAIRSCAN_PACKAGE_NAME = "org.fairscan.app"
internal const val FAIRSCAN_REQUEST_CODE = 0xFA15

private const val SCAN_CACHE_DIRECTORY = "folio-scans"
private const val COPY_BUFFER_BYTES = 64 * 1024

// Any activity may claim an implicit action, so the copy is bounded. Folio's
// own scans stay far below this; the limit only stops a hostile responder from
// filling the cache partition.
private const val MAX_SCAN_BYTES = 256L * 1024L * 1024L

// Mirrors `TEMPORARY_FILE_MAX_AGE_MS` in `src/lib/temporary-file-policy.ts`.
private const val SCAN_CACHE_MAX_AGE_MS = 24L * 60L * 60L * 1000L

internal class FolioFairScanScanner {
  private val lock = Any()
  private var pending: Promise? = null

  fun isAvailable(context: Context): Boolean = resolvedPackages(context).isNotEmpty()

  fun launch(activity: Activity?, context: Context, promise: Promise) {
    if (activity == null) {
      promise.reject(
        "ERR_FAIRSCAN_NO_ACTIVITY",
        "Folio has no foreground activity to start FairScan from.",
        null,
      )
      return
    }
    val packages = resolvedPackages(context)
    if (packages.isEmpty()) {
      promise.reject(
        "ERR_FAIRSCAN_UNAVAILABLE",
        "FairScan is not installed on this device.",
        null,
      )
      return
    }
    synchronized(lock) {
      if (pending != null) {
        promise.reject("ERR_FAIRSCAN_BUSY", "A FairScan scan is already running.", null)
        return
      }
      pending = promise
    }

    removeStaleScans(context)
    val intent = Intent(FAIRSCAN_SCAN_TO_PDF_ACTION)
    // Pin the responder whenever it is unambiguous: FairScan itself when it is
    // installed, otherwise a single responder. Several third-party responders
    // stay implicit so Android can ask which one to use.
    when {
      packages.contains(FAIRSCAN_PACKAGE_NAME) -> intent.setPackage(FAIRSCAN_PACKAGE_NAME)
      packages.size == 1 -> intent.setPackage(packages.first())
    }
    try {
      activity.startActivityForResult(intent, FAIRSCAN_REQUEST_CODE)
    } catch (error: ActivityNotFoundException) {
      takePending()?.reject(
        "ERR_FAIRSCAN_UNAVAILABLE",
        "FairScan is not installed on this device.",
        error,
      )
    } catch (error: Throwable) {
      takePending()?.reject("ERR_FAIRSCAN_LAUNCH", "FairScan could not be started.", error)
    }
  }

  /** Returns true when this result belonged to a FairScan request. */
  fun handleResult(context: Context?, requestCode: Int, resultCode: Int, data: Intent?): Boolean {
    if (requestCode != FAIRSCAN_REQUEST_CODE) return false
    val promise = takePending() ?: return true

    if (resultCode == Activity.RESULT_CANCELED) {
      promise.resolve(null)
      return true
    }
    if (resultCode != Activity.RESULT_OK) {
      promise.reject(
        "ERR_FAIRSCAN_RESULT",
        "FairScan returned an unexpected scan result.",
        null,
      )
      return true
    }
    if (context == null) {
      promise.reject(
        "ERR_FAIRSCAN_RESULT",
        "Folio's Android application context is unavailable.",
        null,
      )
      return true
    }
    val uri = data?.data
      ?: data?.clipData?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.uri
    if (uri == null) {
      promise.reject("ERR_FAIRSCAN_RESULT", "FairScan did not return a scanned PDF.", null)
      return true
    }

    try {
      // FairScan deletes the file it handed over, so this copy has to happen
      // now, while the read grant on `uri` is still alive.
      val copy = copyIntoPrivateCache(context, uri)
      promise.resolve(
        mapOf(
          "uri" to Uri.fromFile(copy).toString(),
          "pageCount" to readPageCount(copy),
        ),
      )
    } catch (error: Throwable) {
      promise.reject(
        "ERR_FAIRSCAN_COPY",
        error.message ?: "The scanned PDF could not be copied into Folio.",
        error,
      )
    }
    return true
  }

  fun abandon() {
    takePending()?.reject("ERR_FAIRSCAN_ABANDONED", "Folio stopped waiting for FairScan.", null)
  }

  private fun takePending(): Promise? = synchronized(lock) {
    val promise = pending
    pending = null
    promise
  }

  @Suppress("DEPRECATION")
  private fun resolvedPackages(context: Context): List<String> =
    // Android 11+ hides other packages unless the intent is declared in the
    // manifest's `<queries>` block, which `withFolioPlatformIntegrations` adds.
    context.packageManager
      .queryIntentActivities(Intent(FAIRSCAN_SCAN_TO_PDF_ACTION), 0)
      .mapNotNull { it.activityInfo?.packageName }
      .distinct()

  private fun copyIntoPrivateCache(context: Context, uri: Uri): File {
    val directory = scanDirectory(context)
    if (!directory.exists() && !directory.mkdirs()) {
      throw IllegalStateException("Folio's private scan cache is unavailable.")
    }
    val destination = File(directory, "fairscan-${UUID.randomUUID()}.pdf")
    var copied = 0L
    try {
      val input = context.contentResolver.openInputStream(uri)
        ?: throw IllegalStateException("The scanned PDF could not be read from FairScan.")
      input.use { source ->
        FileOutputStream(destination).use { output ->
          val buffer = ByteArray(COPY_BUFFER_BYTES)
          while (true) {
            val read = source.read(buffer)
            if (read < 0) break
            copied += read
            if (copied > MAX_SCAN_BYTES) {
              throw IllegalStateException("The returned scan is too large for Folio.")
            }
            output.write(buffer, 0, read)
          }
        }
      }
      if (copied <= 0L) throw IllegalStateException("FairScan returned an empty PDF.")
    } catch (error: Throwable) {
      destination.delete()
      throw error
    }
    return destination
  }

  private fun readPageCount(file: File): Int? = try {
    ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
      PdfRenderer(descriptor).use { renderer -> renderer.pageCount }
    }
  } catch (_: Throwable) {
    // An unreadable page count must never fail an otherwise valid scan.
    null
  }

  private fun removeStaleScans(context: Context) {
    try {
      val threshold = System.currentTimeMillis() - SCAN_CACHE_MAX_AGE_MS
      scanDirectory(context).listFiles()?.forEach { file ->
        if (file.isFile && file.lastModified() < threshold) file.delete()
      }
    } catch (_: Throwable) {
      // Cache hygiene is best effort and never blocks a scan.
    }
  }

  private fun scanDirectory(context: Context) = File(context.cacheDir, SCAN_CACHE_DIRECTORY)
}
