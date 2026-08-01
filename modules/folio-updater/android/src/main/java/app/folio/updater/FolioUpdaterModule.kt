package app.folio.updater

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

private const val APK_MIME_TYPE = "application/vnd.android.package-archive"
private const val EXPECTED_PACKAGE_NAME = "app.folio.paperless"

// Public certificate fingerprint mirrored by the GitHub `release` environment.
private const val OFFICIAL_CERTIFICATE_SHA256 =
  "b82ed4612255d5102d40865393269f6648e009ca102dbd172bf56761a1dbc8e0"

class FolioUpdaterModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("FolioUpdater")

    AsyncFunction("getInstallationInfoAsync") {
      val context = requireContext()
      val packageInfo = getInstalledPackageInfo(context)
      val certificate = signingCertificateSha256(packageInfo)

      mapOf(
        "packageName" to packageInfo.packageName,
        "versionName" to (packageInfo.versionName ?: ""),
        "versionCode" to versionCode(packageInfo).toDouble(),
        "certificateSha256" to certificate,
        "isOfficialRelease" to (
          packageInfo.packageName == EXPECTED_PACKAGE_NAME &&
            certificate == OFFICIAL_CERTIFICATE_SHA256
          ),
        "canRequestPackageInstalls" to canRequestPackageInstalls(context),
      )
    }

    AsyncFunction("calculateFileSha256Async") { fileUri: String ->
      calculateFileSha256(resolveUpdateFile(fileUri))
    }

    AsyncFunction("inspectApkAsync") { fileUri: String ->
      val context = requireContext()
      val archive = getArchivePackageInfo(context, resolveUpdateFile(fileUri))
      val certificate = signingCertificateSha256(archive)

      mapOf(
        "packageName" to archive.packageName,
        "versionName" to (archive.versionName ?: ""),
        "versionCode" to versionCode(archive).toDouble(),
        "certificateSha256" to certificate,
        "hasOfficialCertificate" to (certificate == OFFICIAL_CERTIFICATE_SHA256),
      )
    }

    AsyncFunction("canRequestPackageInstallsAsync") {
      canRequestPackageInstalls(requireContext())
    }

    AsyncFunction("openInstallPermissionSettingsAsync") {
      val context = requireContext()
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        val intent = Intent(
          Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
          Uri.parse("package:${context.packageName}"),
        )
        startActivity(intent)
      }
      null
    }

    AsyncFunction("installApkAsync") { fileUri: String ->
      val context = requireContext()
      val updateFile = resolveUpdateFile(fileUri)
      validateInstallCandidate(context, updateFile)

      if (!canRequestPackageInstalls(context)) {
        throw IllegalStateException(
          "Android has not allowed Folio to install updates. Allow this source and try again.",
        )
      }

      val contentUri = FileProvider.getUriForFile(
        context,
        "${context.packageName}.folio-updater.fileprovider",
        updateFile,
      )
      val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(contentUri, APK_MIME_TYPE)
        clipData = ClipData.newRawUri("Folio update", contentUri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      startActivity(intent)
      null
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext
      ?: throw IllegalStateException("Folio's Android application context is unavailable.")

  private fun startActivity(intent: Intent) {
    val activity = appContext.currentActivity
    if (activity != null) {
      activity.startActivity(intent)
      return
    }

    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    requireContext().startActivity(intent)
  }

  private fun canRequestPackageInstalls(context: Context): Boolean =
    Build.VERSION.SDK_INT < Build.VERSION_CODES.O || context.packageManager.canRequestPackageInstalls()

  private fun resolveUpdateFile(fileUri: String): File {
    val context = requireContext()
    val uri = Uri.parse(fileUri)
    if (uri.scheme != "file" || uri.path.isNullOrBlank()) {
      throw IllegalArgumentException("The update must be a local file in Folio's cache.")
    }

    val file = File(requireNotNull(uri.path)).canonicalFile
    val updateDirectory = File(context.cacheDir, "folio-updates").canonicalFile
    val updatePrefix = updateDirectory.path + File.separator
    if (!file.path.startsWith(updatePrefix) || !file.name.endsWith(".apk", ignoreCase = true)) {
      throw IllegalArgumentException("The selected file is not a Folio update APK.")
    }
    if (!file.isFile || file.length() <= 0L) {
      throw IllegalArgumentException("The downloaded update APK is missing or empty.")
    }
    return file
  }

  private fun validateInstallCandidate(context: Context, updateFile: File) {
    val installed = getInstalledPackageInfo(context)
    val archive = getArchivePackageInfo(context, updateFile)
    val installedCertificate = signingCertificateSha256(installed)
    val archiveCertificate = signingCertificateSha256(archive)

    if (installed.packageName != EXPECTED_PACKAGE_NAME || archive.packageName != EXPECTED_PACKAGE_NAME) {
      throw IllegalStateException("The update package does not belong to Folio.")
    }
    if (installedCertificate != OFFICIAL_CERTIFICATE_SHA256) {
      throw IllegalStateException(
        "This build uses a development signing key and cannot install GitHub release updates.",
      )
    }
    if (archiveCertificate != OFFICIAL_CERTIFICATE_SHA256 || archiveCertificate != installedCertificate) {
      throw IllegalStateException("The update is not signed by Folio's official release key.")
    }
    if (versionCode(archive) <= versionCode(installed)) {
      throw IllegalStateException("The downloaded APK is not newer than the installed Folio version.")
    }
  }

  @Suppress("DEPRECATION")
  private fun getInstalledPackageInfo(context: Context): PackageInfo {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }
    return context.packageManager.getPackageInfo(context.packageName, flags)
  }

  @Suppress("DEPRECATION")
  private fun getArchivePackageInfo(context: Context, file: File): PackageInfo {
    val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      PackageManager.GET_SIGNING_CERTIFICATES
    } else {
      PackageManager.GET_SIGNATURES
    }
    return context.packageManager.getPackageArchiveInfo(file.path, flags)
      ?: throw IllegalArgumentException("Android could not read the downloaded update APK.")
  }

  @Suppress("DEPRECATION")
  private fun signingCertificateSha256(packageInfo: PackageInfo): String {
    val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.signingInfo?.apkContentsSigners
    } else {
      packageInfo.signatures
    }
    if (signatures == null || signatures.size != 1) {
      throw IllegalStateException("Folio updates must contain exactly one APK signer.")
    }
    return sha256(signatures[0].toByteArray())
  }

  @Suppress("DEPRECATION")
  private fun versionCode(packageInfo: PackageInfo): Long =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      packageInfo.longVersionCode
    } else {
      packageInfo.versionCode.toLong()
    }

  private fun calculateFileSha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    FileInputStream(file).use { input ->
      val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
      while (true) {
        val read = input.read(buffer)
        if (read < 0) break
        digest.update(buffer, 0, read)
      }
    }
    return digest.digest().joinToString("") { byte -> "%02x".format(byte) }
  }

  private fun sha256(bytes: ByteArray): String =
    MessageDigest.getInstance("SHA-256")
      .digest(bytes)
      .joinToString("") { byte -> "%02x".format(byte) }
}
