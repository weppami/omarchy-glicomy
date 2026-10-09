'use strict'
// Unit tests for Model.js. Run with: node tests/test_model.cjs
const assert = require('assert/strict')
const path = require('path')
const { spawnSync } = require('child_process')

const M = require(path.join(__dirname, '..', 'Model.js'))

let passed = 0
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (err) {
    console.error('FAIL ' + name)
    throw err
  }
}

// A fixed "now": Tuesday 6 October 2026, 12:00 local time.
const NOW = new Date(2026, 9, 6, 12, 0, 0, 0)
const PROFILE = 'p_0123456789ab'
const OTHER = 'p_ba9876543210'

function reading(at, glucose, extra) {
  return Object.assign({
    id: M.newId('r'), profileId: PROFILE, at, glucose,
    context: '', carbs: null, insulin: null, note: ''
  }, extra || {})
}

// ---------------------------------------------------------- categories

test('categories follow the ADA before-meal goals unless the context is After meal', () => {
  const premeal = { 20: 'veryLow', 53: 'veryLow', 54: 'low', 69: 'low', 70: 'belowTarget', 79: 'belowTarget',
    80: 'inRange', 130: 'inRange', 131: 'high', 176: 'high', 250: 'high', 251: 'veryHigh', 600: 'veryHigh' }
  for (const context of ['', 'Fasting', 'Before meal', 'Bedtime', 'Overnight', 'Exercise', 'Other', undefined]) {
    for (const [value, key] of Object.entries(premeal)) assert.equal(M.categoryOf(Number(value), context), key, context + ' ' + value)
  }
  const postmeal = { 53: 'veryLow', 54: 'low', 69: 'low', 70: 'inRange', 176: 'inRange', 180: 'inRange',
    181: 'high', 250: 'high', 251: 'veryHigh' }
  for (const [value, key] of Object.entries(postmeal)) assert.equal(M.categoryOf(Number(value), 'After meal'), key, 'after ' + value)
  assert.equal(M.tableFor('After meal').key, 'postmeal')
  assert.equal(M.tableFor('Fasting').key, 'premeal')
})

test('CATEGORIES is ordered and carries the display metadata', () => {
  assert.deepEqual(M.CATEGORIES.map(c => c.key), ['veryLow', 'low', 'belowTarget', 'inRange', 'high', 'veryHigh'])
  assert.deepEqual(M.CATEGORIES.map(c => c.label), ['Very low', 'Low', 'Below target', 'In target', 'High', 'Very high'])
  assert.equal(M.category('high').label, 'High')
  assert.equal(M.category('bogus').key, 'inRange')
  assert.match(M.LOW_WARNING, /^Hypoglycaemia:/)
  assert.match(M.HIGH_WARNING, /ketoacidosis/)
})

test('categoryRange gives non-overlapping legends per table in both units', () => {
  const keys = M.CATEGORIES.map(c => c.key)
  assert.deepEqual(keys.map(k => M.categoryRange(k, 'mgdl', '')), ['< 54', '54–69', '70–79', '80–130', '131–250', '> 250'])
  assert.deepEqual(keys.map(k => M.categoryRange(k, 'mmol', '')), ['< 3.0', '3.0–3.8', '3.9–4.4', '4.5–7.2', '7.3–13.9', '> 13.9'])
  assert.deepEqual(keys.map(k => M.categoryRange(k, 'mgdl', 'After meal')), ['< 54', '54–69', '', '70–180', '181–250', '> 250'])
  assert.deepEqual(keys.map(k => M.categoryRange(k, 'mmol', 'After meal')), ['< 3.0', '3.0–3.8', '', '3.9–10.0', '10.1–13.9', '> 13.9'])
  assert.equal(M.categoryRange('bogus', 'mgdl', ''), '')
})

// --------------------------------------------------------------- units

test('unit helpers default to mg/dL', () => {
  assert.equal(M.normalizeUnit('mmol'), 'mmol')
  assert.equal(M.normalizeUnit('anything'), 'mgdl')
  assert.equal(M.unitLabel('mmol'), 'mmol/L')
  assert.equal(M.unitLabel(undefined), 'mg/dL')
  assert.equal(M.otherUnit('mgdl'), 'mmol')
  assert.equal(M.otherUnit('mmol'), 'mgdl')
})

test('formatGlucose converts mg/dL for display', () => {
  assert.equal(M.formatGlucose(100, 'mgdl'), '100')
  assert.equal(M.formatGlucose(100, 'mmol'), '5.5')
  assert.equal(M.formatGlucose(70, 'mmol'), '3.9')
  assert.equal(M.formatGlucose(180, 'mmol'), '10.0')
  assert.equal(M.formatGlucose(54, 'mmol'), '3.0')
  assert.equal(M.formatGlucose(600, 'mmol'), '33.3')
  assert.equal(M.formatGlucose(null, 'mgdl'), '')
  assert.equal(M.toDisplay(126, 'mmol'), 7)
})

