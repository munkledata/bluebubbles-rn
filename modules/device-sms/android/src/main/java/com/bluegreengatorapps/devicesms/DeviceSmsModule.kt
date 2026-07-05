package com.bluegreengatorapps.devicesms

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.database.ContentObserver
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.provider.Telephony
import android.telephony.SmsManager
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * DeviceSms — local Expo module (Android-only).
 *
 * Reads and sends SMS directly on the device via the Telephony content provider
 * and SmsManager. All provider queries + sends run on expo-modules-core's DEFAULT
 * async queue (a background HandlerThread — AsyncFunction bodies are dispatched
 * there, NOT the main thread). Permissions (READ_SMS / SEND_SMS / RECEIVE_SMS) are
 * declared in the app manifest and requested JS-side; this module only GUARDS the
 * grant and rejects with ERR_SMS_PERMISSION if missing.
 *
 * NB: on Android 4.4+ a non-default SMS app cannot write content://sms — SmsManager
 * sends are auto-persisted by the system — so this module never inserts/updates the
 * provider (no marking-read, no manual sent-row insert).
 */
class DeviceSmsModule : Module() {
  private companion object {
    const val SENT_ACTION_PREFIX = "com.bluegreengatorapps.devicesms.SMS_SENT."
    const val SEND_TIMEOUT_MS = 60_000L
    const val EVENT_SMS_RECEIVED = "onSmsReceived"
    const val EVENT_PROVIDER_CHANGED = "onProviderChanged"
    // Debounce provider-change bursts (the default SMS app writes several rows/parts
    // for one incoming MMS) into a single JS refetch.
    const val PROVIDER_DEBOUNCE_MS = 400L

    // SMS type constants (Telephony.Sms.TYPE_*), inlined to avoid API-level surprises.
    const val TYPE_INBOX = 1
    const val TYPE_SENT = 2
    const val TYPE_DRAFT = 3
    const val TYPE_OUTBOX = 4
    const val TYPE_FAILED = 5
    const val TYPE_QUEUED = 6

    // MMS msg_box (Telephony.Mms.MESSAGE_BOX_*): 1=inbox 2=sent 3=draft 4=outbox 5=failed.
    const val MMS_BOX_INBOX = 1
    const val MMS_BOX_SENT = 2
    const val MMS_BOX_OUTBOX = 4
    const val MMS_BOX_FAILED = 5

    // MMS address types (PduHeaders): 137=FROM (sender), 151=TO (recipient).
    const val MMS_ADDR_FROM = 137
    const val MMS_ADDR_TO = 151
    // Placeholder the provider stores for the local user's own address — never a real number.
    const val INSERT_ADDRESS_TOKEN = "insert-address-token"
  }

  /** Live receiver for incoming SMS while JS is observing `onSmsReceived`. */
  private var smsReceiver: BroadcastReceiver? = null

  /** Live provider observer while JS is observing `onProviderChanged`. */
  private var providerObserver: ContentObserver? = null
  private var observerThread: HandlerThread? = null

