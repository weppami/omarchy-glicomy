// Model.js - Glicomy domain model.
//
// Pure functions shared by the QML panel (import "Model.js" as Model) and the
// Node test-suite (require). No Qt, DOM or file access lives here; every
// function takes plain data and returns plain data.
//
// Conventions:
//   - Glucose is always stored as an integer in mg/dL. mmol/L is a display
//     and entry unit only (MGDL_PER_MMOL), so switching units never rewrites
//     stored readings.
//   - A reading timestamp `at` is a local ISO-8601 string without timezone,
//     minute precision: YYYY-MM-DDTHH:MM.
//   - Ids are `p_` (profile) or `r_` (reading) followed by 12 hex characters.
//   - carbs (grams) and insulin (units, one decimal) are optional: null when
//     not recorded.
//   - validateReading() is forgiving (coerces interactive input);
//     validateState() is strict (rejects, never truncates) because the state
//     file is an untrusted input to the shared shell process.

var SCHEMA_VERSION = 1

var LIMITS = {
    glucose: { min: 20, max: 600 },
    carbs: { min: 0, max: 500 },
    insulin: { min: 0, max: 100 },
    nameMax: 40,
    noteMax: 200,
    profiles: 20,
    readings: 20000,
    plainMax: 200,
    errorsMax: 20
}

var MGDL_PER_MMOL = 18.0182
var UNITS = ['mgdl', 'mmol']
var CONTEXTS = ['', 'Fasting', 'Before meal', 'After meal', 'Bedtime', 'Overnight', 'Exercise', 'Other']
var RANGES = ['7d', '30d', 'all']

// Reading categories, in display order. Which glucose values fall in each
// depends on the reading's context (see TABLES).
var CATEGORIES = [
    { key: 'veryLow', label: 'Very low', longLabel: 'Very low (level 2 hypo)', color: '#b91c1c' },
    { key: 'low', label: 'Low', longLabel: 'Low (level 1 hypo)', color: '#ef4444' },
    { key: 'belowTarget', label: 'Below target', longLabel: 'Below target', color: '#3b82f6' },
    { key: 'inRange', label: 'In target', longLabel: 'In target', color: '#22c55e' },
    { key: 'high', label: 'High', longLabel: 'High', color: '#eab308' },
    { key: 'veryHigh', label: 'Very high', longLabel: 'Very high', color: '#f97316' }
]

// ADA Standards of Care glycaemic goals for most non-pregnant adults with
// diabetes: 80–130 mg/dL before meals, < 180 mg/dL 1–2 h after a meal. The
// hypoglycaemia levels (< 70, < 54) and the very-high level (> 250) are
// shared. `bounds` maps a category to its inclusive upper bound in mg/dL;
// a category missing from a table is not used by it. A reading uses the
// after-meal table only when its context is 'After meal'; every other
// context (or none) uses the stricter before-meal table.
var TABLES = [
    {
        key: 'premeal', label: 'Fasting, before meals and other times',
        bounds: { veryLow: 53, low: 69, belowTarget: 79, inRange: 130, high: 250, veryHigh: Infinity }
    },
    {
        key: 'postmeal', label: 'After meals (1–2 h)',
        bounds: { veryLow: 53, low: 69, inRange: 180, high: 250, veryHigh: Infinity }
    }
]
var TARGET_LOW = 70
var PREMEAL_TARGET = { low: 80, high: 130 }
var POSTMEAL_TARGET_HIGH = 180

var LOW_WARNING = 'Hypoglycaemia: below ' + TARGET_LOW + ' mg/dL (3.9 mmol/L), treat with 15 g of fast-acting '
    + 'carbohydrate and recheck in 15 minutes. If someone is confused, unconscious or cannot swallow, '
    + 'call emergency services.'
var HIGH_WARNING = 'Very high readings with nausea, vomiting, abdominal pain, fast breathing or fruity breath '
    + 'can mean diabetic ketoacidosis: check ketones if you can and seek urgent care.'

// Profile avatar colours.
var PALETTE = ['#a855f7', '#3b82f6', '#22c55e', '#f97316', '#ec4899', '#14b8a6', '#eab308', '#6366f1']

var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
var WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

var AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/
var PROFILE_ID_RE = /^p_[0-9a-f]{12}$/
var READING_ID_RE = /^r_[0-9a-f]{12}$/
var COLOR_RE = /^#[0-9a-fA-F]{6}$/
var DECIMAL_RE = /^\d{1,4}([.,]\d{0,3})?$/
// Markup, C0/C1 controls and Unicode bidi overrides; removed before text
// reaches a host-owned sink that cannot be pinned to PlainText.
var UNSAFE_RE = /[<>&\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g
// Controls and bidi overrides only; stored free text keeps < > & because
// every plugin-owned Text sink renders PlainText.
var CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g
var CSV_FORMULA_RE = /^[=+\-@\t\r]/

// ---------------------------------------------------------------- categories

function tableFor(context) {
    return context === 'After meal' ? TABLES[1] : TABLES[0]
}

function categoryOf(glucose, context) {
    var g = Number(glucose)
    var bounds = tableFor(context).bounds
    for (var i = 0; i < CATEGORIES.length; i++) {
        var max = bounds[CATEGORIES[i].key]
        if (max !== undefined && g <= max) return CATEGORIES[i].key
    }
    return 'veryHigh'
}

function category(key) {
    for (var i = 0; i < CATEGORIES.length; i++) {
        if (CATEGORIES[i].key === key) return CATEGORIES[i]
    }
    return CATEGORIES[3] // In target
}

// "80–130", "< 54", "> 250" (or "4.4–7.2", "< 3.0", "> 13.9") for the
// category `key` in the table for `context`; '' when that table does not use
// the category. A band starts one display step above the previous band's
// upper bound, so mmol/L bands never overlap ("7.3–13.9" after "4.4–7.2").
function categoryRange(key, unit, context) {
    var bounds = tableFor(context).bounds
    if (bounds[key] === undefined) return ''
    var prev = null
    for (var i = 0; i < CATEGORIES.length && CATEGORIES[i].key !== key; i++)
        if (bounds[CATEGORIES[i].key] !== undefined) prev = bounds[CATEGORIES[i].key]
    var hi = bounds[key] === Infinity ? null : bounds[key]
    if (prev === null) return '< ' + formatGlucose(hi + 1, unit)
    if (hi === null) return '> ' + formatGlucose(prev, unit)
    var lo = normalizeUnit(unit) === 'mmol' ? (toDisplay(prev, unit) + 0.1).toFixed(1) : String(prev + 1)
    return lo + '–' + formatGlucose(hi, unit)
}

// --------------------------------------------------------------------- units

function normalizeUnit(unit) {
    return unit === 'mmol' ? 'mmol' : 'mgdl'
}

function unitLabel(unit) {
    return normalizeUnit(unit) === 'mmol' ? 'mmol/L' : 'mg/dL'
}

function otherUnit(unit) {
    return normalizeUnit(unit) === 'mmol' ? 'mgdl' : 'mmol'
}

// mg/dL to the display unit as a number (mmol/L rounded to one decimal).
function toDisplay(mgdl, unit) {
    var g = Number(mgdl)
    if (normalizeUnit(unit) === 'mmol') return Math.round(g / MGDL_PER_MMOL * 10) / 10
    return Math.round(g)
}

function formatGlucose(mgdl, unit) {
    if (mgdl === null || mgdl === undefined || !isFinite(Number(mgdl))) return ''
    var v = toDisplay(mgdl, unit)
    return normalizeUnit(unit) === 'mmol' ? v.toFixed(1) : String(v)
}

// Parses typed glucose in the given unit to integer mg/dL, or null. mmol/L
// accepts one decimal separator (dot or comma). Each 0.1 mmol/L value maps
// to one mg/dL integer that formats back to the same text.
function parseGlucose(text, unit) {
    var s = (text === null || text === undefined) ? '' : String(text).trim()
    if (!DECIMAL_RE.test(s)) return null
    var v = Number(s.replace(',', '.'))
    if (!isFinite(v)) return null
    if (normalizeUnit(unit) === 'mmol') return Math.round(v * MGDL_PER_MMOL)
    return Math.floor(v) === v ? v : null
}

// ------------------------------------------------------------------- dates

function pad2(n) {
    return (n < 10 ? '0' : '') + n
}

function parseAt(at) {
    if (typeof at !== 'string') return null
    var m = AT_RE.exec(at)
    if (!m) return null
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]), h = Number(m[4]), mi = Number(m[5])
    if (y < 1970 || y > 9999 || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null
    var date = new Date(y, mo - 1, d, h, mi, 0, 0)
    // Reject overflowed dates such as February 30 (hours may shift on DST days).
    if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null
    return date
}

function toAt(date) {
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
        + 'T' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
}

function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0)
}

function addDays(date, n) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + n, 0, 0, 0, 0)
}

// Start of the selected range; 7 days means today plus the previous six.
function rangeStart(rangeKey, now) {
    var base = startOfDay(now || new Date())
    if (rangeKey === '7d') return addDays(base, -6)
    if (rangeKey === '30d') return addDays(base, -29)
    return null
}

function dayKey(at) {
    return at.slice(0, 10)
}

// ------------------------------------------------------------------ queries

function filterReadings(readings, profileId, rangeKey, now) {
    var start = rangeStart(rangeKey, now)
    var startMs = start ? start.getTime() : null
    var keyed = []
    for (var i = 0; i < (readings || []).length; i++) {
        var r = readings[i]
        if (!r || r.profileId !== profileId) continue
        var t = parseAt(r.at)
        if (!t) continue
        var ms = t.getTime()
        if (startMs !== null && ms < startMs) continue
        keyed.push({ ms: ms, r: r })
    }
    keyed.sort(function (a, b) {
        if (a.ms !== b.ms) return a.ms - b.ms
        return a.r.id < b.r.id ? -1 : (a.r.id > b.r.id ? 1 : 0)
    })
    var out = []
    for (var j = 0; j < keyed.length; j++) out.push(keyed[j].r)
    return out
}

// Summary statistics in mg/dL (all contexts together). eA1c is the ADAG estimate from the mean
// ((mean + 46.7) / 28.7), only meaningful with many readings over weeks.
function stats(readings) {
    var n = (readings || []).length
    if (n === 0) return { count: 0, mean: null, sd: null, cv: null, min: null, max: null, eA1c: null }
    var sum = 0, min = Infinity, max = -Infinity
    var i
    for (i = 0; i < n; i++) {
        var g = Number(readings[i].glucose)
        sum += g
        if (g < min) min = g
        if (g > max) max = g
    }
    var mean = sum / n
    var sq = 0
    for (i = 0; i < n; i++) sq += Math.pow(Number(readings[i].glucose) - mean, 2)
    var sd = n > 1 ? Math.sqrt(sq / (n - 1)) : 0
    return {
        count: n,
        mean: Math.round(mean),
        sd: Math.round(sd),
        cv: mean > 0 ? Math.round(sd / mean * 100) : 0,
        min: min,
        max: max,
        eA1c: Math.round((mean + 46.7) / 28.7 * 10) / 10
    }
}