test('parseGlucose accepts each unit and rejects junk', () => {
  assert.equal(M.parseGlucose('115', 'mgdl'), 115)
  assert.equal(M.parseGlucose(' 115 ', 'mgdl'), 115)
  assert.equal(M.parseGlucose('115.5', 'mgdl'), null)
  assert.equal(M.parseGlucose('5.5', 'mmol'), 99)
  assert.equal(M.parseGlucose('5,5', 'mmol'), 99)
  assert.equal(M.parseGlucose('7', 'mmol'), 126)
  for (const junk of ['', 'abc', '5.5.5', '-5', '1e3', '12345', null, undefined]) {
    assert.equal(M.parseGlucose(junk, 'mmol'), null, String(junk))
    assert.equal(M.parseGlucose(junk, 'mgdl'), null, String(junk))
  }
})

test('every 0.1 mmol/L step round-trips through stored mg/dL', () => {
  for (let tenths = 11; tenths <= 333; tenths++) {
    const text = (tenths / 10).toFixed(1)
    const mg = M.parseGlucose(text, 'mmol')
    assert.equal(M.formatGlucose(mg, 'mmol'), text, text)
  }
})

test('typed mmol/L values land in the category their legend shows', () => {
  const premeal = { '2.9': 'veryLow', '3.0': 'low', '3.8': 'low', '3.9': 'belowTarget', '4.4': 'belowTarget',
    '4.5': 'inRange', '7.2': 'inRange', '7.3': 'high', '13.9': 'high', '14.0': 'veryHigh' }
  for (const [text, key] of Object.entries(premeal)) assert.equal(M.categoryOf(M.parseGlucose(text, 'mmol'), 'Fasting'), key, text)
  const postmeal = { '3.9': 'inRange', '10.0': 'inRange', '10.1': 'high' }
  for (const [text, key] of Object.entries(postmeal)) assert.equal(M.categoryOf(M.parseGlucose(text, 'mmol'), 'After meal'), key, text)
})

test('mmol/L formatting and legends match the Python helper', () => {
  const script = [
    'import importlib.util, json, sys',
    'spec = importlib.util.spec_from_file_location("s", sys.argv[1])',
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    'print(json.dumps({"fmt": [m.format_glucose(g, "mmol") for g in range(20, 601)],',
    '  "cat": [m.category_of(g, c) for c in ("", "Fasting", "After meal") for g in range(20, 601)],',
    '  "pre": [e["premeal"] for e in m.report_distribution([], "mmol")],',
    '  "post": [e["postmeal"] for e in m.report_distribution([], "mmol")]}))'
  ].join('\n')
  const out = spawnSync('/usr/bin/python3', ['-I', '-S', '-c', script, path.join(__dirname, '..', 'bin', 'glicomy_store.py')], { encoding: 'utf8' })
  assert.equal(out.status, 0, out.stderr)
  const py = JSON.parse(out.stdout)
  const values = []
  for (let g = 20; g <= 600; g++) values.push(g)
  assert.deepEqual(values.map(g => M.formatGlucose(g, 'mmol')), py.fmt)
  const cats = []
  for (const c of ['', 'Fasting', 'After meal']) for (const g of values) cats.push(M.categoryOf(g, c))
  assert.deepEqual(cats, py.cat)
  assert.deepEqual(M.CATEGORIES.map(c => M.categoryRange(c.key, 'mmol', '').replace('–', '-')), py.pre)
  assert.deepEqual(M.CATEGORIES.map(c => M.categoryRange(c.key, 'mmol', 'After meal').replace('–', '-')), py.post)
})

// --------------------------------------------------------------- dates

test('rangeStart covers today plus the previous days, from midnight', () => {
  assert.equal(M.rangeStart('7d', NOW).getTime(), new Date(2026, 8, 30, 0, 0, 0, 0).getTime())
  assert.equal(M.rangeStart('30d', NOW).getTime(), new Date(2026, 8, 7, 0, 0, 0, 0).getTime())
  assert.equal(M.rangeStart('all', NOW), null)
  assert.equal(M.rangeStart('garbage', NOW), null)
})

test('parseAt is strict about the YYYY-MM-DDTHH:MM shape', () => {
  assert.equal(M.parseAt('2026-10-06T07:33').getTime(), new Date(2026, 9, 6, 7, 33).getTime())
  assert.equal(M.parseAt('2026-10-06T07:33:00'), null)
  assert.equal(M.parseAt('2026-10-06 07:33'), null)
  assert.equal(M.parseAt('2026-13-06T07:33'), null)
  assert.equal(M.parseAt('2026-02-30T07:33'), null)
  assert.equal(M.parseAt('2026-10-06T24:00'), null)
  assert.equal(M.parseAt(''), null)
  assert.equal(M.parseAt(null), null)
  assert.equal(M.parseAt(20261006), null)
  assert.equal(M.toAt(new Date(2026, 9, 6, 7, 3)), '2026-10-06T07:03')
})