  override fun definition() = ModuleDefinition {
    Name("DeviceSms")

    Events(EVENT_SMS_RECEIVED, EVENT_PROVIDER_CHANGED)

    OnStartObserving(EVENT_SMS_RECEIVED) {
      registerSmsReceiver()
    }

    OnStopObserving(EVENT_SMS_RECEIVED) {
      unregisterSmsReceiver()
    }

    // Provider observer is registered only while JS subscribes onProviderChanged
    // (per-event lifecycle — fires when the first/last listener of THIS event is added/removed).
    OnStartObserving(EVENT_PROVIDER_CHANGED) {
      registerProviderObserver()
    }

    OnStopObserving(EVENT_PROVIDER_CHANGED) {
      unregisterProviderObserver()
    }

    OnDestroy {
      unregisterSmsReceiver()
      unregisterProviderObserver()
    }

    // Runs on the DEFAULT (background) queue; throwing a CodedException rejects the JS promise.
    AsyncFunction("getThreads") { limit: Int, offset: Int ->
      getThreads(limit, offset)
    }

    AsyncFunction("getMessages") { threadId: Int, limit: Int, beforeDateMs: Double ->
      getMessages(threadId, limit, beforeDateMs)
    }

    AsyncFunction("getOrCreateThreadId") { address: String ->
      val ctx = requireContext()
      // getOrCreateThreadId queries content://mms-sms -> guard on READ_SMS so a
      // pre-grant call rejects with the typed ERR_SMS_PERMISSION (not a raw SecurityException).
      ensurePermission(ctx, Manifest.permission.READ_SMS)
      // Telephony.Threads.getOrCreateThreadId returns a Long; thread ids are small
      // auto-increment values, safely representable as Int / a JS number.
      Telephony.Threads.getOrCreateThreadId(ctx, address).toInt()
    }

    AsyncFunction("sendSms") { address: String, body: String, promise: Promise ->
      sendSms(address, body, promise)
    }

    // Resolves the other-party address for a thread id — used when the thread screen is
    // opened directly by a killed-app notification deep link (only the thread id is known).
    AsyncFunction("getThreadAddress") { threadId: Int ->
      getThreadAddress(threadId)
    }

    // Writes the killed-app notification prefs read by DeviceSmsReceiver (a manifest
    // receiver that fires with no JS tree). Called from JS after a permission grant / when
    // the Redacted Mode toggle changes — never from a startup path.
    AsyncFunction("setNotificationPrefs") { enabled: Boolean, hidePreview: Boolean ->
      val ctx = requireContext()
      ctx.getSharedPreferences(DeviceSmsPrefs.NAME, Context.MODE_PRIVATE)
        .edit()
        .putBoolean(DeviceSmsPrefs.NOTIFICATIONS_ENABLED, enabled)
        .putBoolean(DeviceSmsPrefs.HIDE_PREVIEW, hidePreview)
        .apply()
    }
  }

  // region Provider reads

  private fun getThreads(limit: Int, offset: Int): List<Map<String, Any?>> {
    val ctx = requireContext()
    ensurePermission(ctx, Manifest.permission.READ_SMS)
    val resolver = ctx.contentResolver
    val canonical = loadCanonicalAddresses(resolver)

    val result = ArrayList<Map<String, Any?>>()
    val uri = Uri.parse("content://mms-sms/conversations?simple=true")
    resolver.query(uri, null, null, null, "date DESC")?.use { c ->
      val idIdx = c.getColumnIndex("_id")
      val snippetIdx = c.getColumnIndex("snippet")
      val dateIdx = c.getColumnIndex("date")
      val countIdx = c.getColumnIndex("message_count")
      val recipIdx = c.getColumnIndex("recipient_ids")
      if (idIdx < 0) return@use

      var skipped = 0
      while (c.moveToNext()) {
        if (skipped < offset) {
          skipped++
          continue
        }
        if (result.size >= limit) break

        val threadId = c.getLong(idIdx)
        val snippet = if (snippetIdx >= 0) c.getString(snippetIdx) ?: "" else ""
        val date = if (dateIdx >= 0) c.getLong(dateIdx) else 0L
        val messageCount = if (countIdx >= 0) c.getInt(countIdx) else 0
        val recipientIds = if (recipIdx >= 0) c.getString(recipIdx) ?: "" else ""

        // Resolve ALL recipient ids -> addresses (a group thread has >1); keep `address`
        // as the FIRST recipient for back-compat / avatar seeding.
        val recipients = recipientIds
          .split(" ")
          .filter { it.isNotBlank() }
          .mapNotNull { canonical[it] }
          .filter { it.isNotBlank() }
        val address = recipients.firstOrNull() ?: ""

        result.add(
          mapOf(
            "threadId" to threadId.toInt(),
            "address" to address,
            "recipients" to recipients,
            "isGroup" to (recipients.size > 1),
            "snippet" to snippet,
            "date" to date.toDouble(),
            "messageCount" to messageCount,
            // MMS-inclusive: unread inbox SMS + unread inbox MMS.
            "unreadCount" to (countUnread(resolver, threadId) + countUnreadMms(resolver, threadId))
          )
        )
      }
    }
    return result
  }

