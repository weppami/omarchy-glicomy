"""Dependency-free PDF 1.4 writer for Glicomy glucose reports.

Only the standard library is used, so the helper can run under
`python3 -I -S`. The output uses the base-14 Helvetica fonts with
WinAnsiEncoding, uncompressed content streams and a classic xref table.

Public entry point:

    build_report(profile_name, profile_color_hex, range_label, unit_label, band,
                 rows, distribution, stats, generated_at) -> bytes

`unit_label` is "mg/dL" or "mmol/L"; `band` is (low, high, after_meal) in
that unit: the before-meal target range and the after-meal upper limit. `rows` are already filtered, sorted oldest first and shaped
by the caller:
    {"when": datetime, "date": "Oct 6, 2026", "time": "7:33 AM",
     "value": float, "text": "128", "category": "In range", "color": "#rrggbb",
     "context": str, "carbs": str, "insulin": str, "note": str}
`distribution` is one entry per category, in display order, with its range
before and after meals ("" when that table does not use the category):
    {"label": "Low", "color": "#ef4444", "premeal": "54-69", "postmeal": "54-69", "pct": int}
`stats` is a list of (label, value) pairs drawn beside the distribution bar.

The module knows nothing about glucose rules; it only draws.
"""
import datetime
import math

PDF_VERSION = b"%PDF-1.4"
PAGE_WIDTH, PAGE_HEIGHT = 595.0, 842.0
MARGIN = 40.0
CONTENT_WIDTH = PAGE_WIDTH - 2 * MARGIN

