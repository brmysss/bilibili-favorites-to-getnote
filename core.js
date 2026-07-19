const DEFAULT_SETTINGS = Object.freeze({
  startDate: "2026-07-19",
  intervalMinutes: 10,
  folderIds: [],
  syncAllFolders: true,
  syncAllHistory: false,
  getnoteApiKey: "",
  getnoteClientId: "",
  getnoteTopicId: "JOawv65Y",
  tags: ["B站收藏", "自动同步"],
})

function normalizeSettings(value = {}) {
  const interval = Number(value.intervalMinutes)
  const tags = Array.isArray(value.tags)
    ? value.tags.map((tag) => String(tag).trim()).filter(Boolean)
    : DEFAULT_SETTINGS.tags

  return {
    ...DEFAULT_SETTINGS,
    ...value,
    intervalMinutes: Number.isFinite(interval) ? Math.max(1, interval) : 10,
    folderIds: Array.isArray(value.folderIds)
      ? value.folderIds.map(String).filter(Boolean)
      : [],
    syncAllFolders: value.syncAllFolders !== false,
    syncAllHistory: value.syncAllHistory === true,
    getnoteTopicId: String(value.getnoteTopicId || DEFAULT_SETTINGS.getnoteTopicId),
    tags,
  }
}

function startOfLocalDay(dateText) {
  const parts = String(dateText).split("-").map(Number)
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new Error("开始日期格式必须为 YYYY-MM-DD")
  }
  const [year, month, day] = parts
  const date = new Date(year, month - 1, day, 0, 0, 0, 0)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    throw new Error("开始日期无效")
  }
  return Math.floor(date.getTime() / 1000)
}

function videoKey(video) {
  if (video.bvid) return String(video.bvid)
  if (video.id) return `av${video.id}`
  return ""
}

function videoUrl(video) {
  if (video.bvid) return `https://www.bilibili.com/video/${video.bvid}`
  if (video.id) return `https://www.bilibili.com/video/av${video.id}`
  return ""
}

function selectNewVideos(videos, startTimestamp, synced = {}) {
  const unique = new Map()
  for (const video of videos) {
    const key = videoKey(video)
    const favoriteTime = Number(video.fav_time)
    const existingStatus = synced[key]?.status
    const alreadyHandled = ["pending", "success", "duplicate"].includes(existingStatus)
    if (!key || !Number.isFinite(favoriteTime) || favoriteTime < startTimestamp || alreadyHandled) {
      continue
    }
    const existing = unique.get(key)
    if (!existing || Number(existing.fav_time) < favoriteTime) unique.set(key, video)
  }
  return [...unique.values()].sort((left, right) => Number(left.fav_time) - Number(right.fav_time))
}

function findNestedValue(value, keys, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return ""
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null && value[key] !== "") {
      return value[key]
    }
  }
  for (const child of Object.values(value)) {
    const found = findNestedValue(child, keys, depth + 1)
    if (found !== "") return found
  }
  return ""
}

function extractGetnoteTaskId(payload) {
  return findNestedValue(payload, ["task_id", "taskId"])
}

function extractGetnoteNoteId(payload) {
  const rawText = payload?.__rawText
  if (typeof rawText === "string") {
    for (const key of ["note_id", "noteId", "resource_id", "resourceId"]) {
      const match = rawText.match(new RegExp(`"${key}"\\s*:\\s*(?:"([^"]+)"|(\\d+))`))
      if (match) return match[1] || match[2]
    }
  }
  const direct = findNestedValue(payload, ["note_id", "noteId", "resource_id", "resourceId"])
  if (direct) return direct
  const plural = findNestedValue(payload, ["note_ids", "noteIds", "resource_ids", "resourceIds"])
  return Array.isArray(plural) ? plural[0] || "" : ""
}

function extractGetnoteTaskStatus(payload) {
  return String(findNestedValue(payload, ["status", "task_status", "taskStatus"]) || "").toLowerCase()
}

function isGetnoteDuplicate(payload) {
  return Number(findNestedValue(payload, ["duplicate_count", "duplicateCount"]) || 0) > 0
}

if (typeof globalThis !== "undefined") {
  globalThis.SyncCore = {
    DEFAULT_SETTINGS,
    extractGetnoteNoteId,
    extractGetnoteTaskStatus,
    extractGetnoteTaskId,
    findNestedValue,
    isGetnoteDuplicate,
    normalizeSettings,
    selectNewVideos,
    startOfLocalDay,
    videoKey,
    videoUrl,
  }
}

if (typeof module !== "undefined") {
  module.exports = globalThis.SyncCore
}
