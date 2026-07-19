const test = require("node:test")
const assert = require("node:assert")
const core = require("../core.js")

test("startOfLocalDay validates and converts a date", () => {
  const timestamp = core.startOfLocalDay("2026-07-19")
  const date = new Date(timestamp * 1000)
  assert.strictEqual(date.getFullYear(), 2026)
  assert.strictEqual(date.getMonth(), 6)
  assert.strictEqual(date.getDate(), 19)
})

test("selectNewVideos filters by favorite time and deduplicates bvid", () => {
  const videos = [
    { bvid: "BV-old", fav_time: 99 },
    { bvid: "BV-new", fav_time: 110 },
    { bvid: "BV-new", fav_time: 120 },
    { bvid: "BV-done", fav_time: 130 },
  ]
  const result = core.selectNewVideos(videos, 100, { "BV-done": { status: "success" } })
  assert.deepStrictEqual(result, [{ bvid: "BV-new", fav_time: 120 }])
})

test("Getnote response helpers accept known response shapes", () => {
  assert.strictEqual(core.extractGetnoteTaskId({ data: { task_id: "task-1" } }), "task-1")
  assert.strictEqual(core.extractGetnoteNoteId({ data: { note_id: 123 } }), 123)
  assert.strictEqual(core.isGetnoteDuplicate({ data: { duplicate_count: 1 } }), true)
})

test("Getnote response helpers accept nested and camelCase response shapes", () => {
  assert.strictEqual(
    core.extractGetnoteTaskId({ data: { results: [{ taskId: "task-nested" }] } }),
    "task-nested",
  )
  assert.strictEqual(
    core.extractGetnoteNoteId({ data: { result: { resourceId: "note-nested" } } }),
    "note-nested",
  )
  assert.strictEqual(core.isGetnoteDuplicate({ result: { duplicateCount: 2 } }), true)
  assert.strictEqual(core.extractGetnoteNoteId({ data: { note_ids: [456] } }), 456)
  assert.strictEqual(core.extractGetnoteTaskStatus({ data: { taskStatus: "COMPLETED" } }), "completed")
})

test("Getnote note IDs retain exact digits from raw JSON", () => {
  const payload = { data: { note_id: 12345678901234568000 } }
  Object.defineProperty(payload, "__rawText", {
    value: '{"data":{"note_id":12345678901234567890}}',
  })
  assert.strictEqual(core.extractGetnoteNoteId(payload), "12345678901234567890")
})