# Vertical layout, measured from the top of the page.
HEADER_HEIGHT = 56.0
CHART_TITLE_TOP = 76.0
CHART_TOP, CHART_HEIGHT = 96.0, 190.0
TIR_TITLE_TOP = 322.0
TIR_BAR_TOP, TIR_BAR_HEIGHT = 336.0, 14.0
TIR_LEGEND_TOP = 366.0
LEGEND_ROW = 15.0
TABLE_TOP_FIRST = 492.0
TABLE_TOP_NEXT = 76.0
FOOTER_SPACE = 50.0
HEADER_ROW_HEIGHT = 20.0
ROW_HEIGHT = 18.0
ROWS_FIRST_PAGE = int((PAGE_HEIGHT - TABLE_TOP_FIRST - FOOTER_SPACE - HEADER_ROW_HEIGHT) // ROW_HEIGHT)
ROWS_PER_PAGE = int((PAGE_HEIGHT - TABLE_TOP_NEXT - FOOTER_SPACE - HEADER_ROW_HEIGHT) // ROW_HEIGHT)
MAX_DAY_LABELS = 8

LINE_COLOR = "#9ca3af"
BAND_COLOR = "#22c55e"
BAND_ALPHA = 0.12
# The glucose column header gets the unit appended at render time.
COLUMNS = (("Date", 125.0, "left"), ("Glucose", 70.0, "center"), ("Category", 65.0, "left"),
           ("Context", 75.0, "left"), ("Carbs g", 45.0, "center"), ("Insulin u", 50.0, "center"),
           ("Note", 85.0, "left"))

INK = "#111827"
MUTED = "#6b7280"
RULE = "#e5e7eb"
GRID = "#eef0f3"
ZEBRA = "#f9fafb"
HEADER_FILL = "#f3f4f6"
WHITE = "#ffffff"
TINT_ALPHA = 0.15
BEZIER_K = 0.5522847498

# Advance widths (1/1000 em) for WinAnsi codes 32..126 from the Adobe AFM files.
_HELVETICA = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
)
_HELVETICA_BOLD = (
    278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
    975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
    333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611,
    611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
)
DEFAULT_GLYPH_WIDTH = 556


# ------------------------------------------------------------ primitives

def pdf_string(text):
    """Encode text as a WinAnsi literal string with delimiters escaped."""
    raw = str(text).encode("cp1252", "replace")
    raw = raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    raw = raw.replace(b"\r", b"\\r").replace(b"\n", b"\\n")
    return b"(" + raw + b")"


def text_width(text, size, bold):
    table = _HELVETICA_BOLD if bold else _HELVETICA
    total = 0
    for byte in str(text).encode("cp1252", "replace"):
        total += table[byte - 32] if 32 <= byte <= 126 else DEFAULT_GLYPH_WIDTH
    return total * size / 1000.0


def hex_to_rgb(color):
    value = color.lstrip("#")
    return tuple(int(value[index:index + 2], 16) / 255.0 for index in (0, 2, 4))


def blend_with_white(color, alpha):
    """PDF 1.4 content has no alpha without ExtGState; approximate it over white."""
    return tuple(channel * alpha + (1.0 - alpha) for channel in hex_to_rgb(color))


def fmt(number):
    """Short numeric literal: no exponent, no trailing zeros."""
    text = "%.3f" % number
    text = text.rstrip("0").rstrip(".")
    return text if text not in ("", "-0") else "0"


class PdfDoc:
    """A minimal multi-page PDF document with one content stream per page."""

    def __init__(self):
        self._pages = []
        self._current = None

    @property
    def page_count(self):
        return len(self._pages)

    def page(self):
        """Start a new page, make it current and return its index."""
        self._pages.append([])
        self._current = self._pages[-1]
        return len(self._pages) - 1

    def select(self, index):
        self._current = self._pages[index]

    def _emit(self, line):
        self._current.append(line)

    def _rgb(self, color):
        return " ".join(fmt(channel) for channel in (hex_to_rgb(color) if isinstance(color, str) else color))

    def set_color(self, color, stroke=False):
        self._emit("%s %s" % (self._rgb(color), "RG" if stroke else "rg"))

    def set_line_width(self, width):
        self._emit("%s w" % fmt(width))

    def text(self, x, y, value, size=10, bold=False, align="left", color=None):
        if color is not None:
            self.set_color(color)
        width = text_width(value, size, bold)
        if align == "right":
            x -= width
        elif align == "center":
            x -= width / 2.0
        self._emit("BT /%s %s Tf %s %s Td %s Tj ET" % (
            "F2" if bold else "F1", fmt(size), fmt(x), fmt(y), pdf_string(value).decode("latin-1")))

    def line(self, x1, y1, x2, y2, width=1.0, color=None):
        if color is not None:
            self.set_color(color, stroke=True)
        self.set_line_width(width)
        self._emit("%s %s m\n%s %s l\nS" % (fmt(x1), fmt(y1), fmt(x2), fmt(y2)))

    def polyline(self, points, width=1.0, color=None):
        if len(points) < 2:
            return
        if color is not None:
            self.set_color(color, stroke=True)
        self.set_line_width(width)
        parts = ["%s %s m" % (fmt(points[0][0]), fmt(points[0][1]))]
        parts.extend("%s %s l" % (fmt(x), fmt(y)) for x, y in points[1:])
        parts.append("S")
        self._emit("\n".join(parts))

    def rect(self, x, y, width, height, fill=None, stroke=None, line_width=1.0):
        if fill is not None:
            self.set_color(fill)
        if stroke is not None:
            self.set_color(stroke, stroke=True)
            self.set_line_width(line_width)
        operator = "B" if fill is not None and stroke is not None else ("S" if stroke is not None else "f")
        self._emit("%s %s %s %s re\n%s" % (fmt(x), fmt(y), fmt(width), fmt(height), operator))

    def circle(self, cx, cy, radius, fill=None):
        if fill is not None:
            self.set_color(fill)
        k = radius * BEZIER_K
        self._emit("%s %s m" % (fmt(cx + radius), fmt(cy)))
        self._emit("%s %s %s %s %s %s c" % (fmt(cx + radius), fmt(cy + k), fmt(cx + k), fmt(cy + radius), fmt(cx), fmt(cy + radius)))
        self._emit("%s %s %s %s %s %s c" % (fmt(cx - k), fmt(cy + radius), fmt(cx - radius), fmt(cy + k), fmt(cx - radius), fmt(cy)))
        self._emit("%s %s %s %s %s %s c" % (fmt(cx - radius), fmt(cy - k), fmt(cx - k), fmt(cy - radius), fmt(cx), fmt(cy - radius)))
        self._emit("%s %s %s %s %s %s c" % (fmt(cx + k), fmt(cy - radius), fmt(cx + radius), fmt(cy - k), fmt(cx + radius), fmt(cy)))
        self._emit("f")

    def render(self):
        """Serialise the document with a correct cross-reference table."""
        objects = [
            b"<< /Type /Catalog /Pages 2 0 R >>",
            None,  # the page tree is filled in once the page object numbers are known
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
            b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
        ]
        kids = []
        for content in self._pages or [[]]:
            page_number = len(objects) + 1
            stream = ("\n".join(content) + "\n").encode("latin-1")
            objects.append(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s %s] "
                b"/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents %d 0 R >>"
                % (fmt(PAGE_WIDTH).encode(), fmt(PAGE_HEIGHT).encode(), page_number + 1))
            objects.append(b"<< /Length %d >>\nstream\n" % len(stream) + stream + b"endstream")
            kids.append(b"%d 0 R" % page_number)
        objects[1] = b"<< /Type /Pages /Kids [" + b" ".join(kids) + b"] /Count %d >>" % len(kids)

        out = bytearray(PDF_VERSION + b"\n%\xe2\xe3\xcf\xd3\n")
        offsets = []
        for number, body in enumerate(objects, start=1):
            offsets.append(len(out))
            out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
        xref_offset = len(out)
        out += b"xref\n0 %d\n" % (len(objects) + 1)
        out += b"0000000000 65535 f \n"
        for offset in offsets:
            out += b"%010d 00000 n \n" % offset
        out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref_offset)
        return bytes(out)