test('filterReadings keeps the profile and range, sorted ascending', () => {
  const list = [
    reading('2026-10-06T09:00', 120),
    reading('2026-09-30T08:00', 118),
    reading('2026-09-29T23:59', 117),
    reading('2026-10-01T08:00', 121, { profileId: OTHER }),
    reading('not-a-date', 121)
  ]
  const week = M.filterReadings(list, PROFILE, '7d', NOW)
  assert.deepEqual(week.map(r => r.at), ['2026-09-30T08:00', '2026-10-06T09:00'])
  const all = M.filterReadings(list, PROFILE, 'all', NOW)
  assert.deepEqual(all.map(r => r.at), ['2026-09-29T23:59', '2026-09-30T08:00', '2026-10-06T09:00'])
  assert.deepEqual(M.filterReadings(list, 'p_000000000000', 'all', NOW), [])
})

// --------------------------------------------------------------- stats

test('stats: mean, sample SD, CV, min, max and estimated A1C', () => {
  assert.deepEqual(M.stats([]), { count: 0, mean: null, sd: null, cv: null, min: null, max: null, eA1c: null })
  const s = M.stats([reading('2026-10-06T09:00', 80), reading('2026-10-06T10:00', 120), reading('2026-10-06T11:00', 160)])
  assert.deepEqual(s, { count: 3, mean: 120, sd: 40, cv: 33, min: 80, max: 160, eA1c: 5.8 })
  const one = M.stats([reading('2026-10-06T09:00', 154)])
  assert.equal(one.sd, 0)
  assert.equal(one.cv, 0)
  assert.equal(one.eA1c, 7.0, 'ADAG: 154 mg/dL is about 7% A1C')
})

test('distribution judges each reading by its context and reports integer percentages', () => {
  const dist = M.distribution([
    reading('2026-10-06T09:00', 100, { context: 'Fasting' }),
    reading('2026-10-06T10:00', 176, { context: 'After meal' }),
    reading('2026-10-06T11:00', 176),
    reading('2026-10-06T12:00', 60)
  ])
  assert.deepEqual(dist.map(d => d.key), M.CATEGORIES.map(c => c.key))
  assert.deepEqual(dist.map(d => d.count), [0, 1, 0, 2, 1, 0])
  assert.deepEqual(dist.map(d => d.pct), [0, 25, 0, 50, 25, 0])
  assert.deepEqual(M.distribution([]).map(d => d.pct), [0, 0, 0, 0, 0, 0])
})

test('groupByDay labels Today, Yesterday and older dates, most recent first', () => {
  const groups = M.groupByDay([
    reading('2026-10-03T07:30', 120),
    reading('2026-10-06T07:33', 120),
    reading('2026-10-06T21:10', 120),
    reading('2026-10-05T08:00', 120)
  ], NOW)
  assert.deepEqual(groups.map(g => g.key), ['2026-10-06', '2026-10-05', '2026-10-03'])
  assert.deepEqual(groups.map(g => g.label), ['Today', 'Yesterday', 'Sat, Oct 3'])
  assert.deepEqual(groups[0].readings.map(r => r.at), ['2026-10-06T21:10', '2026-10-06T07:33'])
})

// ---------------------------------------------------------- formatting

test('formatting helpers', () => {
  assert.equal(M.formatTime('2026-10-06T07:33'), '7:33 AM')
  assert.equal(M.formatTime('2026-10-06T00:05'), '12:05 AM')
  assert.equal(M.formatTime('2026-10-06T12:00'), '12:00 PM')
  assert.equal(M.formatTime('2026-10-06T23:59'), '11:59 PM')
  assert.equal(M.formatDate('2026-10-06T07:33'), 'Oct 6, 2026')
  assert.equal(M.formatShortDate('2026-10-06T07:33'), 'Oct 6')
  assert.equal(M.formatDateTime('2026-10-06T07:33'), 'Oct 6, 2026 at 7:33 AM')
  assert.equal(M.formatDate('garbage'), '')
  assert.equal(M.formatInsulin(null), '')
  assert.equal(M.formatInsulin(4), '4')
  assert.equal(M.formatInsulin(4.5), '4.5')
  assert.equal(M.readingDetails(reading('2026-10-06T07:33', 120, { context: 'After meal', carbs: 45, insulin: 4.5, note: 'pasta' })),
    'After meal · 45 g carbs · 4.5 u insulin · pasta')
  assert.equal(M.readingDetails(reading('2026-10-06T07:33', 120, { carbs: 0 })), '0 g carbs')
  assert.equal(M.readingDetails(reading('2026-10-06T07:33', 120)), '')
  assert.equal(M.readingDetails(null), '')
})

test('ago describes how old the last reading is', () => {
  assert.equal(M.ago('2026-10-06T12:00', NOW), 'just now')
  assert.equal(M.ago('2026-10-06T11:25', NOW), '35 min ago')
  assert.equal(M.ago('2026-10-06T07:00', NOW), '5 h ago')
  assert.equal(M.ago('2026-10-02T12:00', NOW), '4 d ago')
  assert.equal(M.ago('garbage', NOW), '')
})

test('readingLine formats the bar value in the display unit', () => {
  assert.equal(M.readingLine({ glucose: 128 }, 'mgdl'), '128')
  assert.equal(M.readingLine({ glucose: 128 }, 'mmol'), '7.1')
  assert.equal(M.readingLine(null, 'mgdl'), '')
})

// ---------------------------------------------------------- validation

