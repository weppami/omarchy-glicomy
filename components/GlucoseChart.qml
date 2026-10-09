import QtQuick
import qs.Commons

// Glucose line chart on a Canvas, in the display unit: the shaded
// before-meal target band, a thin line at the after-meal limit, a neutral
// line and one dot per reading coloured by its category. `points`
// (Model.chartSeries, downsampled by the caller to at most 400), `labels`
// (Model.thinLabels) and `axis` (Model.chartScale) are precomputed; this
// item only paints them.
Canvas {
    id: chart

    property var points: []
    property var labels: []
    property var axis: ({ max: 300, step: 50, bandLow: 80, bandHigh: 130, afterMeal: 180 })
    property color foreground: Color.popups.text
    property color bandColor: '#22c55e'
    property string fontFamily: Style.font.family
    property int fontSize: Style.font.caption

    onPointsChanged: requestPaint()
    onLabelsChanged: requestPaint()
    onAxisChanged: requestPaint()
    onForegroundChanged: requestPaint()
    onFontFamilyChanged: requestPaint()
    onWidthChanged: requestPaint()
    onHeightChanged: requestPaint()

    function rgba(c, a) {
        return 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + a + ')'
    }

    onPaint: {
        var ctx = getContext('2d')
        ctx.reset()
        var pts = chart.points || []
        var sc = chart.axis
        var left = Style.space(30), right = Style.space(10), top = Style.space(8), bottom = Style.space(22)
        var w = width - left - right
        var h = height - top - bottom
        if (w <= 0 || h <= 0 || !sc || !(sc.max > 0) || !(sc.step > 0)) return

        function yOf(v) { return top + h - (Math.min(v, sc.max) / sc.max) * h }

        // Target band first, under the grid.
        ctx.fillStyle = rgba(chart.bandColor, 0.14)
        ctx.fillRect(left, yOf(sc.bandHigh), w, yOf(sc.bandLow) - yOf(sc.bandHigh))
        if (sc.afterMeal > 0) {
            var ay = Math.round(yOf(sc.afterMeal)) + 0.5
            ctx.strokeStyle = rgba(chart.bandColor, 0.55)
            ctx.lineWidth = 1
            ctx.beginPath()
            ctx.moveTo(left, ay)
            ctx.lineTo(left + w, ay)
            ctx.stroke()
        }

        ctx.font = fontSize + 'px "' + fontFamily + '"'
        ctx.lineWidth = 1
        ctx.textAlign = 'right'
        ctx.textBaseline = 'middle'
        for (var g = 0; g <= sc.max; g += sc.step) {
            var gy = Math.round(yOf(g)) + 0.5
            ctx.strokeStyle = rgba(foreground, g === 0 ? 0.3 : 0.12)
            ctx.beginPath()
            ctx.moveTo(left, gy)
            ctx.lineTo(left + w, gy)
            ctx.stroke()
            ctx.fillStyle = rgba(foreground, 0.6)
            ctx.fillText(String(g), left - Style.space(6), gy)
        }

        if (pts.length === 0) return
        var tMin = pts[0].t
        var tMax = pts[pts.length - 1].t
        var span = tMax - tMin
        function xOf(t) { return span > 0 ? left + ((t - tMin) / span) * w : left + w / 2 }

        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillStyle = rgba(foreground, 0.6)
        var lbls = chart.labels || []
        // Skip a label that would overlap the previous one drawn.
        var lastRight = -Infinity
        for (var l = 0; l < lbls.length; l++) {
            var text = String(lbls[l].label)
            var half = ctx.measureText(text).width / 2
            var lx = Math.max(left + half, Math.min(left + w - half, xOf(Math.max(tMin, lbls[l].t))))
            if (lx - half < lastRight + Style.space(6)) continue
            ctx.fillText(text, lx, top + h + Style.space(6))
            lastRight = lx + half
        }

        ctx.strokeStyle = rgba(foreground, 0.35)
        ctx.lineWidth = 1.5
        ctx.beginPath()
        for (var p = 0; p < pts.length; p++) {
            var x = xOf(pts[p].t), y = yOf(pts[p].value)
            if (p === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
        }
        ctx.stroke()

        var radius = pts.length <= 120 ? 3 : 2
        for (var d = 0; d < pts.length; d++) {
            ctx.fillStyle = String(pts[d].color)
            ctx.beginPath()
            ctx.arc(xOf(pts[d].t), yOf(pts[d].value), radius, 0, Math.PI * 2)
            ctx.fill()
        }
    }
}