# ---------------------------------------------------------------- report

def _top(y_from_top):
    return PAGE_HEIGHT - y_from_top


def _initial(name):
    stripped = (name or "").strip()
    return stripped[0].upper() if stripped else "?"


def _period_label(rows, range_label):
    if not rows:
        return range_label
    return "From %s to %s" % (rows[0]["date"], rows[-1]["date"])


def _fit(text, width, size, bold=False):
    """Truncate text with an ellipsis-like '...' so it fits `width` points."""
    value = str(text)
    if text_width(value, size, bold) <= width:
        return value
    while value and text_width(value + "...", size, bold) > width:
        value = value[:-1]
    return value + "..."


def _draw_header(doc, profile_name, profile_color, period_label, generated_label):
    cx, cy, radius = MARGIN + 18.0, _top(18.0), 18.0
    doc.circle(cx, cy, radius, fill=profile_color)
    doc.text(cx, cy - 5.5, _initial(profile_name), size=16, bold=True, align="center", color=WHITE)
    doc.text(MARGIN + 46.0, _top(16.0), profile_name, size=16, bold=True, color=INK)
    doc.text(MARGIN + 46.0, _top(32.0), "Glucose Report", size=10, color=MUTED)
    doc.text(PAGE_WIDTH - MARGIN, _top(16.0), period_label, size=10, align="right", color=INK)
    doc.text(PAGE_WIDTH - MARGIN, _top(32.0), generated_label, size=8, align="right", color=MUTED)
    doc.line(MARGIN, _top(HEADER_HEIGHT - 8.0), PAGE_WIDTH - MARGIN, _top(HEADER_HEIGHT - 8.0), width=0.75, color=RULE)


def _draw_footer(doc, profile_name, number, total):
    doc.text(MARGIN, 30.0, profile_name, size=8, color=MUTED)
    doc.text(PAGE_WIDTH - MARGIN, 30.0, "%d/%d" % (number, total), size=8, align="right", color=MUTED)


def _axis(rows, unit_label):
    """Y-axis top and grid step: at least 300 mg/dL (18 mmol/L), whole steps above that."""
    mmol = unit_label == "mmol/L"
    step = 3 if mmol else 50
    floor = 18 if mmol else 300
    highest = max([row["value"] for row in rows] + [0])
    return max(floor, int(math.ceil(highest / step)) * step), step


def _day_labels(rows, xs):
    labels = []
    seen = None
    for row, x in zip(rows, xs):
        key = row["when"].date()
        if key != seen:
            labels.append((x, "%s %d" % (row["when"].strftime("%b"), row["when"].day)))
            seen = key
    if len(labels) > MAX_DAY_LABELS:
        step = math.ceil(len(labels) / MAX_DAY_LABELS)
        labels = labels[::step]
    return labels