  /**
   * A page of a thread's messages, OLDEST→NEWEST, UNIONING plain SMS
   * (content://sms) with MMS (content://mms — group + picture messages). Each
   * source is queried newest-first with the same LIMIT, merged, trimmed to
   * `limit` across the union, then reversed to chronological order — so paging
   * with `beforeDateMs` walks the merged timeline correctly.
   */
  private fun getMessages(threadId: Int, limit: Int, beforeDateMs: Double): List<Map<String, Any?>> {
    val ctx = requireContext()
    ensurePermission(ctx, Manifest.permission.READ_SMS)
    val resolver = ctx.contentResolver

    val merged = ArrayList<Map<String, Any?>>()
    merged.addAll(querySmsPage(resolver, threadId, limit, beforeDateMs))
    merged.addAll(queryMmsPage(resolver, threadId, limit, beforeDateMs))

    // Newest-first across the union, keep the newest `limit`, then reverse to chronological.
    merged.sortByDescending { (it["date"] as? Double) ?: 0.0 }
    val trimmed = if (merged.size > limit) ArrayList(merged.subList(0, limit)) else merged
    trimmed.reverse()
    return trimmed
  }

  /** SMS half of a thread page (newest-first, LIMIT-capped). */
  private fun querySmsPage(
    resolver: ContentResolver,
    threadId: Int,
    limit: Int,
    beforeDateMs: Double,
  ): List<Map<String, Any?>> {
    val projection = arrayOf("_id", "thread_id", "address", "body", "date", "type", "read")
    val selection: String
    val args: Array<String>
    if (beforeDateMs > 0) {
      selection = "thread_id=? AND date<?"
      args = arrayOf(threadId.toString(), beforeDateMs.toLong().toString())
    } else {
      selection = "thread_id=?"
      args = arrayOf(threadId.toString())
    }
    val sortOrder = "date DESC LIMIT $limit"

    val out = ArrayList<Map<String, Any?>>()
    resolver.query(Telephony.Sms.CONTENT_URI, projection, selection, args, sortOrder)?.use { c ->
      val idIdx = c.getColumnIndex("_id")
      val threadIdx = c.getColumnIndex("thread_id")
      val addressIdx = c.getColumnIndex("address")
      val bodyIdx = c.getColumnIndex("body")
      val dateIdx = c.getColumnIndex("date")
      val typeIdx = c.getColumnIndex("type")
      val readIdx = c.getColumnIndex("read")

      while (c.moveToNext()) {
        val type = if (typeIdx >= 0) c.getInt(typeIdx) else TYPE_INBOX
        if (type == TYPE_DRAFT) continue // skip drafts

        out.add(
          mapOf(
            "id" to (if (idIdx >= 0) c.getLong(idIdx).toInt() else 0),
            "threadId" to (if (threadIdx >= 0) c.getLong(threadIdx).toInt() else threadId),
            "address" to (if (addressIdx >= 0) c.getString(addressIdx) ?: "" else ""),
            "body" to (if (bodyIdx >= 0) c.getString(bodyIdx) ?: "" else ""),
            // content://sms date is epoch MILLISECONDS already.
            "date" to (if (dateIdx >= 0) c.getLong(dateIdx).toDouble() else 0.0),
            "isFromMe" to (type != TYPE_INBOX),
            "status" to statusFromType(type),
            "read" to (if (readIdx >= 0) c.getInt(readIdx) != 0 else false),
            "isMms" to false,
            "attachments" to emptyList<Map<String, Any?>>()
          )
        )
      }
    }
    return out
  }