test('validateReading coerces numbers, trims strings and reports errors', () => {
  const ok = M.validateReading({
    profileId: PROFILE, at: ' 2026-10-06T07:33 ', glucose: '120', context: 'After meal',
    carbs: ' 45 ', insulin: '4,5', note: '  after pasta  '
  })
  assert.equal(ok.ok, true, ok.errors.join('; '))
  assert.equal(ok.value.glucose, 120)
  assert.equal(ok.value.carbs, 45)
  assert.equal(ok.value.insulin, 4.5)
  assert.equal(ok.value.at, '2026-10-06T07:33')
  assert.equal(ok.value.note, 'after pasta')
  assert.match(ok.value.id, /^r_[0-9a-f]{12}$/)

  const optional = M.validateReading({ profileId: PROFILE, at: '2026-10-06T07:33', glucose: 95, carbs: '', insulin: '  ' })
  assert.equal(optional.ok, true, optional.errors.join('; '))
  assert.equal(optional.value.carbs, null)
  assert.equal(optional.value.insulin, null)
  assert.equal(optional.value.context, '')

  const bad = M.validateReading({ profileId: 'nope', at: '2026-10-06', glucose: 19, carbs: 12.5, insulin: '4.25', context: 'Lunch' })
  assert.equal(bad.ok, false)
  assert.equal(bad.errors.length, 6, bad.errors.join('; '))

  const clamped = M.validateReading({ profileId: PROFILE, at: '2026-10-06T07:33', glucose: 120, note: 'x'.repeat(300) + '\u0007' })
  assert.equal(clamped.ok, true)
  assert.equal(clamped.value.note.length, 200)

  assert.equal(M.validateReading(null).ok, false)
  const at = '2026-10-06T07:33'
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 20 }).ok, true)
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 600 }).ok, true)
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 601 }).ok, false)
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 120.5 }).ok, false)
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 'abc' }).ok, false)
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 120, carbs: 501 }).ok, false)
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 120, insulin: 100.5 }).ok, false)
  assert.equal(M.validateReading({ profileId: PROFILE, at, glucose: 120, insulin: 0 }).value.insulin, 0)
})

test('validateProfileName trims and bounds the name', () => {
  assert.deepEqual(M.validateProfileName('  Ana  ').value, 'Ana')
  assert.equal(M.validateProfileName('   ').ok, false)
  assert.equal(M.validateProfileName('x'.repeat(41)).ok, false)
  assert.equal(M.validateProfileName('x'.repeat(40)).ok, true)
  assert.equal(M.validateProfileName(42).ok, false)
})

test('newId and emptyState', () => {
  assert.match(M.newId('p'), /^p_[0-9a-f]{12}$/)
  assert.notEqual(M.newId('r'), M.newId('r'))
  assert.deepEqual(M.emptyState(), { version: 1, activeProfile: null, unit: 'mgdl', profiles: [], readings: [] })
})

test('validateState accepts a well-formed document and rejects caps and references', () => {
  const profile = { id: PROFILE, name: 'Ana', color: '#a855f7', createdAt: '2026-10-01T09:00' }
  const doc = (extra) => Object.assign({ version: 1, activeProfile: null, unit: 'mgdl', profiles: [profile], readings: [] }, extra)
  const good = doc({ activeProfile: PROFILE, unit: 'mmol', readings: [reading('2026-10-06T07:33', 120, { carbs: 30, insulin: 2.5 })], junk: true })
  const res = M.validateState(good)
  assert.equal(res.ok, true, res.errors.join('; '))
  assert.equal(res.state.junk, undefined)
  assert.equal(res.state.unit, 'mmol')
  assert.equal(res.state.readings[0].insulin, 2.5)

  // A document written before `unit` existed loads as mg/dL; optional fields may be absent.
  const legacy = M.validateState({ version: 1, activeProfile: null, profiles: [profile],
    readings: [{ id: 'r_000000000001', profileId: PROFILE, at: '2026-10-06T07:33', glucose: 99 }] })
  assert.equal(legacy.ok, true, legacy.errors.join('; '))
  assert.equal(legacy.state.unit, 'mgdl')
  assert.deepEqual(legacy.state.readings[0], { id: 'r_000000000001', profileId: PROFILE, at: '2026-10-06T07:33',
    glucose: 99, context: '', carbs: null, insulin: null, note: '' })

  assert.equal(M.validateState(M.emptyState()).ok, true)
  assert.equal(M.validateState(doc({ version: 2 })).ok, false)
  assert.equal(M.validateState(doc({ unit: 'mg' })).ok, false)
  assert.equal(M.validateState(null).ok, false)
  assert.equal(M.validateState(doc({ activeProfile: 'p_ffffffffffff' })).ok, false)
  assert.equal(M.validateState(doc({ profiles: [], readings: [reading('2026-10-06T07:33', 120)] })).ok, false, 'orphan reading')

  const manyProfiles = []
  for (let i = 0; i < 21; i++) manyProfiles.push({ id: 'p_' + String(i).padStart(12, '0'), name: 'P' + i, color: '#a855f7', createdAt: '2026-10-01T09:00' })
  assert.equal(M.validateState(doc({ profiles: manyProfiles })).ok, false, 'profile cap')
  assert.equal(M.validateState(doc({ profiles: manyProfiles.slice(0, 20) })).ok, true)

  const manyReadings = []
  for (let i = 0; i < 20001; i++) manyReadings.push({ id: 'r_' + i.toString(16).padStart(12, '0'), profileId: PROFILE, at: '2026-10-06T07:33', glucose: 120, context: '', carbs: null, insulin: null, note: '' })
  assert.equal(M.validateState(doc({ readings: manyReadings })).ok, false, 'reading cap')
  assert.equal(M.validateState(doc({ readings: manyReadings.slice(0, 20000) })).ok, true)

  const rejected = {
    'note cap is rejected, not truncated': { note: 'x'.repeat(201) },
    'unknown context': { context: 'Lunch' },
    'carbs out of range': { carbs: 501 },
    'fractional carbs': { carbs: 1.5 },
    'insulin with two decimals': { insulin: 4.25 },
    'negative insulin': { insulin: -1 },
    'string insulin': { insulin: '2' }
  }
  for (const [label, extra] of Object.entries(rejected)) {
    assert.equal(M.validateState(doc({ readings: [reading('2026-10-06T07:33', 120, extra)] })).ok, false, label)
  }
  const dupIds = [reading('2026-10-06T07:33', 120, { id: 'r_000000000001' }), reading('2026-10-06T08:33', 120, { id: 'r_000000000001' })]
  assert.equal(M.validateState(doc({ readings: dupIds })).ok, false, 'duplicate ids')
  assert.equal(M.validateState(doc({ profiles: [{ id: PROFILE, name: 'Ana', color: 'red', createdAt: '2026-10-01T09:00' }] })).ok, false, 'colour shape')
  assert.equal(M.validateState(doc({ readings: [reading('2026-10-06T07:33', '120')] })).ok, false, 'state numbers are not coerced')
  assert.equal(M.validateState(doc({ readings: [reading('2026-10-06T07:33', 601)] })).ok, false, 'glucose bound')
})