def _draw_line_chart(doc, rows, unit_label, band):
    left = MARGIN + 28.0
    right = PAGE_WIDTH - MARGIN
    bottom = _top(CHART_TOP + CHART_HEIGHT)
    top = _top(CHART_TOP)
    doc.text(MARGIN, _top(CHART_TITLE_TOP), "Glucose (%s)" % unit_label, size=12, bold=True, color=INK)

    legend = "Target %s-%s before meals, under %s after" % (_number(band[0]), _number(band[1]), _number(band[2]))
    legend_x = right - text_width(legend, 8, False)
    doc.rect(legend_x - 11.0, _top(CHART_TITLE_TOP) - 0.5, 7.0, 7.0, fill=blend_with_white(BAND_COLOR, 0.35))
    doc.text(legend_x, _top(CHART_TITLE_TOP), legend, size=8, color=INK)

    y_max, step = _axis(rows, unit_label)

    def y_of(value):
        return bottom + (top - bottom) * min(value, y_max) / y_max

    doc.rect(left, y_of(band[0]), right - left, y_of(band[1]) - y_of(band[0]),
             fill=blend_with_white(BAND_COLOR, BAND_ALPHA))
    doc.line(left, y_of(band[2]), right, y_of(band[2]), width=0.75, color=blend_with_white(BAND_COLOR, 0.6))
    for value in range(0, y_max + 1, step):
        y = y_of(value)
        doc.line(left, y, right, y, width=0.5, color=GRID)
        doc.text(left - 6.0, y - 2.5, str(value), size=7, align="right", color=MUTED)
    doc.line(left, bottom, right, bottom, width=0.75, color=RULE)

    if not rows:
        doc.text((left + right) / 2.0, (top + bottom) / 2.0, "No readings in this range", size=10, align="center", color=MUTED)
        return

    first = rows[0]["when"].timestamp()
    span = rows[-1]["when"].timestamp() - first
    pad = 10.0
    if span <= 0:
        xs = [(left + right) / 2.0] * len(rows)
    else:
        xs = [left + pad + (right - left - 2 * pad) * (row["when"].timestamp() - first) / span for row in rows]

    for x, label in _day_labels(rows, xs):
        doc.text(x, bottom - 11.0, label, size=7, align="center", color=MUTED)

    points = [(x, y_of(row["value"])) for x, row in zip(xs, rows)]
    doc.polyline(points, width=1.0, color=LINE_COLOR)
    for (x, y), row in zip(points, rows):
        doc.circle(x, y, 2.4, fill=row["color"])


def _number(value):
    """mmol/L values arrive as floats and keep one decimal ("10.0"); mg/dL values are ints."""
    return "%.1f" % value if isinstance(value, float) else str(value)


def _draw_distribution(doc, distribution, stats):
    doc.text(MARGIN, _top(TIR_TITLE_TOP), "Readings by range", size=12, bold=True, color=INK)
    bar_y = _top(TIR_BAR_TOP + TIR_BAR_HEIGHT)
    total = sum(entry["pct"] for entry in distribution)
    if total <= 0:
        doc.rect(MARGIN, bar_y, CONTENT_WIDTH, TIR_BAR_HEIGHT, fill=HEADER_FILL)
    else:
        # Percentages are rounded per category; scale so the bar fills the width.
        x = MARGIN
        for entry in distribution:
            width = CONTENT_WIDTH * entry["pct"] / total
            if width > 0:
                doc.rect(x, bar_y, width, TIR_BAR_HEIGHT, fill=entry["color"])
            x += width

    half = CONTENT_WIDTH / 2.0
    header_y = _top(TIR_LEGEND_TOP)
    doc.text(MARGIN + 80.0, header_y, "Before meals", size=7, bold=True, color=MUTED)
    doc.text(MARGIN + 145.0, header_y, "After meals", size=7, bold=True, color=MUTED)
    for index, entry in enumerate(distribution):
        y = _top(TIR_LEGEND_TOP + (index + 1) * LEGEND_ROW)
        doc.rect(MARGIN, y - 0.5, 7.0, 7.0, fill=entry["color"])
        doc.text(MARGIN + 12.0, y, entry["label"], size=8, bold=True, color=INK)
        doc.text(MARGIN + 80.0, y, entry["premeal"] or "-", size=8, color=MUTED)
        doc.text(MARGIN + 145.0, y, entry["postmeal"] or "-", size=8, color=MUTED)
        doc.text(MARGIN + 235.0, y, "%d%%" % entry["pct"], size=8, bold=True, align="right", color=INK)

    for index, (label, value) in enumerate(stats):
        y = _top(TIR_LEGEND_TOP + (index + 1) * LEGEND_ROW)
        doc.text(MARGIN + half + 20.0, y, label, size=8, color=MUTED)
        doc.text(MARGIN + half + 90.0, y, value, size=8, bold=True, color=INK)