  /**
   * MMS half of a thread page (newest-first, LIMIT-capped). Non-draft boxes only
   * (msg_box IN 1,2,4,5). CRITICAL: content://mms `date` is epoch SECONDS — it is
   * multiplied by 1000 to emit epoch MS like SMS, and `beforeDateMs` is divided
   * back for the selection. Text/attachment parts and the sender address are
   * resolved in a batched second pass (parts via `mid IN (...)`, a bounded
   * per-row addr lookup for the ≤limit MMS rows on the page).
   */
  private fun queryMmsPage(
    resolver: ContentResolver,
    threadId: Int,
    limit: Int,
    beforeDateMs: Double,
  ): List<Map<String, Any?>> {
    val selection: String
    val args: Array<String>
    if (beforeDateMs > 0) {
      val beforeSec = beforeDateMs.toLong() / 1000L
      selection = "thread_id=? AND msg_box IN (1,2,4,5) AND date<?"
      args = arrayOf(threadId.toString(), beforeSec.toString())
    } else {
      selection = "thread_id=? AND msg_box IN (1,2,4,5)"
      args = arrayOf(threadId.toString())
    }
    val sortOrder = "date DESC LIMIT $limit"
    val projection = arrayOf("_id", "thread_id", "date", "msg_box", "read")

    val ids = ArrayList<Long>()
    val boxes = ArrayList<Int>()
    val rows = ArrayList<HashMap<String, Any?>>()
    resolver.query(Telephony.Mms.CONTENT_URI, projection, selection, args, sortOrder)?.use { c ->
      val idIdx = c.getColumnIndex("_id")
      val threadIdx = c.getColumnIndex("thread_id")
      val dateIdx = c.getColumnIndex("date")
      val boxIdx = c.getColumnIndex("msg_box")
      val readIdx = c.getColumnIndex("read")
      if (idIdx < 0) return@use

      while (c.moveToNext()) {
        val id = c.getLong(idIdx)
        val box = if (boxIdx >= 0) c.getInt(boxIdx) else MMS_BOX_INBOX
        val dateMs = (if (dateIdx >= 0) c.getLong(dateIdx) else 0L) * 1000L // seconds -> ms
        rows.add(
          hashMapOf(
            "id" to id.toInt(),
            "threadId" to (if (threadIdx >= 0) c.getLong(threadIdx).toInt() else threadId),
            "address" to "",
            "body" to "",
            "date" to dateMs.toDouble(),
            "isFromMe" to (box != MMS_BOX_INBOX),
            "status" to mmsStatusFromBox(box),
            "read" to (if (readIdx >= 0) c.getInt(readIdx) != 0 else false),
            "isMms" to true,
            "attachments" to emptyList<Map<String, Any?>>()
          )
        )
        ids.add(id)
        boxes.add(box)
      }
    }
    if (ids.isEmpty()) return emptyList()

    // Batch the parts for the whole page in one query (mid IN (...)).
    val partsByMid = queryMmsParts(resolver, ids)
    for (i in rows.indices) {
      val row = rows[i]
      val id = ids[i]
      partsByMid[id]?.let { p ->
        row["body"] = p.text
        row["attachments"] = p.attachments
      }
      // Sender: inbox -> FROM(137); sent/outbox/failed -> first TO(151) recipient.
      row["address"] = resolveMmsAddress(resolver, id, boxes[i] != MMS_BOX_INBOX)
    }
    return rows
  }

  private data class MmsParts(val text: String, val attachments: List<Map<String, Any?>>)

  /** All non-SMIL parts for a set of MMS ids, grouped by `mid`. Batched (mid IN ...). */
  private fun queryMmsParts(resolver: ContentResolver, ids: List<Long>): Map<Long, MmsParts> {
    val textByMid = HashMap<Long, StringBuilder>()
    val attByMid = HashMap<Long, ArrayList<Map<String, Any?>>>()
    // ids come straight from the provider (Longs) — safe to inline into IN(...).
    val selection = "mid IN (${ids.joinToString(",")})"

    resolver.query(Uri.parse("content://mms/part"), null, selection, null, null)?.use { c ->
      val partIdIdx = c.getColumnIndex("_id")
      val midIdx = c.getColumnIndex("mid")
      val ctIdx = c.getColumnIndex("ct")
      val textIdx = c.getColumnIndex("text")
      val nameIdx = c.getColumnIndex("name")
      val clIdx = c.getColumnIndex("cl")
      val dataIdx = c.getColumnIndex("_data")
      if (midIdx < 0) return@use

      while (c.moveToNext()) {
        val mid = c.getLong(midIdx)
        val ct = (if (ctIdx >= 0) c.getString(ctIdx) else null)?.trim()?.lowercase() ?: ""
        when {
          ct == "application/smil" -> {} // layout part — skip
          ct == "text/plain" -> {
            val partId = if (partIdIdx >= 0) c.getLong(partIdIdx) else -1L
            val inline = if (textIdx >= 0) c.getString(textIdx) else null
            val hasData = dataIdx >= 0 && !c.getString(dataIdx).isNullOrEmpty()
            val text = when {
              !inline.isNullOrEmpty() -> inline
              hasData && partId >= 0 -> readMmsPartText(resolver, partId)
              else -> ""
            }
            if (text.isNotEmpty()) textByMid.getOrPut(mid) { StringBuilder() }.append(text)
          }
          else -> {
            val partId = if (partIdIdx >= 0) c.getLong(partIdIdx) else continue
            val name = ((if (nameIdx >= 0) c.getString(nameIdx) else null)
              ?: (if (clIdx >= 0) c.getString(clIdx) else null)) ?: ""
            attByMid.getOrPut(mid) { ArrayList() }.add(
              mapOf(
                "partId" to partId.toInt(),
                "contentType" to ct,
                "uri" to "content://mms/part/$partId",
                "fileName" to name
              )
            )
          }
        }
      }
    }

    val out = HashMap<Long, MmsParts>()
    (textByMid.keys + attByMid.keys).forEach { mid ->
      out[mid] = MmsParts(
        text = textByMid[mid]?.toString() ?: "",
        attachments = attByMid[mid] ?: emptyList()
      )
    }
    return out
  }

