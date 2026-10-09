import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import "../Model.js" as Model

// Glucose chart, summary statistics and readings by range for the selected range.
Item {
    id: page

    property var readings: []
    property string rangeKey: '7d'
    property string unit: 'mgdl'
    signal rangeSelected(string key)

    readonly property var filtered: page.readings
    readonly property var series: Model.chartSeries(filtered, unit)
    readonly property var points: Model.downsample(series.points, 400)
    readonly property var labels: Model.thinLabels(series.labels, Math.max(2, Math.floor(chartCard.width / Style.space(70))))
    readonly property var axis: {
        var top = 0
        for (var i = 0; i < page.points.length; i++) top = Math.max(top, page.points[i].value)
        return Model.chartScale(top, page.unit)
    }
    readonly property var st: Model.stats(filtered)
    readonly property var dist: Model.distribution(filtered)
    readonly property string unitText: Model.unitLabel(unit)
    readonly property color muted: Util.alpha(Color.popups.text, 0.6)

    // Keyboard scrolling (j / k, Up / Down, PageUp / PageDown).
    function scrollBy(dy) {
        var maxY = Math.max(0, flick.contentHeight - flick.height)
        flick.contentY = Math.max(0, Math.min(maxY, flick.contentY + dy))
    }
    function scrollStep(direction) { scrollBy(direction * Style.space(48)) }
    function scrollPage(direction) { scrollBy(direction * Math.max(Style.space(48), flick.height * 0.9)) }

    component Stat: Column {
        property string label: ''
        property string value: ''
        property color valueColor: Color.popups.text
        PlainLabel { text: parent.label; color: page.muted; font.pixelSize: Style.font.caption }
        PlainLabel { text: parent.value; color: parent.valueColor; font.pixelSize: Style.font.heading; font.bold: true }
    }

    Flickable {
        id: flick
        anchors.fill: parent
        anchors.rightMargin: Style.space(10)
        contentWidth: width
        contentHeight: content.implicitHeight + Style.space(12)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        QQC.ScrollBar.vertical: vbar

        Column {
            id: content
            width: flick.width
            spacing: Style.space(12)

            RangeSelector {
                anchors.horizontalCenter: parent.horizontalCenter
                rangeKey: page.rangeKey
                onRangeSelected: function (key) { page.rangeSelected(key) }
            }

            PlainLabel {
                width: parent.width
                visible: page.filtered.length === 0
                horizontalAlignment: Text.AlignHCenter
                topPadding: Style.space(40)
                text: 'No readings in this range.'
                color: page.muted
            }

            Card {
                id: chartCard
                width: parent.width
                visible: page.filtered.length > 0
                height: chartColumn.implicitHeight + Style.space(24)

                Column {
                    id: chartColumn
                    anchors.fill: parent
                    anchors.margins: Style.space(12)
                    spacing: Style.space(8)

                    Item {
                        width: parent.width
                        height: chartTitle.implicitHeight
                        PlainLabel {
                            id: chartTitle
                            text: 'Glucose (' + page.unitText + ')'
                            font.pixelSize: Style.font.subtitle
                            font.bold: true
                        }
                        Row {
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: Style.space(5)
                            Rectangle {
                                width: Style.space(10)
                                height: Style.space(8)
                                radius: 2
                                color: Util.alpha(Model.category('inRange').color, 0.35)
                                anchors.verticalCenter: parent.verticalCenter
                            }
                            PlainLabel {
                                text: 'Target ' + Model.categoryRange('inRange', page.unit, '') + ' before meals, under '
                                    + Model.formatGlucose(Model.POSTMEAL_TARGET_HIGH, page.unit) + ' after'
                                color: page.muted
                                font.pixelSize: Style.font.caption
                            }
                        }
                    }

                    GlucoseChart {
                        width: parent.width
                        height: Style.space(200)
                        points: page.points
                        labels: page.labels
                        axis: page.axis
                        bandColor: Model.category('inRange').color
                    }
                }
            }

            Card {
                width: parent.width
                visible: page.filtered.length > 0
                height: statsColumn.implicitHeight + Style.space(24)

                Column {
                    id: statsColumn
                    anchors.fill: parent
                    anchors.margins: Style.space(12)
                    spacing: Style.space(10)

                    PlainLabel { text: 'Summary'; font.pixelSize: Style.font.subtitle; font.bold: true }

                    Flow {
                        width: parent.width
                        spacing: Style.space(24)
                        Stat { label: 'Average'; value: page.st.count ? Model.formatGlucose(page.st.mean, page.unit) : '—' }
                        Stat { label: 'SD'; value: page.st.count ? Model.formatGlucose(page.st.sd, page.unit) : '—' }
                        Stat { label: 'CV'; value: page.st.count ? page.st.cv + '%' : '—' }
                        Stat {
                            label: 'Min – max'
                            value: page.st.count ? Model.formatGlucose(page.st.min, page.unit) + '–' + Model.formatGlucose(page.st.max, page.unit) : '—'
                        }
                        Stat { label: 'Est. A1C'; value: page.st.count ? page.st.eA1c.toFixed(1) + '%' : '—' }
                    }

                    PlainLabel {
                        width: parent.width
                        wrapMode: Text.WordWrap
                        elide: Text.ElideNone
                        text: 'Based on ' + page.st.count + (page.st.count === 1 ? ' reading' : ' readings') + ' in ' + page.unitText
                            + '. CV at or below 36% means stable glucose. Est. A1C is a rough guide from finger-stick averages, not a lab result.'
                        color: page.muted
                        font.pixelSize: Style.font.bodySmall
                    }
                }
            }

            Card {
                width: parent.width
                visible: page.filtered.length > 0
                height: tirColumn.implicitHeight + Style.space(24)

                Column {
                    id: tirColumn
                    anchors.fill: parent
                    anchors.margins: Style.space(12)
                    spacing: Style.space(8)

                    PlainLabel { text: 'Readings by range'; font.pixelSize: Style.font.subtitle; font.bold: true }

                    RangeDistribution {
                        width: parent.width
                        items: page.dist
                        unit: page.unit
                    }
                }
            }
        }
    }

    // Sibling of the flickable so it can sit at the page edge.
    QQC.ScrollBar {
        id: vbar
        anchors.top: page.top
        anchors.bottom: page.bottom
        anchors.right: page.right
        policy: QQC.ScrollBar.AsNeeded
    }
}
