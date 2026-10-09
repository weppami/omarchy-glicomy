import QtQuick
import qs.Commons
import "../Model.js" as Model

// Readings by range: one stacked bar (Very low .. Very high) and a legend
// row per category with its range before and after meals in the display
// unit and its share. Each reading is counted by its own context.
// `items` is Model.distribution() output.
Column {
    id: dist

    property var items: []
    property string unit: 'mgdl'
    readonly property color muted: Util.alpha(Color.popups.text, 0.6)
    readonly property real labelWidth: Style.space(100)
    readonly property real rangeWidth: Style.space(90)
    // Percentages are rounded per category; scale so the bar fills the width.
    readonly property int pctTotal: {
        var sum = 0
        for (var i = 0; i < (dist.items || []).length; i++) sum += dist.items[i].pct
        return sum
    }

    spacing: Style.space(8)

    Rectangle {
        width: parent.width
        height: Style.space(14)
        radius: height / 2
        color: Util.alpha(Color.popups.text, 0.08)
        clip: true

        Row {
            anchors.fill: parent
            Repeater {
                model: dist.items
                delegate: Rectangle {
                    required property var modelData
                    width: dist.pctTotal > 0 ? dist.width * modelData.pct / dist.pctTotal : 0
                    height: parent.height
                    color: modelData.color
                }
            }
        }
    }

    Row {
        spacing: Style.space(8)
        Item { width: Style.space(10) + dist.labelWidth; height: 1 }
        PlainLabel { width: dist.rangeWidth; text: 'Before meals'; color: dist.muted; font.pixelSize: Style.font.caption; font.bold: true }
        PlainLabel { width: dist.rangeWidth; text: 'After meals'; color: dist.muted; font.pixelSize: Style.font.caption; font.bold: true }
    }

    Repeater {
        model: dist.items
        delegate: Row {
            id: legendRow
            required property var modelData
            width: dist.width
            spacing: Style.space(8)

            Rectangle {
                width: Style.space(10)
                height: width
                radius: width / 2
                color: legendRow.modelData.color
                anchors.verticalCenter: parent.verticalCenter
            }
            PlainLabel {
                width: dist.labelWidth
                text: legendRow.modelData.label
                font.bold: true
            }
            PlainLabel {
                width: dist.rangeWidth
                text: Model.categoryRange(legendRow.modelData.key, dist.unit, '') || '—'
                color: dist.muted
            }
            PlainLabel {
                width: dist.rangeWidth
                text: Model.categoryRange(legendRow.modelData.key, dist.unit, 'After meal') || '—'
                color: dist.muted
            }
            PlainLabel {
                width: Style.space(44)
                horizontalAlignment: Text.AlignRight
                text: legendRow.modelData.pct + '%'
                font.bold: true
            }
        }
    }
}
