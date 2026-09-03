package expo.modules.gatorshareshortcuts

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class LegacyShortcutCleanupTest {
  @Test
  fun `pinned private metadata is replaced before the shortcut is disabled`() {
    val store = FakeShortcutStore(
      listOf(
        state(
          id = "private-chat-id",
          isPinned = true,
          shortLabel = "Private conversation",
          longLabel = "Private conversation",
          disabledMessage = "Private conversation",
          categories = setOf("com.bluegreengatorapps.messages.category.SHARE_TARGET"),
        ),
      ),
    )

    clearLegacyShareShortcuts(store)

    assertEquals(
      listOf(
        "list#1",
        "replace:private-chat-id",
        "disable:private-chat-id",
        "removeDynamic",
        "removeLongLived:private-chat-id",
        "list#2",
      ),
      store.calls,
    )
    assertEquals(listOf(RetiredShortcutSpec("private-chat-id")), store.replacements)
    val retired = store.states.single()
    assertTrue(retired.isPinned)
    assertFalse(retired.isEnabled)
    assertTrue(retired.hasRetiredMetadata())
  }

  @Test
  fun `dynamic cached and pinned ids are de-duplicated before removal`() {
    val store = FakeShortcutStore(
      listOf(
        state(id = "both", isDynamic = true),
        state(id = "both", isCached = true),
        state(id = "pinned", isPinned = true, shortLabel = "Secret"),
      ),
    )

    clearLegacyShareShortcuts(store)

    assertEquals(listOf("pinned"), store.replacements.map { it.id })
    assertEquals(listOf("pinned"), store.disabledIds)
    assertEquals(listOf("both", "pinned"), store.removedLongLivedIds)
    assertTrue(store.states.none { it.isDynamic || it.isCached })
  }

  @Test
  fun `a rejected metadata update fails before private pinned data is disabled`() {
    val store = FakeShortcutStore(
      listOf(state(id = "pinned", isPinned = true, shortLabel = "Secret")),
      replaceResult = false,
    )

    val error = expectFailure { clearLegacyShareShortcuts(store) }

    assertTrue(error.message.orEmpty().contains("could not replace 1 pinned shortcut"))
    assertEquals(listOf("list#1", "replace:pinned"), store.calls)
    assertTrue(store.states.single().isEnabled)
  }

  @Test
  fun `enabled or incompletely marked pinned rows are always scrubbed`() {
    val retired = state(
      id = "enabled-marker",
      isPinned = true,
      shortLabel = RETIRED_SHORTCUT_LABEL,
      longLabel = RETIRED_SHORTCUT_LABEL,
      disabledMessage = RETIRED_SHORTCUT_DISABLED_MESSAGE,
      categories = setOf(RETIRED_SHORTCUT_CATEGORY),
      retirementMarker = "1",
      locusId = "gator-retired-shortcut",
      intentIsGeneric = true,
    )
    val store = FakeShortcutStore(
      listOf(
        retired,
        retired.copy(id = "missing-marker", isEnabled = false, retirementMarker = null),
        retired.copy(
          id = "leftover-category",
          isEnabled = false,
          categories = setOf(
            RETIRED_SHORTCUT_CATEGORY,
            "com.bluegreengatorapps.messages.category.SHARE_TARGET",
          ),
        ),
        retired.copy(id = "short-label", isEnabled = false, shortLabel = "Secret"),
        retired.copy(id = "long-label", isEnabled = false, longLabel = "Secret"),
        retired.copy(id = "disabled-message", isEnabled = false, disabledMessage = "Secret"),
        retired.copy(id = "private-locus", isEnabled = false, locusId = "private-chat-id"),
        retired.copy(id = "private-intent", isEnabled = false, intentIsGeneric = false),
      ),
    )

    clearLegacyShareShortcuts(store)

    assertEquals(
      listOf(
        "enabled-marker",
        "missing-marker",
        "leftover-category",
        "short-label",
        "long-label",
        "disabled-message",
        "private-locus",
        "private-intent",
      ),
      store.replacements.map { it.id },
    )
    assertEquals(listOf("enabled-marker"), store.disabledIds)
    assertTrue(store.states.all { it.hasRetiredMetadata() && !it.isEnabled })
  }

  @Test
  fun `a stale postcondition cannot report cleanup success`() {
    val store = FakeShortcutStore(
      listOf(state(id = "pinned", isPinned = true, shortLabel = "Secret")),
      retainPrivateMetadata = true,
    )

    val error = expectFailure { clearLegacyShareShortcuts(store) }

    assertTrue(error.message.orEmpty().contains("left 1 unsafe persisted shortcut"))
    assertFalse(store.states.single().isEnabled)
    assertEquals("Secret", store.states.single().shortLabel)
  }

  @Test
  fun `normal returning but ineffective native mutations fail the postcondition`() {
    val cases = listOf(
      "disable" to state(
        id = "pinned",
        isPinned = true,
        shortLabel = RETIRED_SHORTCUT_LABEL,
        longLabel = RETIRED_SHORTCUT_LABEL,
        disabledMessage = RETIRED_SHORTCUT_DISABLED_MESSAGE,
        categories = setOf(RETIRED_SHORTCUT_CATEGORY),
        retirementMarker = "1",
        locusId = "gator-retired-shortcut",
        intentIsGeneric = true,
      ),
      "removeDynamic" to state(id = "dynamic", isDynamic = true),
      "removeLongLived" to state(id = "cached", isCached = true),
    )

    cases.forEach { (ineffectiveOperation, initial) ->
      val store = FakeShortcutStore(
        listOf(initial),
        ineffectiveOperations = setOf(ineffectiveOperation),
      )

      val error = expectFailure { clearLegacyShareShortcuts(store) }

      assertTrue(error.message.orEmpty().contains("left 1 unsafe persisted shortcut"))
    }
  }

  @Test
  fun `every native store failure propagates instead of claiming success`() {
    val cases = listOf(
      "list#1" to listOf(state(id = "dynamic", isDynamic = true)),
      "replace" to listOf(state(id = "pinned", isPinned = true, shortLabel = "Secret")),
      "disable" to listOf(
        state(
          id = "pinned",
          isPinned = true,
          shortLabel = RETIRED_SHORTCUT_LABEL,
          longLabel = RETIRED_SHORTCUT_LABEL,
          disabledMessage = RETIRED_SHORTCUT_DISABLED_MESSAGE,
          retirementMarker = "1",
          locusId = "gator-retired-shortcut",
          intentIsGeneric = true,
        ),
      ),
      "removeDynamic" to listOf(state(id = "dynamic", isDynamic = true)),
      "removeLongLived" to listOf(state(id = "cached", isCached = true)),
      "list#2" to emptyList(),
    )

    cases.forEach { (failurePoint, initial) ->
      val store = FakeShortcutStore(initial, failurePoint = failurePoint)
      val error = expectFailure { clearLegacyShareShortcuts(store) }
      assertEquals("boom:$failurePoint", error.message)
    }
  }

  @Test
  fun `cleanup is idempotent once only a generic disabled pinned copy remains`() {
    val store = FakeShortcutStore(
      listOf(state(id = "pinned", isPinned = true, shortLabel = "Secret")),
    )

    clearLegacyShareShortcuts(store)
    store.resetTrace()

    clearLegacyShareShortcuts(store)

    assertTrue(store.replacements.isEmpty())
    assertTrue(store.disabledIds.isEmpty())
    assertEquals(
      listOf("list#1", "removeDynamic", "removeLongLived:pinned", "list#2"),
      store.calls,
    )
  }
}

