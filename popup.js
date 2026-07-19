const statusElement = document.querySelector("#status")
const syncButton = document.querySelector("#syncNow")

document.querySelector("#openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage())
syncButton.addEventListener("click", runSync)
refresh()

async function request(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response?.ok) throw new Error(response?.error || "操作失败")
  return response.result
}

async function refresh() {
  try {
    const state = await request({ type: "getStatus" })
    document.querySelector("#syncedCount").textContent = state.syncedCount
    document.querySelector("#lastResult").textContent = state.lastSync?.successCount ?? 0
    syncButton.disabled = state.running
    statusElement.textContent = describeStatus(state)
    renderLogs(state.logs)
  } catch (error) {
    statusElement.textContent = error.message
    statusElement.className = "status error"
  }
}

async function runSync() {
  syncButton.disabled = true
  statusElement.textContent = "正在读取收藏视频 ID 并检查新增…"
  try {
    const result = await request({ type: "runSync" })
    if (result.skipped) {
      statusElement.textContent = result.reason
    } else {
      statusElement.textContent = result.baselineCreated
        ? `已建立基线：${result.checkedVideos} 个现有收藏不会同步`
        : `完成：发现 ${result.newCount || 0} 个新增，提交 ${result.submittedCount || 0} 个`
    }
    statusElement.className = "status success"
  } catch (error) {
    statusElement.textContent = error.message
    statusElement.className = "status error"
  } finally {
    syncButton.disabled = false
    await refresh()
  }
}

function describeStatus(state) {
  if (state.iconStatus?.ok === false) return `工具栏图标设置失败：${state.iconStatus.error}`
  if (state.running) return "同步任务正在运行"
  if (!state.lastSync) return "尚未运行，请先打开设置完成配置"
  if (state.lastSync.error) return `上次失败：${state.lastSync.error}`
  if (state.lastSync?.baselineCreated) return `基线已建立，共记录 ${state.lastSync.checkedVideos} 个现有收藏`
  return `上次检查 ${state.lastSync.checkedVideos || 0} 个收藏，新增 ${state.lastSync.newCount || 0} 个`
}

function renderLogs(logs) {
  const container = document.querySelector("#logs")
  container.innerHTML = ""
  for (const log of logs.slice(0, 5)) {
    const row = document.createElement("div")
    row.className = `log ${log.level}`
    const title = document.createElement("strong")
    title.textContent = log.title
    const status = document.createElement("span")
    status.textContent = log.status
    row.append(title, status)
    container.append(row)
  }
}