  /** Reads a text/plain MMS part whose body lives in its `_data` file (UTF-8). */
  private fun readMmsPartText(resolver: ContentResolver, partId: Long): String = try {
    resolver.openInputStream(Uri.parse("content://mms/part/$partId"))?.use { stream ->
      stream.readBytes().toString(Charsets.UTF_8)
    } ?: ""
  } catch (_: Exception) {
    ""
  }

  /**
   * Resolves an MMS row's other-party address from content://mms/<id>/addr.
   * Inbox rows read the FROM(137) sender (crucial in group threads); sent rows
   * read the first TO(151) recipient. The `insert-address-token` placeholder
   * (the local user's own slot) is skipped.
   */
  private fun resolveMmsAddress(resolver: ContentResolver, mmsId: Long, isFromMe: Boolean): String {
    val wantType = if (isFromMe) MMS_ADDR_TO else MMS_ADDR_FROM
    resolver.query(
      Uri.parse("content://mms/$mmsId/addr"),
      arrayOf("address", "type"),
      "type=?",
      arrayOf(wantType.toString()),
      null
    )?.use { c ->
      val addrIdx = c.getColumnIndex("address")
      if (addrIdx < 0) return ""
      while (c.moveToNext()) {
        val a = c.getString(addrIdx)
        if (!a.isNullOrBlank() && !a.equals(INSERT_ADDRESS_TOKEN, ignoreCase = true)) return a
      }
    }
    return ""
  }

  private fun mmsStatusFromBox(box: Int): String = when (box) {
    MMS_BOX_INBOX -> "received"
    MMS_BOX_SENT -> "sent"
    MMS_BOX_OUTBOX -> "sending"
    MMS_BOX_FAILED -> "failed"
    else -> "sent"
  }

  /**
   * The other-party address for a thread, taken from its most recent message row. For a
   * 1:1 SMS thread every row (received or sent) carries the same address, so the newest
   * non-blank one is the number to reply to. Returns "" when the thread has no rows.
   */
  private fun getThreadAddress(threadId: Int): String {
    val ctx = requireContext()
    ensurePermission(ctx, Manifest.permission.READ_SMS)
    ctx.contentResolver.query(
      Telephony.Sms.CONTENT_URI,
      arrayOf("address"),
      "thread_id=?",
      arrayOf(threadId.toString()),
      "date DESC"
    )?.use { c ->
      val addrIdx = c.getColumnIndex("address")
      if (addrIdx < 0) return ""
      while (c.moveToNext()) {
        val a = c.getString(addrIdx)
        if (!a.isNullOrBlank()) return a
      }
    }
    return ""
  }

  private fun countUnread(resolver: ContentResolver, threadId: Long): Int {
    resolver.query(
      Telephony.Sms.CONTENT_URI,
      arrayOf("_id"),
      "thread_id=? AND read=0 AND type=$TYPE_INBOX",
      arrayOf(threadId.toString()),
      null
    )?.use { c -> return c.count }
    return 0
  }