// --------------------------------------------------------------- sinks

test('plain strips markup, control and bidi characters and caps length', () => {
  assert.equal(M.plain('<b>Ana</b> & co\u0007‮‏'), 'bAna/b  co')
  assert.equal(M.plain(null), '')
  assert.equal(M.plain(12345), '12345')
  assert.equal(M.plain('x'.repeat(500)).length, 200)
  assert.equal(M.plain('abcdef', 3), 'abc')
})

test('csvRows has the documented header, both units and neutralised formula prefixes', () => {
  const rows = M.csvRows([
    reading('2026-10-06T07:33', 196, { context: 'After meal', carbs: 60, insulin: 4.5, note: '=SUM(A1)' }),
    reading('2026-10-06T09:00', 92)
  ])
  assert.deepEqual(rows[0], ['Date', 'Time', 'Glucose (mg/dL)', 'Glucose (mmol/L)', 'Category', 'Context', 'Carbs (g)', 'Insulin (u)', 'Note'])
  assert.deepEqual(rows[1], ['Oct 6, 2026', '7:33 AM', 196, '10.9', 'High', 'After meal', 60, '4.5', "'=SUM(A1)"])
  assert.deepEqual(rows[2], ['Oct 6, 2026', '9:00 AM', 92, '5.1', 'In target', '', '', '', ''])
})

// -------------------------------------------------------------- charts

test('chartSeries exposes display-unit points coloured by category and day labels', () => {
  const list = [
    reading('2026-10-05T07:00', 60),
    reading('2026-10-05T20:00', 140),
    reading('2026-10-06T07:00', 260)
  ]
  const s = M.chartSeries(list, 'mgdl')
  assert.equal(s.points.length, 3)
  assert.deepEqual(s.points[0], { t: new Date(2026, 9, 5, 7, 0).getTime(), value: 60, color: M.category('low').color })
  assert.equal(s.points[2].color, M.category('veryHigh').color)
  assert.deepEqual(s.labels.map(l => l.label), ['Oct 5', 'Oct 6'])
  assert.equal(s.labels[0].t, new Date(2026, 9, 5).getTime())
  assert.deepEqual(M.chartSeries(list, 'mmol').points.map(p => p.value), [3.3, 7.8, 14.4])

  const many = []
  for (let i = 0; i < 20; i++) many.push({ t: i, label: 'd' + i })
  const thinned = M.thinLabels(many, 8)
  assert.ok(thinned.length <= 8 && thinned.length >= 7, String(thinned.length))
  assert.equal(thinned[0].label, 'd0')
})

test('chartScale keeps a 300 mg/dL (18 mmol/L) floor and whole grid steps', () => {
  assert.deepEqual(M.chartScale(0, 'mgdl'), { max: 300, step: 50, bandLow: 80, bandHigh: 130, afterMeal: 180 })
  assert.equal(M.chartScale(301, 'mgdl').max, 350)
  assert.deepEqual(M.chartScale(5, 'mmol'), { max: 18, step: 3, bandLow: 4.4, bandHigh: 7.2, afterMeal: 10 })
  assert.equal(M.chartScale(25.1, 'mmol').max, 27)
})

