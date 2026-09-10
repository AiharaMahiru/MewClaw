import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

const filePath = 'docs/dsh-lark-capability-matrix.html'
const html = fs.readFileSync(filePath, 'utf8')
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/)

assert.ok(html.startsWith('<!doctype html>'), 'HTML must declare a doctype')
assert.ok(html.split(/\r?\n/).length <= 300, 'HTML must stay within 300 lines')
assert.ok(scriptMatch, 'HTML must contain one inline interaction script')
assert.equal(/(?:https?:)?\/\//.test(html), false, 'HTML must not load remote resources')
assert.equal(/<(?:script|link|img)\b[^>]+(?:src|href)=/i.test(html), false, 'HTML must be self-contained')

function element(dataset = {}) {
  return {
    dataset,
    value: '',
    textContent: '',
    innerHTML: '',
    hidden: false,
    handlers: {},
    addEventListener(type, handler) {
      this.handlers[type] = handler
    },
    setAttribute(name, value) {
      this[name] = value
    },
  }
}

const filters = ['all', 'baseline', 'done', 'active', 'planned'].map((filter) => element({ filter }))
const search = element()
const tableBody = element()
const emptyState = element()
const resultLine = element()
const counters = ['baseline', 'done', 'active', 'planned'].map((count) => element({ count }))
const filterCounters = ['all', 'baseline', 'done', 'active', 'planned'].map((filterCount) => element({ filterCount }))
const elements = { search, matrixRows: tableBody, emptyState, resultLine }
const document = {
  getElementById(id) {
    return elements[id]
  },
  querySelectorAll(selector) {
    if (selector === '[data-filter]') return filters
    if (selector === '[data-count]') return counters
    if (selector === '[data-filter-count]') return filterCounters
    return []
  },
}

vm.runInNewContext(scriptMatch[1], { Array, Object, String, document })
assert.equal(resultLine.textContent, '显示 16 / 16 项能力')
filters[2].handlers.click()
assert.equal(resultLine.textContent, '显示 6 / 16 项能力')
filters[3].handlers.click()
assert.equal(resultLine.textContent, '显示 2 / 16 项能力')
filters[4].handlers.click()
assert.equal(resultLine.textContent, '显示 2 / 16 项能力')
filters[0].handlers.click()
search.value = '跨视口'
search.handlers.input()
assert.equal(resultLine.textContent, '显示 1 / 16 项能力')
assert.match(tableBody.innerHTML, /Admin WebUI/)
search.value = '不存在的能力'
search.handlers.input()
assert.equal(resultLine.textContent, '显示 0 / 16 项能力')
assert.equal(emptyState.hidden, false)

console.log('capability matrix verification passed')