  /** Unread INBOX MMS count for a thread (folded into the thread's unreadCount). */
  private fun countUnreadMms(resolver: ContentResolver, threadId: Long): Int {
    resolver.query(
      Telephony.Mms.CONTENT_URI,
      arrayOf("_id"),
      "thread_id=? AND read=0 AND msg_box=$MMS_BOX_INBOX",
      arrayOf(threadId.toString()),
      null
    )?.use { c -> return c.count }
    return 0
  }

  /** Builds an id -> address cache from content://mms-sms/canonical-addresses. */
  private fun loadCanonicalAddresses(resolver: ContentResolver): Map<String, String> {
    val map = HashMap<String, String>()
    resolver.query(
      Uri.parse("content://mms-sms/canonical-addresses"),
      null,
      null,
      null,
      null
    )?.use { c ->
      val idIdx = c.getColumnIndex("_id")
      val addrIdx = c.getColumnIndex("address")
      if (idIdx < 0 || addrIdx < 0) return@use
      while (c.moveToNext()) {
        map[c.getString(idIdx) ?: continue] = c.getString(addrIdx) ?: ""
      }
    }
    return map
  }

  private fun statusFromType(type: Int): String = when (type) {
    TYPE_INBOX -> "received"
    TYPE_SENT -> "sent"
    TYPE_OUTBOX, TYPE_QUEUED -> "sending"
    TYPE_FAILED -> "failed"
    else -> "sent"
  }

  // endregion

  // region Send

