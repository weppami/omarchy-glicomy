import QtQuick
import QtQuick.Controls as QQC
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// Glucose range reference: colour, label and range before and after meals
// in the display unit for each category, the hypo / high warnings, the
// source note and the medical disclaimer.
Item {
    id: info

    property string unit: 'mgdl'

    signal closeRequested()

    readonly property color muted: Util.alpha(Color.popups.text, 0.6)

    // Keyboard scrolling (j / k, Up / Down, PageUp / PageDown).
    function scrollBy(dy) {
        var maxY = Math.max(0, flick.contentHeight - flick.height)
        flick.contentY = Math.max(0, Math.min(maxY, flick.contentY + dy))
    }
    function scrollStep(direction) { scrollBy(direction * Style.space(48)) }
    function scrollPage(direction) { scrollBy(direction * Math.max(Style.space(48), flick.height * 0.9)) }

    component Warning: Rectangle {
        property alias text: warningLabel.text
        property color tone: Color.urgent
        width: parent.width
        height: warningLabel.implicitHeight + Style.space(20)
        radius: Math.max(8, Style.cornerRadius)
        color: Util.alpha(tone, 0.18)
        border.width: 1
        border.color: tone

        PlainLabel {
            id: warningLabel
            anchors.fill: parent
            anchors.margins: Style.space(10)
            wrapMode: Text.WordWrap
            elide: Text.ElideNone
        }
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
            spacing: Style.space(10)

            Item {
                width: parent.width
                height: backButton.implicitHeight
                PlainLabel {
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    text: 'Glucose ranges (' + Model.unitLabel(info.unit) + ')'
                    font.pixelSize: Style.font.heading
                    font.bold: true
                }
                Button {
                    id: backButton
                    anchors.right: parent.right
                    text: 'Done'
                    bordered: true
                    foreground: Color.popups.text
                    onClicked: info.closeRequested()
                }
            }

            Card {
                width: parent.width
                height: categories.implicitHeight + Style.space(20)

                Column {
                    id: categories
                    anchors.fill: parent
                    anchors.margins: Style.space(10)
                    spacing: Style.space(8)

                    Row {
                        spacing: Style.space(10)
                        Item { width: Style.space(12) + Style.space(170) + Style.space(10); height: 1 }
                        PlainLabel { width: Style.space(110); text: 'Before meals'; color: info.muted; font.bold: true; font.pixelSize: Style.font.caption }
                        PlainLabel { text: 'After meals (1–2 h)'; color: info.muted; font.bold: true; font.pixelSize: Style.font.caption }
                    }

                    Repeater {
                        model: Model.CATEGORIES
                        delegate: Row {
                            required property var modelData
                            spacing: Style.space(10)
                            Rectangle {
                                width: Style.space(12)
                                height: width
                                radius: width / 2
                                color: modelData.color
                                anchors.verticalCenter: parent.verticalCenter
                            }
                            PlainLabel {
                                width: Style.space(170)
                                text: modelData.longLabel
                                font.bold: true
                                anchors.verticalCenter: parent.verticalCenter
                            }
                            PlainLabel {
                                width: Style.space(110)
                                text: Model.categoryRange(modelData.key, info.unit, '') || '—'
                                anchors.verticalCenter: parent.verticalCenter
                            }
                            PlainLabel {
                                text: Model.categoryRange(modelData.key, info.unit, 'After meal') || '—'
                                anchors.verticalCenter: parent.verticalCenter
                            }
                        }
                    }
                }
            }

            Warning {
                text: Model.LOW_WARNING
                tone: Model.category('veryLow').color
            }

            Warning {
                text: Model.HIGH_WARNING
                tone: Model.category('veryHigh').color
            }

            PlainLabel {
                width: parent.width
                wrapMode: Text.WordWrap
                elide: Text.ElideNone
                text: 'Targets follow the American Diabetes Association Standards of Care for most non-pregnant adults with diabetes: '
                    + '80–130 mg/dL (4.4–7.2 mmol/L) before meals and under 180 mg/dL (10.0 mmol/L) 1–2 hours after a meal. '
                    + 'A reading uses the after-meal goals only when its context is After meal; every other context uses the before-meal goals. '
                    + 'Below 70 mg/dL is low and below 54 mg/dL very low at any time. Older or high-risk adults and pregnancy use '
                    + 'different targets; your care team may set your own.'
                color: info.muted
            }

            PlainLabel {
                width: parent.width
                wrapMode: Text.WordWrap
                elide: Text.ElideNone
                text: 'Glicomy does not measure glucose and is not a medical device. Never change insulin or medication doses based on this app alone; '
                    + 'always check with your doctor before making medical decisions.'
                color: info.muted
                font.italic: true
            }
        }
    }

    // Sibling of the flickable so it can sit at the page edge.
    QQC.ScrollBar {
        id: vbar
        anchors.top: info.top
        anchors.bottom: info.bottom
        anchors.right: info.right
        policy: QQC.ScrollBar.AsNeeded
    }
}