test('initialColor cycles through a fixed palette starting with purple', () => {
  assert.equal(M.initialColor(0), '#a855f7')
  assert.equal(M.PALETTE.length, 8)
  assert.equal(M.initialColor(8), M.initialColor(0))
  assert.equal(M.profileInitial('ana'), 'A')
  assert.equal(M.profileInitial('   '), '?')
})

test('lastReading returns the most recent reading of one profile', () => {
  const rs = [
    reading('2026-10-05T07:00', 120),
    reading('2026-10-06T08:00', 129),
    reading('2026-10-06T09:00', 150, { profileId: OTHER }),
    reading('2026-10-04T23:00', 110)
  ]
  assert.equal(M.lastReading(rs, PROFILE).glucose, 129)
  assert.equal(M.lastReading(rs, OTHER).glucose, 150)
  assert.equal(M.lastReading(rs, 'p_000000000000'), null)
  assert.equal(M.lastReading([], PROFILE), null)
  assert.equal(M.lastReading(null, PROFILE), null)
})

test('downsample keeps at most max points including first and last', () => {
  const pts = []
  for (let i = 0; i < 1000; i++) pts.push({ t: i })
  const out = M.downsample(pts, 400)
  assert.ok(out.length <= 400, String(out.length))
  assert.ok(out.length >= 399, String(out.length))
  assert.equal(out[0].t, 0)
  assert.equal(out[out.length - 1].t, 999)
  for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t)
  assert.equal(M.downsample(pts.slice(0, 10), 400).length, 10)
  assert.deepEqual(M.downsample([], 400), [])
  assert.equal(M.downsample(pts, 1).length, 1)
})

test('splitAt and joinAt round-trip date and time fields', () => {
  assert.deepEqual(M.splitAt('2026-10-06T09:05'), { date: '2026-10-06', time: '09:05' })
  assert.deepEqual(M.splitAt('garbage'), { date: '', time: '' })
  assert.equal(M.joinAt('2026-10-06', '09:05'), '2026-10-06T09:05')
  assert.equal(M.joinAt(' 2026-10-06 ', '9:05'), '2026-10-06T09:05')
  assert.equal(M.joinAt('2026-02-30', '09:05'), null)
  assert.equal(M.joinAt('2026-10-06', '24:00'), null)
  assert.equal(M.joinAt('2026-10-6', '09:05'), null)
  assert.equal(M.joinAt(null, '09:05'), null)
})

test('isExportPath accepts only helper-shaped absolute export paths', () => {
  assert.ok(M.isExportPath('/home/u/Documents/Glicomy/Glicomy-Ana-20261006-0900.pdf'))
  assert.ok(M.isExportPath('/home/u/Documents/Glicomy/Glicomy-Ana-20261006-0900-2.csv'))
  assert.ok(!M.isExportPath('relative/Glicomy/Glicomy-a.pdf'))
  assert.ok(!M.isExportPath('/home/u/Documents/Glicomy/Glicomy-a.sh'))
  assert.ok(!M.isExportPath('/home/u/Documents/Other/report.pdf'))
  assert.ok(!M.isExportPath('/home/u/Documents/Glicomy/Glicomy-a\n.pdf'))
  assert.ok(!M.isExportPath('/home/u/../etc/Glicomy/Glicomy-a.pdf'))
  assert.ok(!M.isExportPath(42))
  assert.ok(!M.isExportPath('/' + 'a'.repeat(5000) + '/Glicomy/Glicomy-a.pdf'))
  assert.equal(M.exportFolder('/home/u/Documents/Glicomy/Glicomy-Ana-1.pdf'), '/home/u/Documents/Glicomy')
  assert.equal(M.exportFolder('/etc/passwd'), '')
})

// ------------------------------------------------------------ keyboard

const fs = require('fs')
// key: normalized Qt key name ('' for printable keys), text: typed character.
function K(context, key, text, mods, textFocused) {
  return M.keyAction(context, key, text || '', mods || {}, !!textFocused)
}
const CTRL = { ctrl: true }
const SHIFT = { shift: true }
const PAGES = ['records', 'analysis', 'report']

test('keyAction: global page keys switch tabs, open layers and change profile', () => {
  for (const ctx of PAGES) {
    assert.equal(K(ctx, '', '1'), 'tab1')
    assert.equal(K(ctx, '', '2'), 'tab2')
    assert.equal(K(ctx, '', '3'), 'tab3')
    assert.equal(K(ctx, 'Left'), 'tabPrev')
    assert.equal(K(ctx, 'Right'), 'tabNext')
    assert.equal(K(ctx, '', 'n'), 'newReading')
    assert.equal(K(ctx, '', '+', SHIFT), 'newReading')
    assert.equal(K(ctx, '', 'p'), 'profileMenu')
    assert.equal(K(ctx, '', '['), 'profilePrev')
    assert.equal(K(ctx, '', ']'), 'profileNext')
    assert.equal(K(ctx, '', 'i'), 'info')
    assert.equal(K(ctx, '', 'u'), 'toggleUnit')
    assert.equal(K(ctx, '', '?', SHIFT), 'help')
    assert.equal(K(ctx, 'Escape'), 'escape')
  }
})