  private fun sendSms(address: String, body: String, promise: Promise) {
    val ctx = requireContext()
    ensurePermission(ctx, Manifest.permission.SEND_SMS)

    val smsManager = getSmsManager(ctx)
    val parts = smsManager.divideMessage(body)
    val partCount = parts.size
    if (partCount == 0) {
      promise.resolve(null)
      return
    }

    // Unique per-send action + request-code base so concurrent sends never collide.
    val token = UUID.randomUUID().toString()
    val action = SENT_ACTION_PREFIX + token
    val baseRequestCode = token.hashCode() and 0x7fffffff

    val settled = AtomicBoolean(false)
    val successCount = AtomicInteger(0)
    val handler = Handler(Looper.getMainLooper())

    lateinit var receiver: BroadcastReceiver
    val cleanup = {
      try {
        ctx.unregisterReceiver(receiver)
      } catch (_: Exception) {
      }
      handler.removeCallbacksAndMessages(null)
    }

    receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (settled.get()) return
        val code = resultCode
        if (code == Activity.RESULT_OK) {
          if (successCount.incrementAndGet() >= partCount && settled.compareAndSet(false, true)) {
            cleanup()
            promise.resolve(null)
          }
        } else if (settled.compareAndSet(false, true)) {
          cleanup()
          promise.reject("ERR_SMS_SEND", "SMS send failed (result code $code)", null)
        }
      }
    }

    val filter = IntentFilter(action)
    // Self-targeted (own PendingIntent) delivery — NOT a cross-app broadcast, so NOT_EXPORTED.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      ctx.registerReceiver(receiver, filter)
    }

    val piFlags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val sentIntents = ArrayList<PendingIntent>(partCount)
    for (i in 0 until partCount) {
      val intent = Intent(action).setPackage(ctx.packageName)
      sentIntents.add(PendingIntent.getBroadcast(ctx, baseRequestCode + i, intent, piFlags))
    }

    handler.postDelayed({
      if (settled.compareAndSet(false, true)) {
        cleanup()
        promise.reject("ERR_SMS_TIMEOUT", "SMS send timed out after ${SEND_TIMEOUT_MS}ms", null)
      }
    }, SEND_TIMEOUT_MS)

    try {
      smsManager.sendMultipartTextMessage(address, null, parts, sentIntents, null)
    } catch (e: Exception) {
      if (settled.compareAndSet(false, true)) {
        cleanup()
        promise.reject("ERR_SMS_SEND", e.message ?: "sendMultipartTextMessage threw", e)
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun getSmsManager(ctx: Context): SmsManager {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      ctx.getSystemService(SmsManager::class.java)
    } else {
      SmsManager.getDefault()
    }
  }

  // endregion

  // region Incoming receiver

  private fun registerSmsReceiver() {
    if (smsReceiver != null) return
    val ctx = appContext.reactContext ?: return

    val receiver = object : BroadcastReceiver() {
      override fun onReceive(context: Context?, intent: Intent?) {
        if (intent == null || intent.action != Telephony.Sms.Intents.SMS_RECEIVED_ACTION) return
        try {
          // Shared multipart reassembly with the manifest receiver (SmsIntentParser).
          val parsed = SmsIntentParser.parse(intent) ?: return
          // timestampMillis is API 29+; use wall-clock now for broad minSdk 24 safety.
          val date = System.currentTimeMillis()
          val threadId = try {
            Telephony.Threads.getOrCreateThreadId(ctx, parsed.address).toInt()
          } catch (_: Exception) {
            -1
          }

          this@DeviceSmsModule.sendEvent(
            EVENT_SMS_RECEIVED,
            mapOf(
              "address" to parsed.address,
              "body" to parsed.body,
              "date" to date.toDouble(),
              "threadId" to threadId
            )
          )
        } catch (_: Exception) {
          // Never crash a system broadcast; a dropped event still arrives on next sync.
        }
      }
    }

    val filter = IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION)
    // SMS_RECEIVED is a protected SYSTEM broadcast -> RECEIVER_EXPORTED required on API 34+.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      ctx.registerReceiver(receiver, filter, Context.RECEIVER_EXPORTED)
    } else {
      @Suppress("UnspecifiedRegisterReceiverFlag")
      ctx.registerReceiver(receiver, filter)
    }
    smsReceiver = receiver
  }

  private fun unregisterSmsReceiver() {
    val r = smsReceiver ?: return
    try {
      appContext.reactContext?.unregisterReceiver(r)
    } catch (_: Exception) {
    }
    smsReceiver = null
  }

  // endregion

  // region Provider observer

  /**
   * Observes content://mms-sms/ (with descendants) and emits a debounced
   * `onProviderChanged` on ANY SMS/MMS mutation — the live-refresh path that
   * catches incoming MMS after the default SMS app downloads it. onChange runs
   * on a dedicated HandlerThread (a ContentObserver needs a Handler); the
   * Handler both dispatches onChange and hosts the debounce.
   */
  private fun registerProviderObserver() {
    if (providerObserver != null) return
    val ctx = appContext.reactContext ?: return

    val thread = HandlerThread("DeviceSmsProviderObserver").apply { start() }
    val handler = Handler(thread.looper)
    val emit = Runnable {
      try {
        this@DeviceSmsModule.sendEvent(EVENT_PROVIDER_CHANGED, emptyMap<String, Any?>())
      } catch (_: Exception) {
        // Never let an emit failure escape the observer thread.
      }
    }
    val observer = object : ContentObserver(handler) {
      override fun onChange(selfChange: Boolean) {
        handler.removeCallbacks(emit)
        handler.postDelayed(emit, PROVIDER_DEBOUNCE_MS)
      }

      override fun onChange(selfChange: Boolean, uri: Uri?) = onChange(selfChange)
    }

    try {
      ctx.contentResolver.registerContentObserver(
        Uri.parse("content://mms-sms/"),
        true, // notifyForDescendants — catch content://sms + content://mms mutations too
        observer
      )
      providerObserver = observer
      observerThread = thread
    } catch (_: Exception) {
      thread.quitSafely()
    }
  }

  private fun unregisterProviderObserver() {
    val o = providerObserver
    if (o != null) {
      try {
        appContext.reactContext?.contentResolver?.unregisterContentObserver(o)
      } catch (_: Exception) {
      }
      providerObserver = null
    }
    observerThread?.quitSafely()
    observerThread = null
  }

  // endregion

  // region Helpers

  private fun requireContext(): Context =
    appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun ensurePermission(ctx: Context, permission: String) {
    if (ctx.checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
      throw SmsPermissionException(permission)
    }
  }

  // endregion
}

/** Missing runtime SMS permission -> stable JS code ERR_SMS_PERMISSION. */
private class SmsPermissionException(permission: String) :
  CodedException("ERR_SMS_PERMISSION", "Missing SMS permission: $permission", null)
