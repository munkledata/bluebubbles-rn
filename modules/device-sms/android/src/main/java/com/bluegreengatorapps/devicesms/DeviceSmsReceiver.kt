package com.bluegreengatorapps.devicesms

import android.Manifest
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Process
import android.provider.ContactsContract
import android.provider.Telephony

/**
 * Shared SharedPreferences contract between the Expo module (which WRITES the prefs
 * from JS post-permission-grant, via setNotificationPrefs) and the manifest-registered
 * receiver (which READS them while the app process may be dead). Kept in one place so
 * the two sides can never drift on the key names.
 */
internal object DeviceSmsPrefs {
  const val NAME = "device_sms_prefs"

  /**
   * Master switch for the killed-app notification path. Defaults FALSE — the receiver
   * stays silent until JS explicitly enables it after the user has granted SMS access
   * (so a fresh install never posts before the feature is set up).
   */
  const val NOTIFICATIONS_ENABLED = "notificationsEnabled"

  /** Mirror of the app-wide "Redacted Mode" toggle. Defaults FALSE. */
  const val HIDE_PREVIEW = "hidePreview"
}

/**
 * Reassembles an incoming-SMS broadcast Intent into a single (address, body) pair.
 * Shared by BOTH the runtime receiver (in DeviceSmsModule, live while a screen observes)
 * and the manifest receiver below (killed-app path) so the multipart reassembly logic
 * lives in exactly one place.
 */
internal object SmsIntentParser {
  data class Parsed(val address: String, val body: String)

  fun parse(intent: Intent): Parsed? {
    val messages = Telephony.Sms.Intents.getMessagesFromIntent(intent) ?: return null
    if (messages.isEmpty()) return null
    val first = messages[0]
    val address = first.displayOriginatingAddress ?: first.originatingAddress ?: ""
    val body = StringBuilder()
    // A long SMS arrives as multiple parts in one broadcast — concatenate them in order.
    for (m in messages) {
      body.append(m.displayMessageBody ?: m.messageBody ?: "")
    }
    return Parsed(address, body.toString())
  }
}

/**
 * Notification plumbing shared by the SMS receiver (below) and the MMS receiver
 * ([DeviceSmsMmsReceiver]). Both fire with NO JS/React tree, so this posts plain
 * Android notifications (not Notifee) and is defensively guarded throughout.
 */
internal object DeviceSmsNotify {
  const val CHANNEL_ID = "device-sms"
  const val CHANNEL_NAME = "Phone SMS"
  // Must match the app's expo-router deep-link scheme (app.config.ts `scheme`).
  const val SCHEME = "bluebubbles"

  /** True only when THIS process's importance is FOREGROUND (user is in the app). */
  fun isAppInForeground(context: Context): Boolean {
    val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return false
    val myPid = Process.myPid()
    val procs = am.runningAppProcesses ?: return false
    for (p in procs) {
      if (p.pid == myPid) {
        return p.importance == ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND
      }
    }
    return false
  }

  /** Idempotently create the shared channel (no-op if it already exists). */
  fun ensureChannel(nm: NotificationManager) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && nm.getNotificationChannel(CHANNEL_ID) == null) {
      nm.createNotificationChannel(
        NotificationChannel(CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH),
      )
    }
  }

  @Suppress("DEPRECATION") // pre-O Notification.Builder(ctx) + setPriority
  fun newBuilder(context: Context): Notification.Builder =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, CHANNEL_ID)
    } else {
      Notification.Builder(context).setPriority(Notification.PRIORITY_HIGH)
    }
}

