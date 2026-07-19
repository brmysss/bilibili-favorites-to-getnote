importScripts("core.js")

const ALARM_NAME = "bilibili-getnote-sync"
const PENDING_ALARM_NAME = "bilibili-getnote-pending"
const MAX_LOGS = 200
const DATA_VERSION = "lossless-note-id-topic-v3"
let syncing = false
let getnoteRequestChain = Promise.resolve()
let lastGetnoteRequestAt = 0

async function setToolbarIcon() {
  try {
    await chrome.action.setIcon({ path: "icons/icon-32.png" })
    await chrome.storage.local.set({
      iconStatus: { ok: true, updatedAt: new Date().toISOString() },
    })
  } catch (error) {
    await chrome.storage.local.set({
      iconStatus: {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      },
    })
    throw error
  }
}

setToolbarIcon().catch(() => undefined)

async function ensureDataVersion() {
  const stored = await chrome.storage.local.get(["dataVersion", "syncedVideos"])
  if (stored.dataVersion === DATA_VERSION) return
  const syncedVideos = stored.syncedVideos || {}
  for (const record of Object.values(syncedVideos)) {
    record.topicArchived = false
    record.noteIdExact = false
  }
  await chrome.storage.local.set({
    dataVersion: DATA_VERSION,
    logs: [],
    lastSync: null,
    syncRuntime: { running: false },
    syncedVideos,
  })
}

chrome.runtime.onInstalled.addListener(async (details) => {
  await setToolbarIcon()
  const stored = await chrome.storage.local.get("settings")
  const settings = SyncCore.normalizeSettings(stored.settings)
  await chrome.storage.local.set({ settings })
  if (details.reason === "update") {
    await chrome.storage.local.set({ logs: [], lastSync: null, syncRuntime: { running: false } })
  }
  await resetAlarm(settings.intervalMinutes)
})

chrome.runtime.onStartup.addListener(async () => {
  await setToolbarIcon()
  await ensureDataVersion()
  const settings = await loadSettings()
  await resetAlarm(settings.intervalMinutes)
  await runSync("startup")
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === PENDING_ALARM_NAME) runSync("alarm")
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handlers = {
    getStatus,
    runSync: () => runSync("manual"),
    syncCurrentVideo,
    saveSettings: () => saveSettings(message.settings),
    testGetnote: () => testGetnote(message.settings),
    favoriteCaptured: () => captureVideo(message),
  }
  const handler = handlers[message?.type]
  if (!handler) return false
  handler()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: readableError(error) }))
  return true
})

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings")
  return SyncCore.normalizeSettings(stored.settings)
}

async function saveSettings(value) {
  const settings = SyncCore.normalizeSettings(value)
  SyncCore.startOfLocalDay(settings.startDate)
  await chrome.storage.local.set({ settings })
  await resetAlarm(settings.intervalMinutes)
  return sanitizeSettings(settings)
}

function sanitizeSettings(settings) {
  return {
    ...settings,
    getnoteApiKey: settings.getnoteApiKey ? "已配置" : "",
    getnoteClientId: settings.getnoteClientId ? "已配置" : "",
  }
}

async function resetAlarm(intervalMinutes) {
  await chrome.alarms.clear(ALARM_NAME)
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: Math.min(intervalMinutes, 1),
    periodInMinutes: intervalMinutes,
  })
}

const WBI_MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33,
  9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0,
  1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]
let cachedWbi = null

async function bilibiliGet(path, params = {}, options = {}) {
  const requestParams = options.sign ? await signWbiParams(params) : params
  const url = new URL(path, "https://api.bilibili.com")
  Object.entries(requestParams).forEach(([key, value]) => url.searchParams.set(key, String(value)))
  const result = options.background
    ? await backgroundBilibiliFetch(url)
    : await pageBilibiliFetch(url)
  const payload = result.payload
  if (!result.ok || !payload || payload.code !== 0) {
    const endpoint = path.split("?")[0]
    const detail = payload?.message || result.error || `HTTP ${result.status}`
    throw new Error(`B站接口 ${endpoint} 失败：${detail}`)
  }
  return payload.data
}

