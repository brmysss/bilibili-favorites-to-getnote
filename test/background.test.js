const test = require("node:test")
const assert = require("node:assert")
const crypto = require("node:crypto")
const fs = require("node:fs")
const vm = require("node:vm")

function loadBackgroundFunctions() {
  const event = { addListener() {} }
  const context = {
    AbortController,
    URL,
    URLSearchParams,
    chrome: {
      alarms: { onAlarm: event },
      runtime: { onInstalled: event, onMessage: event, onStartup: event },
    },
    clearTimeout,
    console,
    fetch,
    importScripts() {},
    setTimeout,
    SyncCore: {},
  }
  vm.createContext(context)
  vm.runInContext(fs.readFileSync("background.js", "utf8"), context)
  return context
}

test("WBI uses a standards-compliant MD5 implementation", () => {
  const context = loadBackgroundFunctions()
  for (const input of ["", "abc", "中文", "test query"]) {
    const expected = crypto.createHash("md5").update(input).digest("hex")
    assert.strictEqual(context.md5(input), expected)
  }
})