// Share of readings per category (each judged by its own context),
// aligned with CATEGORIES.
function distribution(readings) {
    var counts = {}
    var i
    for (i = 0; i < CATEGORIES.length; i++) counts[CATEGORIES[i].key] = 0
    var total = (readings || []).length
    for (i = 0; i < total; i++) counts[categoryOf(readings[i].glucose, readings[i].context)] += 1
    var out = []
    for (i = 0; i < CATEGORIES.length; i++) {
        var c = CATEGORIES[i]
        var count = counts[c.key]
        out.push({ key: c.key, label: c.label, color: c.color, count: count, pct: total ? Math.round(count * 100 / total) : 0 })
    }
    return out
}

function dayLabel(key, now) {
    var today = startOfDay(now || new Date())
    if (key === toAt(today).slice(0, 10)) return 'Today'
    if (key === toAt(addDays(today, -1)).slice(0, 10)) return 'Yesterday'
    var d = parseAt(key + 'T00:00')
    if (!d) return key
    return WEEKDAYS[d.getDay()] + ', ' + MONTHS[d.getMonth()] + ' ' + d.getDate()
}

// Groups readings by calendar day, most recent day first, readings within a
// day most recent first.
function groupByDay(readings, now) {
    var keyed = []
    for (var i = 0; i < (readings || []).length; i++) {
        var t = parseAt(readings[i].at)
        if (t) keyed.push({ ms: t.getTime(), r: readings[i] })
    }
    keyed.sort(function (a, b) { return b.ms - a.ms })
    var groups = []
    var current = null
    for (var j = 0; j < keyed.length; j++) {
        var key = dayKey(keyed[j].r.at)
        if (!current || current.key !== key) {
            current = { key: key, label: dayLabel(key, now), readings: [] }
            groups.push(current)
        }
        current.readings.push(keyed[j].r)
    }
    return groups
}

// --------------------------------------------------------------- formatting

function formatTime(at) {
    var d = parseAt(at)
    if (!d) return ''
    var h = d.getHours()
    var h12 = h % 12
    if (h12 === 0) h12 = 12
    return h12 + ':' + pad2(d.getMinutes()) + ' ' + (h < 12 ? 'AM' : 'PM')
}

function formatDate(at) {
    var d = parseAt(at)
    if (!d) return ''
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear()
}

function formatShortDate(at) {
    var d = parseAt(at)
    if (!d) return ''
    return MONTHS[d.getMonth()] + ' ' + d.getDate()
}

function formatDateTime(at) {
    var date = formatDate(at)
    return date ? date + ' at ' + formatTime(at) : ''
}

// "1.5" for insulin units; '' when not recorded.
function formatInsulin(value) {
    if (value === null || value === undefined) return ''
    var n = Number(value)
    return Math.floor(n) === n ? String(n) : n.toFixed(1)
}

// "After meal · 45 g · 4.5 u · note" for a reading's secondary line.
function readingDetails(r) {
    if (!r) return ''
    var parts = []
    if (r.context) parts.push(r.context)
    if (r.carbs !== null && r.carbs !== undefined) parts.push(r.carbs + ' g carbs')
    if (r.insulin !== null && r.insulin !== undefined) parts.push(formatInsulin(r.insulin) + ' u insulin')
    if (r.note) parts.push(r.note)
    return parts.join(' · ')
}

// -------------------------------------------------------------- validation

function randomHex(length) {
    var out = ''
    for (var i = 0; i < length; i++) out += Math.floor(Math.random() * 16).toString(16)
    return out
}

function newId(prefix) {
    return prefix + '_' + randomHex(12)
}

function blank(value) {
    return value === null || value === undefined || (typeof value === 'string' && value.trim() === '')
}

// Accepts a number or a numeric string; returns an integer within [min, max] or null.
function coerceInt(value, min, max) {
    if (typeof value === 'string') value = value.trim()
    if (value === '' || value === null || value === undefined || typeof value === 'boolean') return null
    var n = Number(value)
    if (!isFinite(n) || Math.floor(n) !== n) return null
    if (n < min || n > max) return null
    return n
}

// Accepts a number or numeric string (dot or comma) with at most one
// decimal; returns it rounded to one decimal within [min, max], or null.
function coerceTenths(value, min, max) {
    var n
    if (typeof value === 'number') n = value
    else if (typeof value === 'string' && DECIMAL_RE.test(value.trim())) n = Number(value.trim().replace(',', '.'))
    else return null
    if (!isFinite(n) || !isTenths(n) || n < min || n > max) return null
    return Math.round(n * 10) / 10
}

function isTenths(n) {
    return Math.abs(n * 10 - Math.round(n * 10)) < 1e-6
}

// Strict variant for stored state: the value must already be an integer number.
function strictInt(value, min, max) {
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) return null
    if (value < min || value > max) return null
    return value
}

function pickOption(value, options) {
    var v = (value === null || value === undefined) ? '' : String(value).trim()
    return options.indexOf(v) >= 0 ? v : null
}

