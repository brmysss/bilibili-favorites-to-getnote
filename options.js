const fields = {
  startDate: document.querySelector("#startDate"),
  intervalMinutes: document.querySelector("#intervalMinutes"),
  syncAllHistory: document.querySelector("#syncAllHistory"),
  getnoteApiKey: document.querySelector("#getnoteApiKey"),
  getnoteClientId: document.querySelector("#getnoteClientId"),
  getnoteTopicId: document.querySelector("#getnoteTopicId"),
  tags: document.querySelector("#tags"),
}
const messageElement = document.querySelector("#message")

document.querySelector("#save").addEventListener("click", save)
document.querySelector("#testGetnote").addEventListener("click", testGetnote)
document.querySelector("#exportData").addEventListener("click", exportData)
document.querySelector("#importData").addEventListener("click", () =>
  document.querySelector("#importFile").click(),
)
document.querySelector("#importFile").addEventListener("change", importData)

initialize()

async function initialize() {
  const stored = await chrome.storage.local.get("settings")
  const settings = SyncCore.normalizeSettings(stored.settings)
  fields.startDate.value = settings.startDate
  fields.intervalMinutes.value = settings.intervalMinutes
  fields.syncAllHistory.checked = settings.syncAllHistory
  fields.getnoteApiKey.value = settings.getnoteApiKey
  fields.getnoteClientId.value = settings.getnoteClientId
  fields.getnoteTopicId.value = settings.getnoteTopicId
  fields.tags.value = settings.tags.join(", ")
}

function collectSettings() {
  return SyncCore.normalizeSettings({
    startDate: fields.startDate.value,
    intervalMinutes: Number(fields.intervalMinutes.value),
    syncAllHistory: fields.syncAllHistory.checked,
    getnoteApiKey: fields.getnoteApiKey.value.trim(),
    getnoteClientId: fields.getnoteClientId.value.trim(),
    getnoteTopicId: fields.getnoteTopicId.value.trim(),
    tags: fields.tags.value.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean),
  })
}

async function send(message) {
  const response = await Promise.race([
    chrome.runtime.sendMessage(message),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("插件后台20秒未响应，请重新加载插件后重试")), 20_000),
    ),
  ])
  if (!response?.ok) throw new Error(response?.error || "操作失败")
  return response.result
}

async function save() {
  showMessage("正在保存…")
  try {
    SyncCore.startOfLocalDay(fields.startDate.value)
    await send({ type: "saveSettings", settings: collectSettings() })
    showMessage("设置已保存", "success")
  } catch (error) {
    showMessage(error.message, "error")
  }
}

async function testGetnote() {
  showMessage("正在测试连接…")
  try {
    await send({ type: "testGetnote", settings: collectSettings() })
    showMessage("Get笔记连接成功", "success")
  } catch (error) {
    showMessage(error.message, "error")
  }
}

async function exportData() {
  try {
    const stored = await chrome.storage.local.get(null)
    const settings = SyncCore.normalizeSettings(stored.settings)
    const backup = {
      format: "bilibili-getnote-sync-backup",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: {
        dataVersion: stored.dataVersion,
        favoriteBaseline: stored.favoriteBaseline || {},
        syncedVideos: stored.syncedVideos || {},
        logs: stored.logs || [],
        lastSync: stored.lastSync || null,
        settings: {
          ...settings,
          getnoteApiKey: "",
          getnoteClientId: "",
        },
      },
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = `bilibili-getnote-sync-${new Date().toISOString().slice(0, 10)}.json`
    link.click()
    URL.revokeObjectURL(url)
    showMessage("JSON 已导出（不含密钥）", "success")
  } catch (error) {
    showMessage(error.message, "error")
  }
}

async function importData(event) {
  const file = event.target.files?.[0]
  if (!file) return
  try {
    const backup = JSON.parse(await file.text())
    if (backup?.format !== "bilibili-getnote-sync-backup" || !backup.data) {
      throw new Error("不是有效的插件备份文件")
    }
    const current = await chrome.storage.local.get("settings")
    const currentSettings = SyncCore.normalizeSettings(current.settings)
    const importedSettings = SyncCore.normalizeSettings(backup.data.settings)
    await chrome.storage.local.set({
      dataVersion: backup.data.dataVersion,
      favoriteBaseline: backup.data.favoriteBaseline || {},
      syncedVideos: backup.data.syncedVideos || {},
      logs: backup.data.logs || [],
      lastSync: backup.data.lastSync || null,
      settings: {
        ...importedSettings,
        getnoteApiKey: currentSettings.getnoteApiKey,
        getnoteClientId: currentSettings.getnoteClientId,
      },
    })
    await initialize()
    showMessage("JSON 已导入，现有密钥已保留", "success")
  } catch (error) {
    showMessage(error.message, "error")
  } finally {
    event.target.value = ""
  }
}

function showMessage(text, type = "") {
  messageElement.textContent = text
  messageElement.className = type || "muted"
}
