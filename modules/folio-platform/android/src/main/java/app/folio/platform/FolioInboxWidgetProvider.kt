package app.folio.platform

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.view.View
import android.widget.RemoteViews

private const val WIDGET_PREFERENCES = "folio-platform-widget"
private const val WIDGET_STATE_KEY = "state"
private const val WIDGET_COUNT_KEY = "inbox-count"
private const val WIDGET_QUICK_SCAN_ROUTE = "folio-paperless://scan"

internal enum class FolioWidgetState(val value: String) {
  LOCKED("locked"),
  NO_DATA("no-data"),
  READY("ready");

  companion object {
    fun from(value: String?): FolioWidgetState = entries.firstOrNull { it.value == value } ?: LOCKED
  }
}

class FolioInboxWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    val views = createViews(context)
    appWidgetIds.forEach { appWidgetManager.updateAppWidget(it, views) }
  }

  companion object {
    internal fun writeSnapshot(context: Context, state: FolioWidgetState, inboxCount: Int?) {
      require(state == FolioWidgetState.READY || inboxCount == null) {
        "Protected widget states cannot include an inbox count."
      }
      require(state != FolioWidgetState.READY || inboxCount in 0..999) {
        "Widget inbox count must be between 0 and 999."
      }
      context.getSharedPreferences(WIDGET_PREFERENCES, Context.MODE_PRIVATE)
        .edit()
        .putString(WIDGET_STATE_KEY, state.value)
        .apply {
          if (inboxCount == null) remove(WIDGET_COUNT_KEY) else putInt(WIDGET_COUNT_KEY, inboxCount)
        }
        .apply()
      updateAll(context)
    }

    internal fun lock(context: Context) = writeSnapshot(context, FolioWidgetState.LOCKED, null)

    private fun updateAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val component = ComponentName(context, FolioInboxWidgetProvider::class.java)
      val ids = manager.getAppWidgetIds(component)
      if (ids.isNotEmpty()) manager.updateAppWidget(ids, createViews(context))
    }

    private fun createViews(context: Context): RemoteViews {
      val preferences = context.getSharedPreferences(WIDGET_PREFERENCES, Context.MODE_PRIVATE)
      val state = FolioWidgetState.from(preferences.getString(WIDGET_STATE_KEY, null))
      val count = if (state == FolioWidgetState.READY) {
        preferences.getInt(WIDGET_COUNT_KEY, -1).takeIf { it in 0..999 }
      } else {
        null
      }
      val safeState = if (state == FolioWidgetState.READY && count == null) {
        FolioWidgetState.LOCKED
      } else {
        state
      }
      return RemoteViews(context.packageName, R.layout.folio_inbox_widget).apply {
        when (safeState) {
          FolioWidgetState.LOCKED -> {
            setTextViewText(R.id.folio_widget_primary, context.getString(R.string.folio_widget_locked))
            setTextViewText(R.id.folio_widget_secondary, context.getString(R.string.folio_widget_open_scan))
          }
          FolioWidgetState.NO_DATA -> {
            setTextViewText(R.id.folio_widget_primary, context.getString(R.string.folio_widget_inbox))
            setTextViewText(R.id.folio_widget_secondary, context.getString(R.string.folio_widget_open_scan))
          }
          FolioWidgetState.READY -> {
            setTextViewText(R.id.folio_widget_primary, count.toString())
            setTextViewText(
              R.id.folio_widget_secondary,
              context.getString(
                if (count == 1) R.string.folio_widget_inbox_item else R.string.folio_widget_inbox_items,
              ),
            )
          }
        }
        setViewVisibility(R.id.folio_widget_brand, View.VISIBLE)
        quickScanPendingIntent(context)?.let { setOnClickPendingIntent(R.id.folio_widget_root, it) }
      }
    }

    private fun quickScanPendingIntent(context: Context): PendingIntent? {
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
      intent.action = Intent.ACTION_VIEW
      intent.data = Uri.parse(WIDGET_QUICK_SCAN_ROUTE)
      intent.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      return PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }
}
