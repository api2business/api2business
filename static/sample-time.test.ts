import { expect, test } from 'bun:test'
import { sampleTimeDisplay } from './sample-time.js'

const now = Date.parse('2026-08-04T02:40:30+08:00')

test('latest sample uses relative labels until 24 hours', () => {
  expect(sampleTimeDisplay('2026-08-04T02:40:01+08:00', now)).toMatchObject({ label: '刚刚', freshness: 'fresh' })
  expect(sampleTimeDisplay('2026-08-04T02:35:00+08:00', now)).toMatchObject({ label: '5 分钟前', freshness: 'recent' })
  expect(sampleTimeDisplay('2026-08-03T23:30:00+08:00', now)).toMatchObject({ label: '3 小时前', freshness: 'aging' })
})

test('latest sample uses an absolute Beijing time after 24 hours', () => {
  expect(sampleTimeDisplay('2026-08-02T23:30:00+08:00', now)).toMatchObject({ label: '08/02 23:30', freshness: 'old' })
  expect(sampleTimeDisplay(null, now)).toEqual({ label: '无样本', exact: '', freshness: 'missing' })
})