function cleanText(value) {
    if (value === null || value === undefined) return ''
    return String(value).replace(CONTROL_RE, '').trim()
}

// `glucose` is mg/dL (number or digits); the form converts typed mmol/L
// with parseGlucose() first.
function validateReading(obj) {
    var src = (obj && typeof obj === 'object') ? obj : {}
    var errors = []

    var glucose = coerceInt(src.glucose, LIMITS.glucose.min, LIMITS.glucose.max)
    if (glucose === null) {
        errors.push('Glucose must be between ' + LIMITS.glucose.min + ' and ' + LIMITS.glucose.max + ' mg/dL ('
            + formatGlucose(LIMITS.glucose.min, 'mmol') + '–' + formatGlucose(LIMITS.glucose.max, 'mmol') + ' mmol/L).')
    }

    var carbs = null
    if (!blank(src.carbs)) {
        carbs = coerceInt(src.carbs, LIMITS.carbs.min, LIMITS.carbs.max)
        if (carbs === null) errors.push('Carbs must be a whole number of grams between ' + LIMITS.carbs.min + ' and ' + LIMITS.carbs.max + ', or empty.')
    }
    var insulin = null
    if (!blank(src.insulin)) {
        insulin = coerceTenths(src.insulin, LIMITS.insulin.min, LIMITS.insulin.max)
        if (insulin === null) errors.push('Insulin must be between ' + LIMITS.insulin.min + ' and ' + LIMITS.insulin.max + ' units with at most one decimal, or empty.')
    }

    var at = typeof src.at === 'string' ? src.at.trim() : ''
    if (!parseAt(at)) errors.push('Date and time must be a valid YYYY-MM-DDTHH:MM value.')

    var profileId = (typeof src.profileId === 'string' && PROFILE_ID_RE.test(src.profileId)) ? src.profileId : null
    if (!profileId) errors.push('Reading must belong to a profile.')

    var id = (typeof src.id === 'string' && READING_ID_RE.test(src.id)) ? src.id : newId('r')

    var context = pickOption(src.context, CONTEXTS)
    if (context === null) errors.push('Context must be one of the listed options.')

    var note = cleanText(src.note).slice(0, LIMITS.noteMax)

    return {
        ok: errors.length === 0,
        errors: errors,
        value: {
            id: id, profileId: profileId, at: at, glucose: glucose,
            context: context || '', carbs: carbs, insulin: insulin, note: note
        }
    }
}

function validateProfileName(name) {
    var errors = []
    var value = typeof name === 'string' ? cleanText(name) : ''
    if (typeof name !== 'string') errors.push('Profile name must be text.')
    else if (value.length === 0) errors.push('Profile name cannot be empty.')
    else if (value.length > LIMITS.nameMax) errors.push('Profile name must be at most ' + LIMITS.nameMax + ' characters.')
    return { ok: errors.length === 0, errors: errors, value: value }
}

function emptyState() {
    return { version: SCHEMA_VERSION, activeProfile: null, unit: 'mgdl', profiles: [], readings: [] }
}

function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function hasControl(text) {
    var found = CONTROL_RE.test(text)
    CONTROL_RE.lastIndex = 0
    return found
}

function validProfile(p, seenIds, errors, index) {
    var where = 'profiles[' + index + ']'
    if (!isPlainObject(p)) { errors.push(where + ' is not an object.'); return null }
    if (typeof p.id !== 'string' || !PROFILE_ID_RE.test(p.id)) { errors.push(where + ' has an invalid id.'); return null }
    if (seenIds[p.id]) { errors.push(where + ' repeats id ' + p.id + '.'); return null }
    if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > LIMITS.nameMax
        || p.name.trim().length === 0 || hasControl(p.name)) {
        errors.push(where + ' has an invalid name.')
        return null
    }
    if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) { errors.push(where + ' has an invalid color.'); return null }
    if (!parseAt(p.createdAt)) { errors.push(where + ' has an invalid createdAt.'); return null }
    seenIds[p.id] = true
    return { id: p.id, name: p.name, color: p.color.toLowerCase(), createdAt: p.createdAt }
}

function validStoredReading(r, profileIds, seenIds, errors, index) {
    var where = 'readings[' + index + ']'
    if (!isPlainObject(r)) { errors.push(where + ' is not an object.'); return null }
    if (typeof r.id !== 'string' || !READING_ID_RE.test(r.id)) { errors.push(where + ' has an invalid id.'); return null }
    if (seenIds[r.id]) { errors.push(where + ' repeats id ' + r.id + '.'); return null }
    if (typeof r.profileId !== 'string' || !profileIds[r.profileId]) { errors.push(where + ' references an unknown profile.'); return null }
    if (!parseAt(r.at)) { errors.push(where + ' has an invalid timestamp.'); return null }
    var glucose = strictInt(r.glucose, LIMITS.glucose.min, LIMITS.glucose.max)
    if (glucose === null) { errors.push(where + ' has a glucose value out of bounds.'); return null }
    var carbs = r.carbs === undefined ? null : r.carbs
    if (carbs !== null && strictInt(carbs, LIMITS.carbs.min, LIMITS.carbs.max) === null) {
        errors.push(where + ' has carbs out of bounds.')
        return null
    }
    var insulin = r.insulin === undefined ? null : r.insulin
    if (insulin !== null && (typeof insulin !== 'number' || !isFinite(insulin) || !isTenths(insulin)
        || insulin < LIMITS.insulin.min || insulin > LIMITS.insulin.max)) {
        errors.push(where + ' has insulin out of bounds.')
        return null
    }
    var context = r.context === undefined ? '' : r.context
    if (CONTEXTS.indexOf(context) < 0) { errors.push(where + ' has an unknown context.'); return null }
    var note = r.note === undefined ? '' : r.note
    if (typeof note !== 'string' || note.length > LIMITS.noteMax || hasControl(note)) {
        errors.push(where + ' has an invalid note.')
        return null
    }
    seenIds[r.id] = true
    return {
        id: r.id, profileId: r.profileId, at: r.at, glucose: glucose, context: context,
        carbs: carbs, insulin: insulin === null ? null : Math.round(insulin * 10) / 10, note: note
    }
}