/**
 * DeviceSmsReceiver — MANIFEST-registered receiver for `SMS_RECEIVED`.
 *
 * Unlike the runtime receiver in [DeviceSmsModule] (which is only registered while a
 * screen is observing `onSmsReceived`), this one is declared in the library manifest and
 * is therefore delivered by the system even when the app process is DEAD. `SMS_RECEIVED`
 * is exempt from Android 8's implicit-broadcast restrictions and IS delivered to manifest
 * receivers of a non-default SMS app; `android:permission="BROADCAST_SMS"` in the manifest
 * restricts the sender to the system.
 *
 * It posts a plain Android notification (NOT Notifee — this must run with no JS/React tree)
 * that deep-links into the right thread. The whole body is defensively guarded: a broadcast
 * receiver that throws would show an ANR/crash, so every failure path is swallowed.
 */
class DeviceSmsReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
    try {
      val prefs = context.getSharedPreferences(DeviceSmsPrefs.NAME, Context.MODE_PRIVATE)
      // Not explicitly enabled by JS yet -> stay silent.
      if (!prefs.getBoolean(DeviceSmsPrefs.NOTIFICATIONS_ENABLED, false)) return
      // The in-app listener already surfaces incoming SMS when the user is looking at the
      // app; only notify when NOT foreground (backgrounded-but-alive still notifies).
      if (DeviceSmsNotify.isAppInForeground(context)) return

      val parsed = SmsIntentParser.parse(intent) ?: return
      if (parsed.address.isEmpty() && parsed.body.isEmpty()) return

      val hidePreview = prefs.getBoolean(DeviceSmsPrefs.HIDE_PREVIEW, false)
      postNotification(context, parsed.address, parsed.body, hidePreview)
    } catch (_: Throwable) {
      // Never crash a system broadcast; the message still arrives in the provider and
      // is picked up on the next in-app load.
    }
  }

  /** PhoneLookup display name, ONLY if READ_CONTACTS is already granted; else null. */
  private fun resolveContactName(context: Context, address: String): String? {
    if (address.isEmpty()) return null
    if (context.checkSelfPermission(Manifest.permission.READ_CONTACTS) != PackageManager.PERMISSION_GRANTED) {
      return null
    }
    return try {
      val uri = Uri.withAppendedPath(
        ContactsContract.PhoneLookup.CONTENT_FILTER_URI,
        Uri.encode(address),
      )
      context.contentResolver.query(
        uri,
        arrayOf(ContactsContract.PhoneLookup.DISPLAY_NAME),
        null,
        null,
        null,
      )?.use { c ->
        if (c.moveToFirst()) c.getString(0)?.takeIf { it.isNotBlank() } else null
      }
    } catch (_: Throwable) {
      null
    }
  }

  private fun postNotification(context: Context, address: String, body: String, hidePreview: Boolean) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    DeviceSmsNotify.ensureChannel(nm)

    // Resolve the thread id up front — drives BOTH the coalescing notification id and the
    // deep-link target. Needs READ_SMS; degrade to an address-derived id + no deep link.
    val threadId = try {
      Telephony.Threads.getOrCreateThreadId(context, address).toInt()
    } catch (_: Throwable) {
      -1
    }
    val notificationId = if (threadId >= 0) threadId else address.hashCode()

    val name = resolveContactName(context, address) ?: address.ifEmpty { "Unknown" }
    val title: String
    val text: String
    if (hidePreview) {
      // Honor the app-wide Redacted Mode: never leak sender/content on the lock screen.
      title = "Phone SMS"
      text = "New text message"
    } else {
      title = name
      text = body
    }

    val builder = DeviceSmsNotify.newBuilder(context)
      .setContentTitle(title)
      .setContentText(text)
      // Use the app's launcher icon as the small icon (mirrors the Notifee path).
      .setSmallIcon(context.applicationInfo.icon)
      .setAutoCancel(true)
      .setStyle(Notification.BigTextStyle().bigText(text))

    if (threadId >= 0) {
      // Deep-link into the thread. MainActivity (singleTask) already declares a VIEW/BROWSABLE
      // intent-filter for this scheme; expo-router routes bluebubbles://device-sms/<id> to
      // app/(app)/device-sms/[threadId].tsx (the (app) group segment is stripped from the URL).
      val uri = Uri.parse("${DeviceSmsNotify.SCHEME}://device-sms/$threadId")
      val tapIntent = Intent(Intent.ACTION_VIEW, uri).apply {
        setPackage(context.packageName)
        addCategory(Intent.CATEGORY_BROWSABLE)
        addCategory(Intent.CATEGORY_DEFAULT)
        flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
      }
      val piFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
      // Unique request code per thread so per-thread PendingIntents don't overwrite each other.
      builder.setContentIntent(PendingIntent.getActivity(context, threadId, tapIntent, piFlags))
    }

    try {
      nm.notify(notificationId, builder.build())
    } catch (_: Throwable) {
      // On API 33+ POST_NOTIFICATIONS may be ungranted -> NotificationManager can throw or
      // silently drop. Never let that crash the receiver.
    }
  }
}