def _draw_table_header(doc, y_top, unit_label):
    doc.rect(MARGIN, y_top - HEADER_ROW_HEIGHT, CONTENT_WIDTH, HEADER_ROW_HEIGHT, fill=HEADER_FILL)
    x = MARGIN
    for label, width, align in COLUMNS:
        text = "%s %s" % (label, unit_label) if label == "Glucose" else label
        anchor = x + 6.0 if align == "left" else x + width / 2.0
        doc.text(anchor, y_top - 13.5, text, size=8, bold=True, align=align, color=INK)
        x += width
    return y_top - HEADER_ROW_HEIGHT


def _draw_table_row(doc, y_top, row, zebra):
    if zebra:
        doc.rect(MARGIN, y_top - ROW_HEIGHT, CONTENT_WIDTH, ROW_HEIGHT, fill=ZEBRA)
    tint = blend_with_white(row["color"], TINT_ALPHA)
    cells = ("%s  %s" % (row["date"], row["time"]), row["text"], row["category"], row["context"] or "-",
             row["carbs"] or "-", row["insulin"] or "-", row["note"] or "")
    x = MARGIN
    for (label, width, align), value in zip(COLUMNS, cells):
        if label == "Glucose":
            doc.rect(x + 1.0, y_top - ROW_HEIGHT + 1.0, width - 2.0, ROW_HEIGHT - 2.0, fill=tint)
        anchor = x + 6.0 if align == "left" else x + width / 2.0
        doc.text(anchor, y_top - 12.5, _fit(value, width - 8.0, 8), size=8, align=align, color=INK)
        x += width
    return y_top - ROW_HEIGHT


def build_report(profile_name, profile_color_hex, range_label, unit_label, band, rows, distribution, stats, generated_at):
    """Render the full report and return the PDF bytes."""
    if isinstance(generated_at, datetime.datetime):
        generated_label = "Generated " + generated_at.strftime("%Y-%m-%d %H:%M")
    else:
        generated_label = "Generated " + str(generated_at)
    period_label = _period_label(rows, range_label)
    doc = PdfDoc()

    doc.page()
    _draw_header(doc, profile_name, profile_color_hex, period_label, generated_label)
    _draw_line_chart(doc, rows, unit_label, band)
    _draw_distribution(doc, distribution, stats)
    doc.text(MARGIN, _top(TABLE_TOP_FIRST - 8.0), "Readings", size=12, bold=True, color=INK)
    y = _draw_table_header(doc, _top(TABLE_TOP_FIRST), unit_label)
    if not rows:
        doc.text(MARGIN + 6.0, y - 12.5, "No readings in this range", size=8, color=MUTED)

    capacity = ROWS_FIRST_PAGE
    on_page = 0
    for index, row in enumerate(rows):
        if on_page == capacity:
            doc.page()
            _draw_header(doc, profile_name, profile_color_hex, period_label, generated_label)
            y = _draw_table_header(doc, _top(TABLE_TOP_NEXT), unit_label)
            capacity = ROWS_PER_PAGE
            on_page = 0
        y = _draw_table_row(doc, y, row, zebra=index % 2 == 1)
        on_page += 1

    total = doc.page_count
    for index in range(total):
        doc.select(index)
        _draw_footer(doc, profile_name, index + 1, total)
    return doc.render()
