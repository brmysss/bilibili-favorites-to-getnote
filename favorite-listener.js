let favoriteIntentAt = 0
let lastCapturedUrl = ""
let lastCapturedAt = 0

document.addEventListener(
  "click",
  (event) => {
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    const clickable = target.closest("button, [role='button'], .video-toolbar-left-item, div, span")
    const text = String(clickable?.textContent || "").replace(/\s+/g, "").slice(0, 30)
    const descriptor = `${text} ${clickable?.getAttribute("title") || ""} ${clickable?.getAttribute("aria-label") || ""}`

    if (descriptor.includes("收藏") && !descriptor.includes("取消收藏")) {
      favoriteIntentAt = Date.now()
      setTimeout(captureCurrentVideo, 1200)
      return
    }
    if (/^(确定|确认|完成)$/.test(text) && Date.now() - favoriteIntentAt < 120_000) {
      setTimeout(captureCurrentVideo, 800)
    }
  },
  true,
)

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "captureCurrentVideo") return false
  captureCurrentVideo()
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }),
    )
  return true
})

async function captureCurrentVideo() {
  const match = location.pathname.match(/\/video\/(BV[\w]+|av\d+)/i)
  if (!match) throw new Error("当前页面不是可识别的 B站视频")
  const canonicalUrl = `https://www.bilibili.com/video/${match[1]}`
  if (canonicalUrl === lastCapturedUrl && Date.now() - lastCapturedAt < 10_000) {
    return { skipped: true }
  }
  lastCapturedUrl = canonicalUrl
  lastCapturedAt = Date.now()
  const response = await chrome.runtime.sendMessage({
    type: "favoriteCaptured",
    url: canonicalUrl,
    title: document.title.replace(/_哔哩哔哩.*$/i, "").trim(),
    capturedAt: Date.now(),
  })
  if (!response?.ok) throw new Error(response?.error || "提交视频链接失败")
  return response.result
}