// Validates a loaded state document. Unknown keys are dropped; anything else
// that does not fit the schema makes the whole document invalid.
function validateState(obj) {
    var errors = []
    if (!isPlainObject(obj)) return { ok: false, state: null, errors: ['State is not an object.'] }
    if (obj.version !== SCHEMA_VERSION) errors.push('Unsupported state version.')
    if (obj.unit !== undefined && UNITS.indexOf(obj.unit) < 0) errors.push('unit must be mgdl or mmol.')
    if (!Array.isArray(obj.profiles)) errors.push('profiles must be an array.')
    else if (obj.profiles.length > LIMITS.profiles) errors.push('Too many profiles (max ' + LIMITS.profiles + ').')
    if (!Array.isArray(obj.readings)) errors.push('readings must be an array.')
    else if (obj.readings.length > LIMITS.readings) errors.push('Too many readings (max ' + LIMITS.readings + ').')
    if (errors.length) return { ok: false, state: null, errors: errors }

    var profiles = []
    var profileIds = {}
    var i
    for (i = 0; i < obj.profiles.length && errors.length < LIMITS.errorsMax; i++) {
        var p = validProfile(obj.profiles[i], profileIds, errors, i)
        if (p) profiles.push(p)
    }
    var readings = []
    var readingIds = {}
    for (i = 0; i < obj.readings.length && errors.length < LIMITS.errorsMax; i++) {
        var r = validStoredReading(obj.readings[i], profileIds, readingIds, errors, i)
        if (r) readings.push(r)
    }
    var active = obj.activeProfile
    if (active !== null && active !== undefined && (typeof active !== 'string' || !profileIds[active])) {
        errors.push('activeProfile references an unknown profile.')
    }
    if (errors.length) return { ok: false, state: null, errors: errors }
    return {
        ok: true,
        errors: [],
        state: {
            version: SCHEMA_VERSION, activeProfile: active || null, unit: normalizeUnit(obj.unit),
            profiles: profiles, readings: readings
        }
    }
}

// ------------------------------------------------------------------- sinks

// Text destined for a host-owned sink (tooltips, dialogs, section headers):
// no markup characters, no controls, no bidi overrides, bounded length.
function plain(s, max) {
    var str = (s === null || s === undefined) ? '' : String(s)
    str = str.replace(UNSAFE_RE, '')
    var cap = (typeof max === 'number' && max > 0) ? max : LIMITS.plainMax
    return str.length > cap ? str.slice(0, cap) : str
}

var CSV_HEADER = ['Date', 'Time', 'Glucose (mg/dL)', 'Glucose (mmol/L)', 'Category', 'Context', 'Carbs (g)', 'Insulin (u)', 'Note']

// Spreadsheets evaluate cells that start with = + - @; prefix them with a quote.
function csvCell(value) {
    var s = (value === null || value === undefined) ? '' : String(value)
    return CSV_FORMULA_RE.test(s) ? "'" + s : s
}

function csvRows(readings) {
    var rows = [CSV_HEADER.slice()]
    for (var i = 0; i < (readings || []).length; i++) {
        var r = readings[i]
        rows.push([
            formatDate(r.at), formatTime(r.at), r.glucose, formatGlucose(r.glucose, 'mmol'),
            category(categoryOf(r.glucose, r.context)).label, csvCell(r.context),
            r.carbs === null ? '' : r.carbs, formatInsulin(r.insulin), csvCell(r.note)
        ])
    }
    return rows
}

// ------------------------------------------------------------------- charts

// Points in time order (value in the display unit, colour by category)
// plus one label per distinct calendar day (start of day).
function chartSeries(readings, unit) {
    var points = []
    var labels = []
    var lastDay = null
    for (var i = 0; i < (readings || []).length; i++) {
        var r = readings[i]
        var d = parseAt(r.at)
        if (!d) continue
        points.push({ t: d.getTime(), value: toDisplay(r.glucose, unit), color: category(categoryOf(r.glucose, r.context)).color })
        var key = dayKey(r.at)
        if (key !== lastDay) {
            labels.push({ t: startOfDay(d).getTime(), label: formatShortDate(r.at) })
            lastDay = key
        }
    }
    return { points: points, labels: labels }
}

// Y axis for a glucose chart in the display unit: at least up to 300 mg/dL
// (18 mmol/L), extended in whole grid steps to fit the highest value. The
// band is the before-meal target; afterMeal is the after-meal limit.
function chartScale(maxDisplayValue, unit) {
    var mmol = normalizeUnit(unit) === 'mmol'
    var step = mmol ? 3 : 50
    var floor = mmol ? 18 : 300
    var top = Math.max(floor, Math.ceil((Number(maxDisplayValue) || 0) / step) * step)
    return {
        max: top, step: step, bandLow: toDisplay(PREMEAL_TARGET.low, unit), bandHigh: toDisplay(PREMEAL_TARGET.high, unit),
        afterMeal: toDisplay(POSTMEAL_TARGET_HIGH, unit)
    }
}

