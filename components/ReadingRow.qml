import QtQuick
import qs.Commons
import "../Model.js" as Model

// One reading as a card: time and category on the left, the glucose value
// in the display unit, context / carbs / insulin / note below, and a delete
// action. Clicking the card asks to edit the reading.
Card {
    id: row

    property var reading: null
    property string unit: 'mgdl'
    // Keyboard selection: drawn as an accent border.
    property bool selected: false
    readonly property string categoryKey: reading ? Model.categoryOf(reading.glucose, reading.context) : 'inRange'
    readonly property color categoryColor: Model.category(categoryKey).color
    readonly property color fg: Color.popups.text
    readonly property color muted: Util.alpha(fg, 0.6)

    signal editRequested()
    signal deleteRequested()

    implicitHeight: content.implicitHeight + Style.space(20)
    color: hover.hovered || selected ? Util.alpha(fg, 0.1) : Util.alpha(fg, 0.06)
    border.width: selected ? 2 : 1
    border.color: selected ? Color.accent : Util.alpha(fg, 0.08)

    HoverHandler { id: hover }

    MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: row.editRequested()
    }

    Column {
        id: content
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Style.space(12)
        anchors.rightMargin: Style.space(8)
        spacing: Style.space(4)

        Item {
            width: parent.width
            height: Math.max(leftColumn.implicitHeight, values.implicitHeight)

            Column {
                id: leftColumn
                anchors.left: parent.left
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(4)
                width: Style.space(96)

                PlainLabel {
                    text: row.reading ? Model.formatTime(row.reading.at) : ''
                    color: row.muted
                    font.pixelSize: Style.font.bodySmall
                }
                CategoryBadge { categoryKey: row.categoryKey }
            }

            Row {
                id: values
                anchors.left: leftColumn.right
                anchors.right: deleteButton.left
                anchors.verticalCenter: parent.verticalCenter
                spacing: Style.space(6)

                PlainLabel {
                    id: valueLabel
                    anchors.verticalCenter: parent.verticalCenter
                    text: row.reading ? Model.formatGlucose(row.reading.glucose, row.unit) : ''
                    color: row.categoryColor
                    font.pixelSize: Style.font.display
                    font.bold: true
                }
                PlainLabel {
                    anchors.baseline: valueLabel.baseline
                    text: Model.unitLabel(row.unit)
                    color: row.muted
                    font.pixelSize: Style.font.caption
                }
            }

            Rectangle {
                id: deleteButton
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                width: Style.space(28)
                height: Style.space(28)
                radius: width / 2
                color: deleteArea.containsMouse ? Util.alpha(Color.urgent, 0.25) : 'transparent'

                Text {
                    textFormat: Text.PlainText
                    anchors.centerIn: parent
                    text: '✕'
                    color: deleteArea.containsMouse ? Color.urgent : row.muted
                    font.family: Style.font.family
                    font.pixelSize: Style.font.body
                }

                MouseArea {
                    id: deleteArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: row.deleteRequested()
                }
            }
        }

        PlainLabel {
            width: parent.width
            visible: text !== ''
            text: Model.readingDetails(row.reading)
            color: row.muted
            font.pixelSize: Style.font.bodySmall
            maximumLineCount: 1
        }
    }
}