/**
 * DeviceSmsMmsReceiver — MANIFEST-registered receiver for `WAP_PUSH_RECEIVED`
 * (mime `application/vnd.wap.mms-message`), the killed-app INCOMING-MMS signal.
 *
 * We deliberately do NOT parse the WAP push PDU: the default SMS app downloads
 * the MMS body asynchronously, so at push time neither the content nor the
 * thread id is knowable from the provider yet. We therefore post a GENERIC
 * "New picture message" notification that deep-links to the SMS INBOX (not a
 * specific thread); the ContentObserver / next in-app load surfaces the real
 * message once it lands. Sibling to [DeviceSmsReceiver] because a WAP push is
 * gated by BROADCAST_WAP_PUSH (vs BROADCAST_SMS), a per-receiver permission.
 */
class DeviceSmsMmsReceiver : BroadcastReceiver() {
  private companion object {
    // Fixed id so repeated MMS pushes coalesce into one generic notification.
    const val MMS_NOTIFICATION_ID = -0x5111 // arbitrary, unlikely to collide with thread ids
  }

  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action != Telephony.Sms.Intents.WAP_PUSH_RECEIVED_ACTION) return
    try {
      val prefs = context.getSharedPreferences(DeviceSmsPrefs.NAME, Context.MODE_PRIVATE)
      if (!prefs.getBoolean(DeviceSmsPrefs.NOTIFICATIONS_ENABLED, false)) return
      if (DeviceSmsNotify.isAppInForeground(context)) return

      val hidePreview = prefs.getBoolean(DeviceSmsPrefs.HIDE_PREVIEW, false)
      postGenericMmsNotification(context, hidePreview)
    } catch (_: Throwable) {
      // Never crash a system broadcast; the MMS still arrives in the provider and the
      // observer/next in-app load surfaces it.
    }
  }

  private fun postGenericMmsNotification(context: Context, hidePreview: Boolean) {
    val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager ?: return
    DeviceSmsNotify.ensureChannel(nm)

    // Thread/sender unknown at push time; keep it generic. Redacted Mode reuses the SMS wording.
    val title = "Phone SMS"
    val text = if (hidePreview) "New text message" else "New picture message"

    val builder = DeviceSmsNotify.newBuilder(context)
      .setContentTitle(title)
      .setContentText(text)
      .setSmallIcon(context.applicationInfo.icon)
      .setAutoCancel(true)

    // Deep-link to the inbox (the thread isn't knowable yet).
    val uri = Uri.parse("${DeviceSmsNotify.SCHEME}://device-sms")
    val tapIntent = Intent(Intent.ACTION_VIEW, uri).apply {
      setPackage(context.packageName)
      addCategory(Intent.CATEGORY_BROWSABLE)
      addCategory(Intent.CATEGORY_DEFAULT)
      flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
    }
    val piFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    builder.setContentIntent(
      PendingIntent.getActivity(context, MMS_NOTIFICATION_ID, tapIntent, piFlags),
    )

    try {
      nm.notify(MMS_NOTIFICATION_ID, builder.build())
    } catch (_: Throwable) {
      // POST_NOTIFICATIONS may be ungranted on API 33+; never crash the receiver.
    }
  }
}