test('keyAction: range keys apply on Analysis and Report only', () => {
  for (const ctx of ['analysis', 'report']) {
    assert.equal(K(ctx, '', 'w'), 'range7d')
    assert.equal(K(ctx, '', 'm'), 'range30d')
    assert.equal(K(ctx, '', 'a'), 'rangeAll')
  }
  assert.equal(K('records', '', 'w'), '')
  assert.equal(K('records', '', 'm'), '')
  assert.equal(K('records', '', 'a'), '')
})

test('keyAction: Records moves, edits and deletes the selected row', () => {
  assert.equal(K('records', '', 'j'), 'selectNext')
  assert.equal(K('records', 'Down'), 'selectNext')
  assert.equal(K('records', '', 'k'), 'selectPrev')
  assert.equal(K('records', 'Up'), 'selectPrev')
  assert.equal(K('records', '', 'g'), 'selectFirst')
  assert.equal(K('records', 'Home'), 'selectFirst')
  assert.equal(K('records', '', 'G', SHIFT), 'selectLast')
  assert.equal(K('records', 'End'), 'selectLast')
  assert.equal(K('records', 'PageUp'), 'selectPageUp')
  assert.equal(K('records', 'PageDown'), 'selectPageDown')
  assert.equal(K('records', 'Return'), 'editSelected')
  assert.equal(K('records', 'Enter'), 'editSelected')
  assert.equal(K('records', '', 'e'), 'editSelected')
  assert.equal(K('records', '', 'x'), 'deleteSelected')
  assert.equal(K('records', 'Delete'), 'deleteSelected')
})

test('keyAction: Analysis, info and help scroll', () => {
  for (const ctx of ['analysis', 'info', 'help']) {
    assert.equal(K(ctx, '', 'j'), 'scrollDown')
    assert.equal(K(ctx, 'Down'), 'scrollDown')
    assert.equal(K(ctx, '', 'k'), 'scrollUp')
    assert.equal(K(ctx, 'Up'), 'scrollUp')
    assert.equal(K(ctx, 'PageDown'), 'pageDown')
    assert.equal(K(ctx, 'PageUp'), 'pageUp')
    assert.equal(K(ctx, 'Escape'), 'escape')
  }
  assert.equal(K('help', '', '?', SHIFT), 'help')
  assert.equal(K('info', '', 'i'), 'info')
  assert.equal(K('info', '', '?', SHIFT), 'help')
  // Page keys do not leak into overlays.
  assert.equal(K('help', '', 'n'), '')
  assert.equal(K('info', '', '1'), '')
})

test('keyAction: Report exports and opens the last export', () => {
  assert.equal(K('report', '', 'e'), 'exportPdf')
  assert.equal(K('report', '', 'c'), 'exportCsv')
  assert.equal(K('report', '', 'o'), 'openExport')
  assert.equal(K('report', '', 'f'), 'openFolder')
  assert.equal(K('analysis', '', 'e'), '')
})

test('keyAction: profile menu navigation and actions', () => {
  assert.equal(K('profileMenu', '', 'j'), 'menuNext')
  assert.equal(K('profileMenu', 'Down'), 'menuNext')
  assert.equal(K('profileMenu', '', 'k'), 'menuPrev')
  assert.equal(K('profileMenu', 'Up'), 'menuPrev')
  assert.equal(K('profileMenu', 'Return'), 'menuActivate')
  assert.equal(K('profileMenu', 'Enter'), 'menuActivate')
  assert.equal(K('profileMenu', '', 'a'), 'profileAdd')
  assert.equal(K('profileMenu', '', 'r'), 'profileRename')
  assert.equal(K('profileMenu', '', 'd'), 'profileDelete')
  assert.equal(K('profileMenu', 'Escape'), 'escape')
  assert.equal(K('profileMenu', '', 'p'), 'profileMenu')
  assert.equal(K('profileMenu', '', 'n'), '')
})

test('keyAction: reading form cycles focus, saves and cancels', () => {
  assert.equal(K('form', 'Tab'), 'formNext')
  assert.equal(K('form', 'Backtab', '', SHIFT), 'formPrev')
  assert.equal(K('form', 'Tab', '', SHIFT), 'formPrev')
  assert.equal(K('form', 'Return', '', CTRL), 'formSave')
  assert.equal(K('form', 'Enter', '', CTRL), 'formSave')
  assert.equal(K('form', '', 's', CTRL), 'formSave')
  assert.equal(K('form', 'Return'), 'formSave')
  assert.equal(K('form', 'PageUp'), 'formPageUp')
  assert.equal(K('form', 'PageDown'), 'formPageDown')
  assert.equal(K('form', 'Up'), 'formStepUp')
  assert.equal(K('form', 'Down'), 'formStepDown')
  // Steppers also reach a focused text field (glucose, carbs, insulin).
  assert.equal(K('form', 'Up', '', {}, true), 'formStepUp')
  assert.equal(K('form', 'PageDown', '', {}, true), 'formPageDown')
  assert.equal(K('form', 'Escape'), 'escape')
  // Page shortcuts never fire while the form is open.
  assert.equal(K('form', '', 'n'), '')
  assert.equal(K('form', '', '1'), '')
  assert.equal(K('form', '', 's'), '')
})