// Keeps at most `max` evenly spaced labels, always including the first.
function thinLabels(labels, max) {
    var n = (labels || []).length
    if (n <= max) return (labels || []).slice()
    var step = Math.ceil(n / max)
    var out = []
    for (var i = 0; i < n; i += step) out.push(labels[i])
    return out
}

function initialColor(index) {
    var i = Math.abs(Math.floor(Number(index) || 0)) % PALETTE.length
    return PALETTE[i]
}

function profileInitial(name) {
    var s = typeof name === 'string' ? name.trim() : ''
    return s.length ? s.charAt(0).toUpperCase() : '?'
}

// ---------------------------------------------------------------- UI helpers

// Most recent reading of one profile, or null.
function lastReading(readings, profileId) {
    var best = null
    var bestMs = -Infinity
    for (var i = 0; i < (readings || []).length; i++) {
        var r = readings[i]
        if (!r || r.profileId !== profileId) continue
        var t = parseAt(r.at)
        if (!t) continue
        if (t.getTime() >= bestMs) {
            best = r
            bestMs = t.getTime()
        }
    }
    return best
}

// "128" or "7.1", or '' when there is no reading.
function readingLine(r, unit) {
    return r ? formatGlucose(r.glucose, unit) : ''
}

// "5 min ago", "3 h ago", "2 d ago" for the tooltip.
function ago(at, now) {
    var d = parseAt(at)
    if (!d) return ''
    var minutes = Math.floor(((now || new Date()).getTime() - d.getTime()) / 60000)
    if (minutes < 1) return 'just now'
    if (minutes < 60) return minutes + ' min ago'
    if (minutes < 48 * 60) return Math.floor(minutes / 60) + ' h ago'
    return Math.floor(minutes / 1440) + ' d ago'
}

// Evenly spaced subset of at most `max` items, keeping the first and last so
// a chart always spans the full range. Bounds the work a Canvas repaint does.
function downsample(items, max) {
    var list = items || []
    var n = list.length
    var cap = Math.max(1, Math.floor(Number(max) || 1))
    if (n <= cap) return list.slice()
    if (cap === 1) return [list[n - 1]]
    var out = []
    var step = (n - 1) / (cap - 1)
    var last = -1
    for (var i = 0; i < cap; i++) {
        var idx = Math.round(i * step)
        if (idx > last) {
            out.push(list[idx])
            last = idx
        }
    }
    return out
}

// Splits a stored timestamp into the form's date and time fields.
function splitAt(at) {
    if (!parseAt(at)) return { date: '', time: '' }
    return { date: at.slice(0, 10), time: at.slice(11, 16) }
}

// Joins form fields (YYYY-MM-DD, H:MM or HH:MM) into a timestamp, or null.
function joinAt(date, time) {
    if (typeof date !== 'string' || typeof time !== 'string') return null
    var d = date.trim()
    var t = time.trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null
    var m = /^(\d{1,2}):(\d{2})$/.exec(t)
    if (!m) return null
    var at = d + 'T' + pad2(Number(m[1])) + ':' + m[2]
    return parseAt(at) ? at : null
}

var EXPORT_PATH_MAX = 4096
var EXPORT_PATH_RE = /^\/[^\u0000-\u001f\u007f]*\/Glicomy\/Glicomy-[^\/\u0000-\u001f\u007f]*\.(pdf|csv)$/

// True only for an absolute path shaped like the helper's export output:
// <documents>/Glicomy/Glicomy-<slug>-<stamp>[-n].pdf|csv, no controls, no
// relative segments. Guards the path before it reaches xdg-open.
function isExportPath(path) {
    if (typeof path !== 'string' || path.length > EXPORT_PATH_MAX) return false
    if (!EXPORT_PATH_RE.test(path)) return false
    var parts = path.split('/')
    for (var i = 1; i < parts.length; i++) {
        if (parts[i] === '' || parts[i] === '.' || parts[i] === '..') return false
    }
    return true
}

// Directory holding a validated export, or '' when the path is not one.
function exportFolder(path) {
    if (!isExportPath(path)) return ''
    return path.slice(0, path.lastIndexOf('/'))
}

// ------------------------------------------------------------ keyboard
//
// keyAction() maps one key press to an action name for the panel. It is a
// pure table so the keymap is unit-tested; Panel.qml computes the context
// (the topmost open layer), normalizes the Qt event and dispatches the
// returned action. '' means "not handled": the event then stays with the
// focused control (dropdown popups, text editing).
//
// context:     records | analysis | report | profileMenu | form | info |
//              help | confirm | nameEditor | onboarding
// key:         normalized key name ('Left', 'Return', 'Escape', 'Tab', ...)
//              or '' for a printable key, which is then read from `text`
// modifiers:   { ctrl, shift, alt }
// textFocused: a text input has focus; only Escape, Tab / Shift+Tab,
//              Return / Enter, Ctrl+Enter, Ctrl+S (and Up / Down /
//              PageUp / PageDown in the reading form) are mapped, so typing
//              is never stolen.

var PAGE_CONTEXTS = ['records', 'analysis', 'report']