private class FakeShortcutStore(
  initial: List<LegacyShortcutState>,
  private val replaceResult: Boolean = true,
  private val retainPrivateMetadata: Boolean = false,
  private val failurePoint: String? = null,
  private val ineffectiveOperations: Set<String> = emptySet(),
) : LegacyShortcutStore {
  val states = initial.toMutableList()
  val calls = mutableListOf<String>()
  val replacements = mutableListOf<RetiredShortcutSpec>()
  val disabledIds = mutableListOf<String>()
  val removedLongLivedIds = mutableListOf<String>()
  private var listCount = 0

  fun resetTrace() {
    calls.clear()
    replacements.clear()
    disabledIds.clear()
    removedLongLivedIds.clear()
    listCount = 0
  }

  override fun list(): List<LegacyShortcutState> {
    listCount += 1
    record("list#$listCount")
    return states.toList()
  }

  override fun replacePinnedWithRetiredMetadata(
    replacements: List<RetiredShortcutSpec>,
  ): Boolean {
    record("replace:${replacements.joinToString(",") { it.id }}", "replace")
    this.replacements += replacements
    if (!replaceResult) return false
    if (!retainPrivateMetadata) {
      replacements.forEach { replacement ->
        states.replaceAll { current ->
          if (current.id != replacement.id) current
          else current.copy(
            shortLabel = replacement.shortLabel,
            longLabel = replacement.longLabel,
            disabledMessage = replacement.disabledMessage,
            categories = setOf(RETIRED_SHORTCUT_CATEGORY),
            retirementMarker = "1",
            locusId = replacement.locusId,
            intentIsGeneric = true,
          )
        }
      }
    }
    return true
  }

  override fun disablePinned(ids: List<String>) {
    record("disable:${ids.joinToString(",")}", "disable")
    disabledIds += ids
    if ("disable" !in ineffectiveOperations) {
      states.replaceAll { current ->
        if (current.id in ids) current.copy(isEnabled = false, isDynamic = false) else current
      }
    }
  }

  override fun removeAllDynamic() {
    record("removeDynamic")
    if ("removeDynamic" !in ineffectiveOperations) {
      states.replaceAll { current -> current.copy(isDynamic = false) }
    }
  }

  override fun removeLongLived(ids: List<String>) {
    record("removeLongLived:${ids.joinToString(",")}", "removeLongLived")
    removedLongLivedIds += ids
    if ("removeLongLived" !in ineffectiveOperations) {
      states.replaceAll { current ->
        if (current.id in ids) current.copy(isCached = false) else current
      }
    }
  }

  private fun record(call: String, genericCall: String = call) {
    calls += call
    if (failurePoint == call || failurePoint == genericCall) error("boom:$failurePoint")
  }
}

private fun state(
  id: String,
  isDynamic: Boolean = false,
  isCached: Boolean = false,
  isPinned: Boolean = false,
  isEnabled: Boolean = true,
  shortLabel: String = "",
  longLabel: String? = null,
  disabledMessage: String? = null,
  categories: Set<String> = emptySet(),
  retirementMarker: String? = null,
  locusId: String? = null,
  intentIsGeneric: Boolean = false,
): LegacyShortcutState = LegacyShortcutState(
  id = id,
  isDynamic = isDynamic,
  isCached = isCached,
  isPinned = isPinned,
  isEnabled = isEnabled,
  shortLabel = shortLabel,
  longLabel = longLabel,
  disabledMessage = disabledMessage,
  categories = categories,
  retirementMarker = retirementMarker,
  locusId = locusId,
  intentIsGeneric = intentIsGeneric,
)

private fun expectFailure(block: () -> Unit): Throwable {
  try {
    block()
  } catch (error: Throwable) {
    return error
  }
  fail("Expected cleanup to fail closed")
  error("unreachable")
}