async function backgroundBilibiliFetch(url) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 15_000)
  let response
  try {
    response = await fetch(url, {
      credentials: "include",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, */*",
        Referer: "https://www.bilibili.com/",
      },
    })
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("B站接口15秒未响应，请确认已登录后重试")
    throw error
  } finally {
    clearTimeout(timeout)
  }
  const payload = await response.json().catch(() => null)
  return { ok: response.ok, status: response.status, payload }
}

async function pageBilibiliFetch(url) {
  const user = await currentBilibiliUser()
  const tab = await ensureBilibiliFavoriteTab(user.mid)
  try {
    const response = await sendPageFetch(tab.id, url)
    const payload = response?.text ? JSON.parse(response.text) : null
    return { ...response, payload }
  } catch (error) {
    throw new Error(
      `无法通过 B站页面读取接口：${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

async function sendPageFetch(tabId, url) {
  const message = { type: "bilibiliPageFetch", url: url.toString() }
  try {
    return await chrome.tabs.sendMessage(tabId, message)
  } catch {
    await chrome.tabs.reload(tabId)
    await waitForContentBridge(tabId)
    return chrome.tabs.sendMessage(tabId, message)
  }
}

async function ensureBilibiliFavoriteTab(mid) {
  const tabs = await chrome.tabs.query({ url: ["https://space.bilibili.com/*"] })
  const existing = tabs.find(
    (tab) => tab.id && tab.status === "complete" && String(tab.url || "").includes(`/${mid}/favlist`),
  )
  if (existing) return existing

  const created = await chrome.tabs.create({
    url: `https://space.bilibili.com/${encodeURIComponent(mid)}/favlist`,
    active: false,
  })
  return waitForContentBridge(created.id)
}

async function waitForContentBridge(tabId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const tab = await chrome.tabs.get(tabId)
    if (tab.status === "complete") {
      try {
        const response = await chrome.tabs.sendMessage(tabId, { type: "bridgePing" })
        if (response?.ok) return tab
      } catch {
        // The content script may need one more event-loop turn after page completion.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error("打开 B站收藏页面超时")
}

async function signWbiParams(params) {
  const { mixinKey } = await getWbiKey()
  const signed = { ...params, wts: Math.floor(Date.now() / 1000) }
  const query = Object.keys(signed)
    .sort()
    .map((key) => {
      const value = String(signed[key]).replace(/[!'()*]/g, "")
      return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`
    })
    .join("&")
  return { ...signed, w_rid: md5(query + mixinKey) }
}

async function getWbiKey() {
  if (cachedWbi && Date.now() - cachedWbi.cachedAt < 30 * 60 * 1000) return cachedWbi
  const data = await bilibiliGet("/x/web-interface/nav", {}, { background: true })
  const imgKey = filenameWithoutExtension(data?.wbi_img?.img_url)
  const subKey = filenameWithoutExtension(data?.wbi_img?.sub_url)
  if (!imgKey || !subKey) throw new Error("无法取得 B站 WBI 签名密钥")
  const source = imgKey + subKey
  const mixinKey = WBI_MIXIN_KEY_ENC_TAB.map((index) => source[index] || "").join("").slice(0, 32)
  cachedWbi = { mixinKey, cachedAt: Date.now() }
  return cachedWbi
}

function filenameWithoutExtension(url) {
  return String(url || "").split("/").pop()?.split(".")[0] || ""
}

function md5(input) {
  function add(x, y) {
    const low = (x & 0xffff) + (y & 0xffff)
    const high = (x >> 16) + (y >> 16) + (low >> 16)
    return ((high << 16) | (low & 0xffff)) | 0
  }
  function rotate(value, shift) {
    return (value << shift) | (value >>> (32 - shift))
  }
  function cmn(q, a, b, x, s, t) {
    return add(rotate(add(add(a, q), add(x, t)), s), b)
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t) }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t) }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t) }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t) }
  const bytes = unescape(encodeURIComponent(input))
  const words = []
  for (let i = 0; i < bytes.length; i += 1) words[i >> 2] = (words[i >> 2] || 0) | (bytes.charCodeAt(i) << ((i % 4) * 8))
  words[bytes.length >> 2] = (words[bytes.length >> 2] || 0) | (0x80 << ((bytes.length % 4) * 8))
  words[(((bytes.length + 8) >> 6) + 1) * 16 - 2] = bytes.length * 8
  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878
  const shifts = [7,12,17,22,5,9,14,20,4,11,16,23,6,10,15,21]
  const constants = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) | 0)
  for (let offset = 0; offset < words.length; offset += 16) {
    const oldA = a, oldB = b, oldC = c, oldD = d
    for (let i = 0; i < 64; i += 1) {
      let f, index, shift
      if (i < 16) { f = ff; index = i; shift = shifts[i % 4] }
      else if (i < 32) { f = gg; index = (5 * i + 1) % 16; shift = shifts[4 + (i % 4)] }
      else if (i < 48) { f = hh; index = (3 * i + 5) % 16; shift = shifts[8 + (i % 4)] }
      else { f = ii; index = (7 * i) % 16; shift = shifts[12 + (i % 4)] }
      const next = f(a, b, c, d, words[offset + index] || 0, shift, constants[i])
      a = d; d = c; c = b; b = next
    }
    a = add(a, oldA); b = add(b, oldB); c = add(c, oldC); d = add(d, oldD)
  }
  return [a, b, c, d]
    .map((value) => [0, 8, 16, 24].map((shift) => ((value >>> shift) & 0xff).toString(16).padStart(2, "0")).join(""))
    .join("")
}

async function currentBilibiliUser() {
  const cookie = await chrome.cookies.get({ url: "https://www.bilibili.com/", name: "DedeUserID" })
  if (!cookie?.value) throw new Error("请先在当前浏览器登录 B站")
  return { mid: String(cookie.value), name: `UID ${cookie.value}` }
}

async function listFolders() {
  const user = await currentBilibiliUser()
  const data = await bilibiliGet(
    "/x/v3/fav/folder/created/list-all",
    { up_mid: user.mid, web_location: 333.1387 },
    { background: true },
  )
  const folders = (data?.list || []).map((folder) => ({
    id: String(folder.id),
    title: folder.title,
    mediaCount: Number(folder.media_count || 0),
  }))
  return { user, folders }
}

async function fetchFavoriteIds(folder) {
  const data = await bilibiliGet(
    "/x/v3/fav/resource/ids",
    { media_id: folder.id },
    { background: true },
  )
  return (Array.isArray(data) ? data : []).map((item) => ({
    id: String(item.id),
    type: Number(item.type || 2),
    folderId: folder.id,
    folderTitle: folder.title,
  }))
}

function getnoteHeaders(settings) {
  if (!settings.getnoteApiKey || !settings.getnoteClientId) {
    throw new Error("请先配置 Get笔记 API Key 和 Client ID")
  }
  return {
    Authorization: settings.getnoteApiKey,
    "X-Client-ID": settings.getnoteClientId,
    "Content-Type": "application/json",
  }
}

function getnoteRequest(path, settings, options = {}) {
  const job = getnoteRequestChain
    .catch(() => undefined)
    .then(() => performGetnoteRequest(path, settings, options))
  getnoteRequestChain = job.catch(() => undefined)
  return job
}

async function performGetnoteRequest(path, settings, options) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const spacing = Math.max(0, 800 - (Date.now() - lastGetnoteRequestAt))
    if (spacing > 0) await new Promise((resolve) => setTimeout(resolve, spacing))
    const response = await fetch(`https://openapi.biji.com${path}`, {
      ...options,
      headers: { ...getnoteHeaders(settings), ...(options.headers || {}) },
    })
    lastGetnoteRequestAt = Date.now()
    const rawText = await response.text()
    const payload = (() => {
      try {
        return JSON.parse(rawText)
      } catch {
        return null
      }
    })()

    const rateLimited =
      response.status === 429 ||
      payload?.error?.reason === "qps_global_exceeded" ||
      payload?.error?.reason === "qps_bucket"
    if (rateLimited && attempt < 4) {
      const retryAfter = Number(response.headers.get("Retry-After") || 0) * 1000
      const backoff = Math.max(retryAfter, 1500 * 2 ** attempt)
      await new Promise((resolve) => setTimeout(resolve, backoff))
      continue
    }

    if (!response.ok || payload?.success === false) {
      const reason = payload?.error?.reason ? `：${payload.error.reason}` : ""
      throw new Error(payload?.error?.message || payload?.message || `Get笔记请求失败${reason}`)
    }
    if (payload && typeof payload === "object") {
      Object.defineProperty(payload, "__rawText", { value: rawText, enumerable: false })
    }
    return payload || {}
  }
  throw new Error("Get笔记请求重试次数已用尽")
}

async function testGetnote(rawSettings) {
  const settings = SyncCore.normalizeSettings(rawSettings)
  const payload = await getnoteRequest("/open/api/v1/resource/knowledge/list?page=1&size=1", settings)
  return { connected: true, success: payload.success !== false }
}

async function saveVideoToGetnote(video, settings) {
  const payload = await getnoteRequest("/open/api/v1/resource/note/save", settings, {
    method: "POST",
    body: JSON.stringify({
      note_type: "link",
      link_url: SyncCore.videoUrl(video),
      tags: settings.tags,
    }),
  })

  if (SyncCore.isGetnoteDuplicate(payload)) {
    const noteId = settings.getnoteTopicId
      ? await findRecentNoteIdByUrl(SyncCore.videoUrl(video), settings)
      : ""
    if (noteId && settings.getnoteTopicId) await addNoteToTopic(noteId, settings)
    return {
      status: "duplicate",
      noteId: String(noteId || ""),
      noteIdExact: Boolean(noteId),
      topicArchived: Boolean(noteId),
    }
  }

  const immediateNoteId = SyncCore.extractGetnoteNoteId(payload)
  const taskId = SyncCore.extractGetnoteTaskId(payload)
  if (immediateNoteId) {
    if (settings.getnoteTopicId) await addNoteToTopic(immediateNoteId, settings)
    return {
      status: "success",
      noteId: String(immediateNoteId),
      noteIdExact: true,
      taskId: "",
      topicArchived: true,
    }
  }
  if (taskId) {
    await schedulePendingCheck()
    return { status: "pending", noteId: "", taskId: String(taskId), topicArchived: false }
  }
  if (!immediateNoteId) {
    throw new Error("Get笔记已接收链接，但返回结果中没有可识别的任务 ID 或笔记 ID")
  }
}

async function checkGetnoteTask(taskId, settings) {
  const payload = await getnoteRequest("/open/api/v1/resource/note/task/progress", settings, {
    method: "POST",
    body: JSON.stringify({ task_id: taskId }),
  })
  const status = SyncCore.extractGetnoteTaskStatus(payload)
  const noteId = SyncCore.extractGetnoteNoteId(payload)
  if (["failed", "failure", "error"].includes(status)) {
    return { status: "failed", noteId: "" }
  }
  if (noteId || ["success", "completed", "complete", "done", "finished"].includes(status)) {
    return { status: noteId ? "success" : "pending", noteId: String(noteId || "") }
  }
  return { status: "pending", noteId: "" }
}

async function addNoteToTopic(noteId, settings) {
  if (!settings.getnoteTopicId) throw new Error("未配置得到大脑目标知识库 ID")
  const payload = await getnoteRequest("/open/api/v1/resource/knowledge/note/batch-add", settings, {
    method: "POST",
    body: JSON.stringify({
      topic_id: String(settings.getnoteTopicId),
      note_ids: [String(noteId)],
    }),
  })
  const rawText = payload.__rawText || JSON.stringify(payload)
  const failedCount = Number(
    SyncCore.findNestedValue(payload, ["failed_count", "failure_count", "failedCount"]) || 0,
  )
  const failedNoteIds = SyncCore.findNestedValue(payload, ["failed_note_ids", "failedNoteIds"])
  const hasFailedResult = /"(?:success|ok)"\s*:\s*false/i.test(rawText)
  if (failedCount > 0 || (Array.isArray(failedNoteIds) && failedNoteIds.length > 0) || hasFailedResult) {
    throw new Error(`知识库拒绝加入笔记（noteId=${String(noteId)}）`)
  }
}

async function schedulePendingCheck() {
  await chrome.alarms.create(PENDING_ALARM_NAME, { delayInMinutes: 1 })
}

async function findRecentNoteIdByUrl(url, settings) {
  const targetKey = url.match(/BV[\w]+|av\d+/i)?.[0] || url
  const listPayload = await getnoteRequest("/open/api/v1/resource/note/list?since_id=0", settings)
  const rawListText = listPayload.__rawText || ""
  const targetIndex = rawListText.indexOf(targetKey)
  if (targetIndex >= 0) {
    const nearby = rawListText.slice(Math.max(0, targetIndex - 2500), targetIndex + 2500)
    const exactMatches = [...nearby.matchAll(/"(?:note_id|id)"\s*:\s*(?:"([^"]+)"|(\d+))/g)]
    if (exactMatches.length > 0) {
      const beforeTarget = exactMatches.filter((match) => match.index <= Math.min(2500, targetIndex))
      const closest = beforeTarget.at(-1) || exactMatches[0]
      return String(closest[1] || closest[2])
    }
  }
  const candidates = collectObjects(listPayload)
  for (const candidate of candidates) {
    const serialized = JSON.stringify(candidate)
    if (!serialized.includes(targetKey)) continue
    const noteId = candidateNoteId(candidate)
    if (noteId) return String(noteId)
  }

  const ids = [...new Set(candidates.map(candidateNoteId).filter(Boolean))]
  for (const match of rawListText.matchAll(/"(?:note_id|id)"\s*:\s*(?:"([^"]+)"|(\d+))/g)) {
    const exactId = match[1] || match[2]
    if (exactId && !ids.includes(exactId)) ids.push(exactId)
  }
  for (const id of ids.slice(0, 40)) {
    try {
      const detail = await getnoteRequest(
        `/open/api/v1/resource/note/detail?id=${encodeURIComponent(id)}`,
        settings,
      )
      if (JSON.stringify(detail).includes(targetKey)) return String(id)
    } catch {
      // Ignore non-note IDs found in wrapper metadata and continue searching.
    }
  }
  return ""
}

function candidateNoteId(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ""
  const explicit = SyncCore.extractGetnoteNoteId(value)
  if (explicit) return explicit
  const looksLikeNote =
    "note_type" in value ||
    "title" in value ||
    "content" in value ||
    "created_at" in value ||
    "created_time" in value
  return looksLikeNote ? value.id || "" : ""
}

function collectObjects(value, output = [], depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return output
  output.push(value)
  for (const child of Object.values(value)) collectObjects(child, output, depth + 1)
  return output
}

async function processPendingTasks(settings, syncedVideos) {
  let completedCount = 0
  let failedCount = 0
  for (const [key, record] of Object.entries(syncedVideos)) {
    if (record.status !== "pending" || !record.taskId) continue
    try {
      const result = await checkGetnoteTask(record.taskId, settings)
      if (result.status === "success" && result.noteId) {
        if (settings.getnoteTopicId) await addNoteToTopic(result.noteId, settings)
        syncedVideos[key] = {
          ...record,
          status: "success",
          noteId: result.noteId,
          noteIdExact: true,
          topicArchived: true,
          completedAt: new Date().toISOString(),
        }
        completedCount += 1
        await appendLog({ level: "success", title: record.title, status: "解析完成并已归档", key })
      } else if (result.status === "failed") {
        syncedVideos[key] = { ...record, status: "failed", failedAt: new Date().toISOString() }
        failedCount += 1
        await appendLog({ level: "error", title: record.title, status: "Get笔记解析失败，将重试", key })
      } else {
        const recoveredNoteId = await findRecentNoteIdByUrl(record.url, settings)
        if (recoveredNoteId) {
          await addNoteToTopic(recoveredNoteId, settings)
          syncedVideos[key] = {
            ...record,
            status: "success",
            noteId: recoveredNoteId,
            noteIdExact: true,
            topicArchived: true,
            completedAt: new Date().toISOString(),
          }
          completedCount += 1
          await appendLog({ level: "success", title: record.title, status: "已反查笔记并补归档", key })
        } else {
          await schedulePendingCheck()
        }
      }
    } catch (error) {
      await appendLog({ level: "error", title: record.title, status: readableError(error), key })
    }
  }
  await chrome.storage.local.set({ syncedVideos })
  await reconcileTopicArchive(settings, syncedVideos)
  return { completedCount, failedCount }
}

async function reconcileTopicArchive(settings, syncedVideos) {
  for (const [key, record] of Object.entries(syncedVideos)) {
    if (record.topicArchived === true || !record.url) continue
    if (!["success", "duplicate"].includes(record.status)) continue
    try {
      const recoveredNoteId = await findRecentNoteIdByUrl(record.url, settings)
      const noteId = recoveredNoteId || (record.noteIdExact ? record.noteId : "")
      if (!noteId) continue
      await addNoteToTopic(noteId, settings)
      syncedVideos[key] = {
        ...record,
        noteId: String(noteId),
        noteIdExact: true,
        topicArchived: true,
        archivedAt: new Date().toISOString(),
      }
      await appendLog({ level: "success", title: record.title, status: "已补加入知识库", key })
    } catch (error) {
      await appendLog({ level: "error", title: record.title, status: `知识库归档失败：${readableError(error)}`, key })
    }
  }
  await chrome.storage.local.set({ syncedVideos })
}

async function auditUnarchivedPluginNotes(settings) {
  const payload = await getnoteRequest("/open/api/v1/resource/note/list?since_id=0", settings)
  const notes = Array.isArray(payload?.data?.notes) ? payload.data.notes : []
  const missing = notes.filter((note) => {
    if (note.note_type !== "link") return false
    const tagsText = JSON.stringify(note.tags || [])
    const createdByPlugin = tagsText.includes("B站收藏") || tagsText.includes("自动同步")
    const alreadyArchived = (note.topics || []).some(
      (topic) => String(topic.id || topic.topic_id) === String(settings.getnoteTopicId),
    )
    return createdByPlugin && !alreadyArchived && note.note_id
  })

  let repairedCount = 0
  for (let index = 0; index < missing.length; index += 20) {
    const batch = missing.slice(index, index + 20)
    const noteIds = batch.map((note) => String(note.note_id))
    const result = await getnoteRequest(
      "/open/api/v1/resource/knowledge/note/batch-add",
      settings,
      {
        method: "POST",
        body: JSON.stringify({
          topic_id: String(settings.getnoteTopicId),
          note_ids: noteIds,
        }),
      },
    )
    const failedIds = SyncCore.findNestedValue(result, ["failed_note_ids", "failedNoteIds"])
    repairedCount += batch.length - (Array.isArray(failedIds) ? failedIds.length : 0)
  }

  if (repairedCount > 0) {
    await appendLog({
      level: "success",
      title: "知识库归档审计",
      status: `发现并补归档 ${repairedCount} 条历史笔记`,
    })
  }
  return repairedCount
}

async function appendLog(entry) {
  const stored = await chrome.storage.local.get("logs")
  const logs = Array.isArray(stored.logs) ? stored.logs : []
  logs.unshift({ time: new Date().toISOString(), ...entry })
  await chrome.storage.local.set({ logs: logs.slice(0, MAX_LOGS) })
}

async function runSync(trigger) {
  await ensureDataVersion()
  const runtimeState = await chrome.storage.local.get("syncRuntime")
  const persistentStartedAt = Date.parse(runtimeState.syncRuntime?.startedAt || "")
  const persistentLockActive =
    runtimeState.syncRuntime?.running &&
    Number.isFinite(persistentStartedAt) &&
    Date.now() - persistentStartedAt < 2 * 60 * 1000
  if (syncing || persistentLockActive) return { skipped: true, reason: "已有同步任务正在运行" }
  syncing = true
  const startedAt = new Date().toISOString()
  await chrome.storage.local.set({ syncRuntime: { running: true, startedAt, trigger } })

  try {
    const settings = await loadSettings()
    getnoteHeaders(settings)
    const auditedCount = await auditUnarchivedPluginNotes(settings)
    const storedBeforeSync = await chrome.storage.local.get("syncedVideos")
    const syncedVideos = storedBeforeSync.syncedVideos || {}
    const pendingResult = await processPendingTasks(settings, syncedVideos)
    const { user, folders } = await listFolders()
    const idBatches = await Promise.all(folders.map(fetchFavoriteIds))
    const currentItems = idBatches.flat()
    const currentByKey = new Map(currentItems.map((item) => [`av${item.id}`, item]))
    const baselineStored = await chrome.storage.local.get("favoriteBaseline")
    let favoriteBaseline = baselineStored.favoriteBaseline || null

    if (!favoriteBaseline && !settings.syncAllHistory) {
      const baseline = Object.fromEntries(
        [...currentByKey.keys()].map((key) => [key, new Date().toISOString()]),
      )
      const summary = {
        trigger,
        mode: "favorite_ids_diff",
        bilibiliUser: user.name,
        checkedFolders: folders.length,
        checkedVideos: currentByKey.size,
        baselineCreated: true,
        submittedCount: 0,
        successCount: 0,
        duplicateCount: 0,
        failedCount: pendingResult.failedCount,
        completedPendingCount: pendingResult.completedCount,
        auditedCount,
        completedAt: new Date().toISOString(),
      }
      await chrome.storage.local.set({ favoriteBaseline: baseline, lastSync: summary })
      return summary
    }

    if (!favoriteBaseline) favoriteBaseline = {}

    const newItems = [...currentByKey.entries()].filter(
      ([key]) =>
        (settings.syncAllHistory || !favoriteBaseline[key]) &&
        !["pending", "success", "duplicate"].includes(syncedVideos[key]?.status),
    )
    let submittedCount = 0
    let successCount = 0
    let duplicateCount = 0
    let failedCount = pendingResult.failedCount

    for (const [key, item] of newItems) {
      const video = {
        id: item.id,
        bvid: "",
        title: `${item.folderTitle} 新收藏 ${key}`,
        fav_time: Math.floor(Date.now() / 1000),
      }
      try {
        const result = await saveVideoToGetnote(video, settings)
        syncedVideos[key] = {
          noteId: result.noteId,
          noteIdExact: result.noteIdExact === true,
          taskId: result.taskId || "",
          status: result.status,
          topicArchived: result.topicArchived === true,
          title: video.title,
          url: SyncCore.videoUrl(video),
          syncedAt: new Date().toISOString(),
        }
        if (result.status === "pending") submittedCount += 1
        else if (result.status === "duplicate") duplicateCount += 1
        else successCount += 1
        await appendLog({ level: "success", title: video.title, status: result.status, key })
      } catch (error) {
        failedCount += 1
        await appendLog({ level: "error", title: video.title, status: readableError(error), key })
      }
    }

    for (const key of currentByKey.keys()) favoriteBaseline[key] ||= new Date().toISOString()
    await chrome.storage.local.set({ favoriteBaseline, syncedVideos })

    const summary = {
      trigger,
      mode: "favorite_ids_diff",
      bilibiliUser: user.name,
      checkedFolders: folders.length,
      checkedVideos: currentByKey.size,
      newCount: newItems.length,
      submittedCount,
      successCount,
      duplicateCount,
      failedCount,
      completedPendingCount: pendingResult.completedCount,
      auditedCount,
      completedAt: new Date().toISOString(),
    }
    await chrome.storage.local.set({ lastSync: summary })
    return summary
  } catch (error) {
    const failure = { trigger, error: readableError(error), completedAt: new Date().toISOString() }
    await chrome.storage.local.set({ lastSync: failure })
    await appendLog({ level: "error", title: "同步任务", status: failure.error })
    throw error
  } finally {
    syncing = false
    await chrome.storage.local.set({ syncRuntime: { running: false } })
  }
}

async function captureVideo(message) {
  const settings = await loadSettings()
  getnoteHeaders(settings)
  await auditUnarchivedPluginNotes(settings)
  const capturedAt = Number(message.capturedAt || Date.now())
  if (capturedAt / 1000 < SyncCore.startOfLocalDay(settings.startDate)) {
    return { skipped: true, reason: "早于同步开始日期" }
  }
  const match = String(message.url || "").match(/\/video\/(BV[\w]+|av\d+)/i)
  if (!match) throw new Error("无法识别 B站视频链接")
  const key = match[1]
  const stored = await chrome.storage.local.get("syncedVideos")
  const syncedVideos = stored.syncedVideos || {}
  if (["pending", "success", "duplicate"].includes(syncedVideos[key]?.status)) {
    return { skipped: true, reason: "该视频已经处理" }
  }
  const video = {
    bvid: key.startsWith("BV") ? key : "",
    id: key.startsWith("av") ? key.slice(2) : "",
    title: message.title || key,
    fav_time: Math.floor(capturedAt / 1000),
  }
  const result = await saveVideoToGetnote(video, settings)
  syncedVideos[key] = {
    noteId: result.noteId,
    noteIdExact: result.noteIdExact === true,
    taskId: result.taskId || "",
    status: result.status,
    topicArchived: result.topicArchived === true,
    title: video.title,
    url: SyncCore.videoUrl(video),
    favoriteTime: video.fav_time,
    syncedAt: new Date().toISOString(),
  }
  await chrome.storage.local.set({ syncedVideos })
  await appendLog({ level: "success", title: video.title, status: result.status, key })
  return result
}

async function syncCurrentVideo() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab?.id || !String(tab.url || "").includes("bilibili.com/video/")) {
    throw new Error("请先打开一个 B站视频页面")
  }
  const response = await chrome.tabs.sendMessage(tab.id, { type: "captureCurrentVideo" })
  if (!response?.ok) throw new Error(response?.error || "无法读取当前视频")
  return response.result
}

async function getStatus() {
  await ensureDataVersion()
  const stored = await chrome.storage.local.get([
    "settings",
    "lastSync",
    "logs",
    "syncedVideos",
    "syncRuntime",
    "iconStatus",
  ])
  return {
    settings: sanitizeSettings(SyncCore.normalizeSettings(stored.settings)),
    lastSync: stored.lastSync || null,
    logs: (stored.logs || []).slice(0, 20),
    syncedCount: Object.keys(stored.syncedVideos || {}).length,
    running: Boolean(stored.syncRuntime?.running),
    iconStatus: stored.iconStatus || null,
  }
}

function readableError(error) {
  return error instanceof Error ? error.message : String(error)
}