var PAGE_TEXT = {
    '1': 'tab1', '2': 'tab2', '3': 'tab3',
    'n': 'newReading', '+': 'newReading',
    'p': 'profileMenu', '[': 'profilePrev', ']': 'profileNext',
    'u': 'toggleUnit', 'i': 'info', '?': 'help'
}
var PAGE_KEYS = { 'Left': 'tabPrev', 'Right': 'tabNext' }
var RANGE_TEXT = { 'w': 'range7d', 'm': 'range30d', 'a': 'rangeAll' }
var SCROLL_TEXT = { 'j': 'scrollDown', 'k': 'scrollUp' }
var SCROLL_KEYS = { 'Down': 'scrollDown', 'Up': 'scrollUp', 'PageDown': 'pageDown', 'PageUp': 'pageUp' }
var FORM_STEP_KEYS = { 'Up': 'formStepUp', 'Down': 'formStepDown', 'PageUp': 'formPageUp', 'PageDown': 'formPageDown' }

var CONTEXT_TEXT = {
    records: { 'j': 'selectNext', 'k': 'selectPrev', 'g': 'selectFirst', 'G': 'selectLast', 'e': 'editSelected', 'x': 'deleteSelected' },
    analysis: SCROLL_TEXT,
    report: { 'e': 'exportPdf', 'c': 'exportCsv', 'o': 'openExport', 'f': 'openFolder' },
    info: { 'j': 'scrollDown', 'k': 'scrollUp', 'i': 'info', '?': 'help' },
    help: { 'j': 'scrollDown', 'k': 'scrollUp', '?': 'help' },
    profileMenu: { 'j': 'menuNext', 'k': 'menuPrev', 'a': 'profileAdd', 'r': 'profileRename', 'd': 'profileDelete', 'p': 'profileMenu' },
    confirm: { 'y': 'confirmYes', 'n': 'confirmNo' }
}
var CONTEXT_KEYS = {
    records: {
        'Down': 'selectNext', 'Up': 'selectPrev', 'Home': 'selectFirst', 'End': 'selectLast',
        'PageUp': 'selectPageUp', 'PageDown': 'selectPageDown',
        'Return': 'editSelected', 'Enter': 'editSelected', 'Delete': 'deleteSelected'
    },
    analysis: SCROLL_KEYS,
    info: SCROLL_KEYS,
    help: SCROLL_KEYS,
    profileMenu: { 'Down': 'menuNext', 'Up': 'menuPrev', 'Return': 'menuActivate', 'Enter': 'menuActivate' },
    form: { 'Return': 'formSave', 'Enter': 'formSave' },
    confirm: {
        'Return': 'confirmActivate', 'Enter': 'confirmActivate',
        'Left': 'confirmToggle', 'Right': 'confirmToggle', 'Tab': 'confirmToggle', 'Backtab': 'confirmToggle'
    },
    nameEditor: { 'Return': 'nameSave', 'Enter': 'nameSave' },
    onboarding: { 'Return': 'onboardingSave', 'Enter': 'onboardingSave' }
}
var SAVE_ACTIONS = { form: 'formSave', nameEditor: 'nameSave', onboarding: 'onboardingSave' }

function lookup(table, name) {
    return table && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : ''
}

function keyAction(context, key, text, modifiers, textFocused) {
    var ctx = typeof context === 'string' ? context : ''
    var k = typeof key === 'string' ? key : ''
    var t = typeof text === 'string' && text.length === 1 ? text : ''
    var mods = modifiers && typeof modifiers === 'object' ? modifiers : {}
    var focused = textFocused === true

    if (k === 'Escape') return ctx === 'confirm' ? 'confirmNo' : 'escape'

    // Save chords work from any field of an editor.
    var save = lookup(SAVE_ACTIONS, ctx)
    if (mods.ctrl && !mods.alt) {
        if (save !== '' && (k === 'Return' || k === 'Enter' || (k === '' && (t === 's' || t === 'S')))) return save
        return ''
    }
    if (mods.alt || mods.ctrl) return ''

    if (k === 'Tab' || k === 'Backtab') {
        if (ctx === 'form') return k === 'Backtab' || mods.shift ? 'formPrev' : 'formNext'
        if (ctx === 'confirm') return 'confirmToggle'
        return ''
    }

    // Number steppers in the form; the panel declines them (returns false)
    // when the focused field is not numeric, so dropdowns keep their arrows.
    if (ctx === 'form' && lookup(FORM_STEP_KEYS, k) !== '') return FORM_STEP_KEYS[k]

    if (focused) {
        if (k === 'Return' || k === 'Enter') return save
        return ''
    }

    if (k !== '') {
        var byKey = lookup(CONTEXT_KEYS[ctx], k)
        if (byKey !== '') return byKey
        return PAGE_CONTEXTS.indexOf(ctx) >= 0 ? lookup(PAGE_KEYS, k) : ''
    }
    if (t === '') return ''

    var byText = lookup(CONTEXT_TEXT[ctx], t)
    if (byText !== '') return byText
    if (PAGE_CONTEXTS.indexOf(ctx) < 0) return ''
    if (ctx !== 'records') {
        var range = lookup(RANGE_TEXT, t)
        if (range !== '') return range
    }
    return lookup(PAGE_TEXT, t)
}

