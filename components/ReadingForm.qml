import QtQuick
import qs.Commons
import qs.Ui
import "../Model.js" as Model

// Add / edit form for one reading. Created fresh by a Loader for every use,
// so initial values come from `reading` (null for a new reading). Glucose is
// typed in the display unit and converted to mg/dL on save. Return,
// Ctrl+Enter and Ctrl+S reach Panel.qml's key handler, which calls submit();
// the fields do not submit on `accepted` themselves, so a save never runs
// twice for one key press.
Item {
    id: form

    property var reading: null
    property string profileId: ''
    property string unit: 'mgdl'
    // Pre-filled glucose (mg/dL) for a new reading, usually the last value.
    property int defaultGlucose: 100
    readonly property bool editing: reading !== null

    property string context: reading ? reading.context : ''
    property string errorText: ''

    readonly property var initialAt: Model.splitAt(reading ? reading.at : Model.toAt(new Date()))
    readonly property bool mmol: Model.normalizeUnit(unit) === 'mmol'
    readonly property var typedGlucose: Model.parseGlucose(glucoseField.text, unit)
    readonly property bool glucoseValid: typedGlucose !== null
        && typedGlucose >= Model.LIMITS.glucose.min && typedGlucose <= Model.LIMITS.glucose.max
    readonly property string categoryKey: glucoseValid ? Model.categoryOf(typedGlucose, context) : ''
    readonly property var category: Model.category(categoryKey)
    readonly property real gap: Style.space(12)
    readonly property real third: (width - 2 * gap) / 3
    readonly property color muted: Util.alpha(Color.popups.text, 0.6)

    signal saved(var value)
    signal canceled()

    implicitHeight: column.implicitHeight

    function optionsFor(list) {
        var out = []
        for (var i = 0; i < list.length; i++)
            out.push({ value: list[i], label: list[i] === '' ? '—' : Model.plain(list[i], 40) })
        return out
    }

    // ----------------------------------------------------------- keyboard
    //
    // Focus order: Glucose, Carbs, Insulin, Context, Date, Time, Note,
    // Cancel, Save. It matches the item order, so Qt's own Tab chain (used
    // when a control handles Tab itself) walks the same sequence.

    // The focusable trigger inside a host Dropdown.
    function focusableIn(item) {
        var kids = item ? item.children : []
        for (var i = 0; i < kids.length; i++) {
            if (kids[i].activeFocusOnTab) return kids[i]
            var inner = form.focusableIn(kids[i])
            if (inner) return inner
        }
        return null
    }

    function focusTargets() {
        return [glucoseField, carbsField, insulinField, form.focusableIn(contextDrop),
            dateField, timeField, noteField, cancelButton, saveButton]
    }

    function focusedIndex() {
        var targets = form.focusTargets()
        for (var i = 0; i < targets.length; i++)
            if (targets[i] && targets[i].activeFocus) return i
        return -1
    }

    function focusAt(index) {
        var target = form.focusTargets()[index]
        if (target) target.forceActiveFocus(Qt.TabFocusReason)
    }

    function focusFirst() { form.focusAt(0) }

    function focusNext(step) {
        var count = form.focusTargets().length
        var current = form.focusedIndex()
        var next = current < 0 ? (step > 0 ? 0 : count - 1) : (current + step + count) % count
        form.focusAt(next)
    }

    // The control that has keyboard focus, for the focus ring. Reading each
    // target's activeFocus here makes the binding follow focus changes.
    readonly property Item ringTarget: {
        var targets = form.focusTargets()
        for (var i = 0; i < targets.length; i++)
            if (targets[i] && targets[i].activeFocus) return targets[i]
        return null
    }

    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

    // Up / Down (small) and PageUp / PageDown (large) on a numeric field.
    // Returns false when no numeric field has focus, so the key stays with
    // the focused control.
    function stepFocused(direction, large) {
        var field = null
        if (glucoseField.activeFocus) {
            var mg = form.typedGlucose !== null ? form.typedGlucose : form.defaultGlucose
            if (form.mmol) {
                var shown = Model.toDisplay(mg, 'mmol') + direction * (large ? 1 : 0.1)
                mg = Model.parseGlucose((Math.round(shown * 10) / 10).toFixed(1), 'mmol')
            } else {
                mg += direction * (large ? 10 : 1)
            }
            glucoseField.text = Model.formatGlucose(form.clamp(mg, Model.LIMITS.glucose.min, Model.LIMITS.glucose.max), form.unit)
            field = glucoseField
        } else if (carbsField.activeFocus) {
            var carbs = parseInt(carbsField.text, 10)
            if (!isFinite(carbs)) carbs = 0
            carbsField.text = String(form.clamp(carbs + direction * (large ? 10 : 1), Model.LIMITS.carbs.min, Model.LIMITS.carbs.max))
            field = carbsField
        } else if (insulinField.activeFocus) {
            var units = Number(String(insulinField.text).replace(',', '.'))
            if (!isFinite(units) || String(insulinField.text).trim() === '') units = 0
            var next = Math.round((units + direction * (large ? 5 : 0.5)) * 10) / 10
            insulinField.text = Model.formatInsulin(form.clamp(next, Model.LIMITS.insulin.min, Model.LIMITS.insulin.max))
            field = insulinField
        }
        if (!field) return false
        field.selectAll()
        return true
    }

    // Typing replaces a value when a field is entered by keyboard.
    function selectOnFocus(input) {
        if (input && input.activeFocus && input.selectAll) input.selectAll()
    }

    function submit() {
        var at = Model.joinAt(dateField.text, timeField.text)
        if (!at) {
            form.errorText = 'Enter the date as YYYY-MM-DD and the time as HH:MM.'
            return
        }
        var mg = Model.parseGlucose(glucoseField.text, form.unit)
        if (mg === null) {
            form.errorText = form.mmol ? 'Enter glucose in mmol/L, for example 6.4.' : 'Enter glucose in mg/dL as a whole number, for example 115.'
            return
        }
        var result = Model.validateReading({
            id: form.reading ? form.reading.id : undefined,
            profileId: form.profileId,
            at: at,
            glucose: mg,
            context: form.context,
            carbs: carbsField.text,
            insulin: insulinField.text,
            note: noteField.text
        })
        if (!result.ok) {
            form.errorText = result.errors.join(' ')
            return
        }
        form.errorText = ''
        form.saved(result.value)
    }

    component FieldLabel: PlainLabel {
        color: form.muted
        font.pixelSize: Style.font.caption
        font.bold: true
    }

    Column {
        id: column
        width: parent.width
        spacing: Style.space(12)

        Row {
            width: parent.width
            spacing: Style.space(8)
            PlainLabel {
                text: form.editing ? 'Edit reading' : 'New reading'
                color: form.muted
                font.pixelSize: Style.font.subtitle
                anchors.verticalCenter: parent.verticalCenter
            }
            PlainLabel {
                text: form.glucoseValid ? form.category.longLabel : '—'
                color: form.glucoseValid ? form.category.color : form.muted
                font.pixelSize: Style.font.heading
                font.bold: true
                anchors.verticalCenter: parent.verticalCenter
            }
        }

        CategoryBar {
            width: parent.width
            categoryKey: form.categoryKey
            opacity: form.glucoseValid ? 1 : 0.4
        }

        PlainLabel {
            width: parent.width
            text: 'Goals: ' + Model.tableFor(form.context).label.toLowerCase() + ', in target '
                + Model.categoryRange('inRange', form.unit, form.context) + ' ' + Model.unitLabel(form.unit)
                + (form.context === 'After meal' ? '' : '. Set Context to After meal for readings 1–2 h after eating.')
            color: form.muted
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            elide: Text.ElideNone
        }

        Row {
            spacing: form.gap
            Column {
                spacing: Style.spacing.labelGap
                FieldLabel { text: 'Glucose (' + Model.unitLabel(form.unit) + ')' }
                TextField {
                    id: glucoseField
                    width: form.third
                    text: Model.formatGlucose(form.reading ? form.reading.glucose : form.defaultGlucose, form.unit)
                    maximumLength: 5
                    placeholderText: form.mmol ? '5.5' : '100'
                    font.pixelSize: Style.font.heading
                    font.bold: true
                    horizontalAlignment: TextInput.AlignHCenter
                    color: form.glucoseValid ? form.category.color : Color.popups.text
                    foreground: Color.popups.text
                    validator: RegularExpressionValidator { regularExpression: /[0-9.,]{0,5}/ }
                    onActiveFocusChanged: form.selectOnFocus(glucoseField)
                }
            }
            Column {
                spacing: Style.spacing.labelGap
                FieldLabel { text: 'Carbs (g)' }
                TextField {
                    id: carbsField
                    width: form.third
                    text: form.reading && form.reading.carbs !== null ? String(form.reading.carbs) : ''
                    maximumLength: 3
                    placeholderText: 'Optional'
                    foreground: Color.popups.text
                    validator: RegularExpressionValidator { regularExpression: /[0-9]{0,3}/ }
                    onActiveFocusChanged: form.selectOnFocus(carbsField)
                }
            }
            Column {
                spacing: Style.spacing.labelGap
                FieldLabel { text: 'Insulin (units)' }
                TextField {
                    id: insulinField
                    width: form.third
                    text: form.reading ? Model.formatInsulin(form.reading.insulin) : ''
                    maximumLength: 5
                    placeholderText: 'Optional'
                    foreground: Color.popups.text
                    validator: RegularExpressionValidator { regularExpression: /[0-9.,]{0,5}/ }
                    onActiveFocusChanged: form.selectOnFocus(insulinField)
                }
            }
        }

        Row {
            spacing: form.gap
            Dropdown {
                id: contextDrop
                width: form.third
                label: 'Context'
                options: form.optionsFor(Model.CONTEXTS)
                value: form.context
                onChanged: function (v) { form.context = v }
            }
            Column {
                spacing: Style.spacing.labelGap
                FieldLabel { text: 'Date (YYYY-MM-DD)' }
                TextField {
                    id: dateField
                    width: form.third
                    text: form.initialAt.date
                    maximumLength: 10
                    placeholderText: 'YYYY-MM-DD'
                    foreground: Color.popups.text
                    validator: RegularExpressionValidator { regularExpression: /[0-9-]{0,10}/ }
                    onActiveFocusChanged: form.selectOnFocus(dateField)
                }
            }
            Column {
                spacing: Style.spacing.labelGap
                FieldLabel { text: 'Time (HH:MM)' }
                TextField {
                    id: timeField
                    width: form.third
                    text: form.initialAt.time
                    maximumLength: 5
                    placeholderText: 'HH:MM'
                    foreground: Color.popups.text
                    validator: RegularExpressionValidator { regularExpression: /[0-9:]{0,5}/ }
                    onActiveFocusChanged: form.selectOnFocus(timeField)
                }
            }
        }

        Column {
            width: parent.width
            spacing: Style.spacing.labelGap
            FieldLabel { text: 'Note' }
            TextField {
                id: noteField
                width: parent.width
                text: form.reading ? form.reading.note : ''
                maximumLength: Model.LIMITS.noteMax
                placeholderText: 'Optional, up to ' + Model.LIMITS.noteMax + ' characters'
                foreground: Color.popups.text
            }
        }

        PlainLabel {
            width: parent.width
            visible: form.errorText !== ''
            text: form.errorText
            color: Color.urgent
            wrapMode: Text.WordWrap
            elide: Text.ElideNone
        }

        Row {
            anchors.right: parent.right
            spacing: Style.space(8)
            Button {
                id: cancelButton
                text: 'Cancel'
                focusable: true
                bordered: true
                foreground: Color.popups.text
                onClicked: form.canceled()
            }
            Button {
                id: saveButton
                text: form.editing ? 'Save changes' : 'Save'
                focusable: true
                bordered: true
                selected: true
                foreground: Color.popups.text
                onClicked: form.submit()
            }
        }
    }

    // Accent ring around the focused control, so keyboard focus is always
    // visible whatever the theme's own focus styling is.
    Rectangle {
        id: focusRing
        readonly property real pad: 3
        readonly property point origin: form.ringTarget && form.width > 0
            ? form.ringTarget.mapToItem(form, 0, 0) : Qt.point(0, 0)
        visible: form.ringTarget !== null
        enabled: false
        z: 50
        x: origin.x - pad
        y: origin.y - pad
        width: form.ringTarget ? form.ringTarget.width + pad * 2 : 0
        height: form.ringTarget ? form.ringTarget.height + pad * 2 : 0
        radius: Style.cornerRadius + pad
        color: 'transparent'
        border.width: 2
        border.color: Color.accent
    }
}