test('keyAction: confirm dialog, name editor and onboarding', () => {
  assert.equal(K('confirm', 'Return'), 'confirmActivate')
  assert.equal(K('confirm', 'Enter'), 'confirmActivate')
  assert.equal(K('confirm', '', 'y'), 'confirmYes')
  assert.equal(K('confirm', '', 'n'), 'confirmNo')
  assert.equal(K('confirm', 'Escape'), 'confirmNo')
  assert.equal(K('confirm', 'Left'), 'confirmToggle')
  assert.equal(K('confirm', 'Right'), 'confirmToggle')
  assert.equal(K('confirm', 'Tab'), 'confirmToggle')
  assert.equal(K('confirm', '', 'x'), '')
  assert.equal(K('nameEditor', 'Return', '', {}, true), 'nameSave')
  assert.equal(K('nameEditor', '', 's', CTRL, true), 'nameSave')
  assert.equal(K('nameEditor', 'Escape', '', {}, true), 'escape')
  assert.equal(K('onboarding', 'Return', '', {}, true), 'onboardingSave')
  assert.equal(K('onboarding', 'Escape', '', {}, true), 'escape')
})

test('keyAction: a focused text field suppresses single-key shortcuts', () => {
  for (const ch of ['n', '+', 'p', '[', ']', 'i', 'u', '?', 'w', 'm', 'a', 'e', 'x', 'j', 'k', 'g', 'G', '1', '2', '3', 'y', '.', ',']) {
    for (const ctx of PAGES.concat(['form', 'nameEditor', 'onboarding', 'profileMenu', 'confirm', 'help', 'info'])) {
      assert.equal(K(ctx, '', ch, {}, true), '', ctx + ' ' + ch)
    }
  }
  for (const key of ['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'Delete', 'Space']) {
    assert.equal(K('records', key, '', {}, true), '', key)
  }
  for (const key of ['Left', 'Right', 'Home', 'End', 'Delete', 'Space']) {
    assert.equal(K('form', key, '', {}, true), '', key)
  }
  assert.equal(K('form', 'Escape', '', {}, true), 'escape')
  assert.equal(K('form', 'Tab', '', {}, true), 'formNext')
  assert.equal(K('form', 'Backtab', '', SHIFT, true), 'formPrev')
  assert.equal(K('form', 'Return', '', {}, true), 'formSave')
  assert.equal(K('form', 'Return', '', CTRL, true), 'formSave')
  assert.equal(K('form', '', 's', CTRL, true), 'formSave')
})

test('keyAction: modifiers and unknown input are ignored', () => {
  assert.equal(K('records', '', 'n', CTRL), '')
  assert.equal(K('records', '', 'n', { alt: true }), '')
  assert.equal(K('records', '', 's', CTRL), '')
  assert.equal(K('nowhere', '', 'n'), '')
  assert.equal(K('nowhere', 'Escape'), 'escape')
  assert.equal(K('records', '', ''), '')
  assert.equal(K('records', 'F13'), '')
  assert.equal(M.keyAction(), '')
  assert.equal(M.keyAction('records', null, null, null), '')
})

test('shortcutHelp lists grouped rows that the README documents verbatim', () => {
  const rows = M.shortcutHelp()
  assert.ok(Array.isArray(rows) && rows.length >= 20)
  const groups = []
  for (const row of rows) {
    assert.equal(typeof row.group, 'string')
    assert.equal(typeof row.keys, 'string')
    assert.equal(typeof row.action, 'string')
    assert.ok(row.group && row.keys && row.action)
    assert.ok(!/[<>&]/.test(row.group + row.keys + row.action))
    if (groups.indexOf(row.group) < 0) groups.push(row.group)
  }
  assert.deepEqual(groups, ['Global', 'Records', 'Analysis, info and help', 'Reports', 'Profile menu', 'Reading form', 'Dialogs'])
  // Rows of one group are contiguous so the overlay can render them in order.
  let last = ''
  const seen = []
  for (const row of rows) {
    if (row.group !== last) {
      assert.ok(seen.indexOf(row.group) < 0, 'group split: ' + row.group)
      seen.push(row.group)
      last = row.group
    }
  }
  // Returned rows are copies: mutating them never changes the table.
  rows[0].keys = 'changed'
  assert.notEqual(M.shortcutHelp()[0].keys, 'changed')
  assert.deepEqual(M.SHORTCUTS.map(r => r.group + r.keys + r.action), M.shortcutHelp().map(r => r.group + r.keys + r.action))
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8')
  for (const group of groups) assert.ok(readme.includes('### ' + group), 'README group ' + group)
  for (const row of M.shortcutHelp()) {
    const line = '| ' + row.keys.split(' ').map(k => k === '/' || k === 'or' ? k : '`' + k + '`').join(' ') + ' | ' + row.action + ' |'
    assert.ok(readme.includes(line), 'README row missing: ' + line)
  }
})

console.log('ok ' + passed + ' test groups')