// Human-readable keymap, shared by the in-panel help overlay and the
// README (tests/test_model.cjs checks that every row appears there). Keys
// are space-separated tokens; '/' and 'or' are separators.
var SHORTCUTS = [
    { group: 'Global', keys: '1 2 3 or Left / Right', action: 'Switch between Records, Analysis and Reports' },
    { group: 'Global', keys: 'n or +', action: 'New reading' },
    { group: 'Global', keys: 'u', action: 'Switch between mg/dL and mmol/L' },
    { group: 'Global', keys: 'p', action: 'Open the profile menu' },
    { group: 'Global', keys: '[ / ]', action: 'Previous / next profile' },
    { group: 'Global', keys: 'i', action: 'Glucose ranges and safety information' },
    { group: 'Global', keys: '?', action: 'Show or hide this shortcut list' },
    { group: 'Global', keys: 'w / m / a', action: 'Range 7 days / 30 days / all (Analysis and Reports)' },
    { group: 'Global', keys: 'Esc', action: 'Close the topmost layer, otherwise the panel' },
    { group: 'Records', keys: 'j / k or Down / Up', action: 'Select the next / previous reading' },
    { group: 'Records', keys: 'g / G or Home / End', action: 'Select the first / last reading' },
    { group: 'Records', keys: 'PageUp / PageDown', action: 'Move the selection by a page' },
    { group: 'Records', keys: 'Enter or e', action: 'Edit the selected reading' },
    { group: 'Records', keys: 'x or Delete', action: 'Delete the selected reading (asks first)' },
    { group: 'Analysis, info and help', keys: 'j / k or Down / Up', action: 'Scroll' },
    { group: 'Analysis, info and help', keys: 'PageUp / PageDown', action: 'Scroll by a page' },
    { group: 'Reports', keys: 'e', action: 'Export PDF' },
    { group: 'Reports', keys: 'c', action: 'Export CSV' },
    { group: 'Reports', keys: 'o', action: 'Open the last export' },
    { group: 'Reports', keys: 'f', action: 'Open the folder of the last export' },
    { group: 'Profile menu', keys: 'j / k or Down / Up', action: 'Move through the menu' },
    { group: 'Profile menu', keys: 'Enter', action: 'Select the highlighted profile or action' },
    { group: 'Profile menu', keys: 'a / r / d', action: 'Add / rename / delete profile' },
    { group: 'Profile menu', keys: 'p or Esc', action: 'Close the menu' },
    { group: 'Reading form', keys: 'Tab / Shift+Tab', action: 'Next / previous field' },
    { group: 'Reading form', keys: 'Up / Down or PageUp / PageDown', action: 'Adjust glucose, carbs or insulin by a small / large step' },
    { group: 'Reading form', keys: 'Space or Enter', action: 'Open a dropdown or press the focused button' },
    { group: 'Reading form', keys: 'Ctrl+Enter or Ctrl+S', action: 'Save from any field' },
    { group: 'Reading form', keys: 'Esc', action: 'Cancel' },
    { group: 'Dialogs', keys: 'Enter or y', action: 'Confirm (Left / Right picks the button Enter presses)' },
    { group: 'Dialogs', keys: 'Esc or n', action: 'Cancel a confirmation' },
    { group: 'Dialogs', keys: 'Enter / Esc', action: 'Save / cancel a profile name' }
]

function shortcutHelp() {
    var out = []
    for (var i = 0; i < SHORTCUTS.length; i++)
        out.push({ group: SHORTCUTS[i].group, keys: SHORTCUTS[i].keys, action: SHORTCUTS[i].action })
    return out
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SCHEMA_VERSION: SCHEMA_VERSION, LIMITS: LIMITS, MGDL_PER_MMOL: MGDL_PER_MMOL, UNITS: UNITS,
        CONTEXTS: CONTEXTS, RANGES: RANGES, CATEGORIES: CATEGORIES, TABLES: TABLES, TARGET_LOW: TARGET_LOW, PREMEAL_TARGET: PREMEAL_TARGET,
        POSTMEAL_TARGET_HIGH: POSTMEAL_TARGET_HIGH, tableFor: tableFor,
        LOW_WARNING: LOW_WARNING, HIGH_WARNING: HIGH_WARNING, PALETTE: PALETTE, CSV_HEADER: CSV_HEADER,
        categoryOf: categoryOf, category: category, categoryRange: categoryRange,
        normalizeUnit: normalizeUnit, unitLabel: unitLabel, otherUnit: otherUnit,
        toDisplay: toDisplay, formatGlucose: formatGlucose, parseGlucose: parseGlucose,
        parseAt: parseAt, toAt: toAt, startOfDay: startOfDay, addDays: addDays, rangeStart: rangeStart,
        filterReadings: filterReadings, stats: stats, distribution: distribution, groupByDay: groupByDay,
        formatTime: formatTime, formatDate: formatDate, formatShortDate: formatShortDate, formatDateTime: formatDateTime,
        formatInsulin: formatInsulin, readingDetails: readingDetails,
        newId: newId, validateReading: validateReading, validateProfileName: validateProfileName,
        emptyState: emptyState, validateState: validateState,
        plain: plain, csvRows: csvRows, chartSeries: chartSeries, chartScale: chartScale, thinLabels: thinLabels,
        initialColor: initialColor, profileInitial: profileInitial,
        lastReading: lastReading, readingLine: readingLine, ago: ago, downsample: downsample,
        splitAt: splitAt, joinAt: joinAt, isExportPath: isExportPath, exportFolder: exportFolder,
        keyAction: keyAction, SHORTCUTS: SHORTCUTS, shortcutHelp: shortcutHelp
    }
}
