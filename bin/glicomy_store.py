#!/usr/bin/python3 -I -S
"""Glicomy state store and export helper.

The QML panel invokes this file as an argv array, never through a shell:

    /usr/bin/python3 -I -S glicomy_store.py load
    /usr/bin/python3 -I -S glicomy_store.py save                  (state JSON on stdin)
    /usr/bin/python3 -I -S glicomy_store.py export csv|pdf --profile <id> --range 7d|30d|all --unit mgdl|mmol

Storage: $XDG_STATE_HOME/glicomy/state.json (default ~/.local/state/glicomy),
directory 0700, file 0600, at most 4 MiB. Exports: $XDG_DOCUMENTS_DIR/Glicomy/ (a new folder is
created 0700; export files are created 0600).

Every file access is descriptor-bound. Directories are walked one component
at a time with O_NOFOLLOW and the descriptors are held; the state file is
validated through fstat on its own descriptor before a byte is read; writes
go to an exclusive random temporary that is renamed into place and fsynced.
A failed check refuses and never deletes or overwrites anything.

Exit codes: 0 ok, 2 usage, 3 rejected input or untrusted file, 4 I/O failure.
All JSON output is one compact line on stdout; errors are one line on stderr.
"""
import csv
import datetime
import errno
import importlib.util
import io
import json
import math
import os
import re
import secrets
import stat
import sys

EXIT_OK, EXIT_USAGE, EXIT_REJECTED, EXIT_IO = 0, 2, 3, 4

MAX_STATE_BYTES = 4 * 1024 * 1024
MAX_USER_DIRS_BYTES = 64 * 1024
MAX_EXPORT_ATTEMPTS = 50
STATE_FILE = "state.json"
EXPORT_FOLDER = "Glicomy"
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
FILE_READ_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
FILE_CREATE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC

# ------------------------------------------------------------------ domain
# Mirrors Model.js; both sides must agree because the panel validates before
# sending and this helper validates again before writing or exporting.

SCHEMA_VERSION = 1
LIMITS = {
    "glucose": (20, 600), "carbs": (0, 500), "insulin": (0, 100),
    "name_max": 40, "note_max": 200, "profiles": 20, "readings": 20000, "errors_max": 20,
}
MGDL_PER_MMOL = 18.0182
UNITS = ("mgdl", "mmol")
UNIT_LABELS = {"mgdl": "mg/dL", "mmol": "mmol/L"}
CONTEXTS = ("", "Fasting", "Before meal", "After meal", "Bedtime", "Overnight", "Exercise", "Other")
RANGES = ("7d", "30d", "all")
RANGE_LABELS = {"7d": "Last 7 days", "30d": "Last 30 days", "all": "All readings"}
PREMEAL_TARGET = (80, 130)
POSTMEAL_TARGET_HIGH = 180

# key, short label, colour (display order; mirrors Model.CATEGORIES)
CATEGORIES = (
    ("veryLow", "Very low", "#b91c1c"),
    ("low", "Low", "#ef4444"),
    ("belowTarget", "Below target", "#3b82f6"),
    ("inRange", "In target", "#22c55e"),
    ("high", "High", "#eab308"),
    ("veryHigh", "Very high", "#f97316"),
)
CATEGORY_BY_KEY = {key: (label, color) for key, label, color in CATEGORIES}
# ADA goals for most non-pregnant adults with diabetes; mirrors Model.TABLES.
# Inclusive upper bound (mg/dL) per category; a missing category is unused.
PREMEAL_BOUNDS = {"veryLow": 53, "low": 69, "belowTarget": 79, "inRange": 130, "high": 250, "veryHigh": math.inf}
POSTMEAL_BOUNDS = {"veryLow": 53, "low": 69, "inRange": 180, "high": 250, "veryHigh": math.inf}

MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

AT_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$")
PROFILE_ID_RE = re.compile(r"^p_[0-9a-f]{12}$")
READING_ID_RE = re.compile(r"^r_[0-9a-f]{12}$")
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
CONTROL_RE = re.compile("[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]")
SURROGATE_RE = re.compile("[\ud800-\udfff]")
CSV_FORMULA_RE = re.compile(r"^[=+\-@\t\r]")
SLUG_RUN_RE = re.compile(r"[A-Za-z0-9]+")
USER_DIRS_RE = re.compile(r'^\s*XDG_DOCUMENTS_DIR\s*=\s*"?([^"\n]*?)"?\s*$')
CSV_HEADER = ("Date", "Time", "Glucose (mg/dL)", "Glucose (mmol/L)", "Category", "Context",
              "Carbs (g)", "Insulin (u)", "Note")


class StoreError(Exception):
    """A refused operation with the exit code it maps to."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def bounds_for(context):
    """After-meal readings use the after-meal goals; every other context the before-meal ones."""
    return POSTMEAL_BOUNDS if context == "After meal" else PREMEAL_BOUNDS


def category_of(glucose, context=""):
    bounds = bounds_for(context)
    for key, _label, _color in CATEGORIES:
        if key in bounds and glucose <= bounds[key]:
            return key
    return "veryHigh"


def category_range(key, unit, context=""):
    """Legend text like Model.categoryRange() with an ASCII dash; '' when the table does not use `key`."""
    bounds = bounds_for(context)
    if key not in bounds:
        return ""
    previous = None
    for other, _label, _color in CATEGORIES:
        if other == key:
            break
        if other in bounds:
            previous = bounds[other]
    upper = bounds[key]
    if previous is None:
        return "< " + format_glucose(upper + 1, unit)
    if upper == math.inf:
        return "> " + format_glucose(previous, unit)
    # One display step above the previous band, so mmol/L bands never overlap.
    low = "%.1f" % (to_display(previous, unit) + 0.1) if unit == "mmol" else str(previous + 1)
    return "%s-%s" % (low, format_glucose(upper, unit))


def to_display(mgdl, unit):
    """mg/dL to the display unit; mmol/L rounded half-up to one decimal like Model.js."""
    if unit == "mmol":
        return math.floor(mgdl / MGDL_PER_MMOL * 10 + 0.5) / 10
    return int(mgdl)


def format_glucose(mgdl, unit):
    value = to_display(mgdl, unit)
    return "%.1f" % value if unit == "mmol" else str(value)


def format_insulin(value):
    if value is None:
        return ""
    return str(int(value)) if float(value).is_integer() else "%.1f" % value


def parse_at(value):
    """Strict YYYY-MM-DDTHH:MM (local time) to datetime, or None."""
    if not isinstance(value, str):
        return None
    match = AT_RE.match(value)
    if not match:
        return None
    year, month, day, hour, minute = (int(part) for part in match.groups())
    if year < 1970 or year > 9999:
        return None
    try:
        return datetime.datetime(year, month, day, hour, minute)
    except ValueError:
        return None


def to_at(moment):
    return moment.strftime("%Y-%m-%dT%H:%M")


def local_now():
    return datetime.datetime.now()


def format_time(moment):
    hour12 = moment.hour % 12 or 12
    return "%d:%02d %s" % (hour12, moment.minute, "AM" if moment.hour < 12 else "PM")


def format_date(moment):
    return "%s %d, %d" % (MONTHS[moment.month - 1], moment.day, moment.year)


def range_start(range_key, now):
    base = now.replace(hour=0, minute=0, second=0, microsecond=0)
    if range_key == "7d":
        return base - datetime.timedelta(days=6)
    if range_key == "30d":
        return base - datetime.timedelta(days=29)
    return None


def filter_readings(readings, profile_id, range_key, now):
    """Readings of one profile inside the range, oldest first."""
    start = range_start(range_key, now)
    keyed = []
    for item in readings:
        if item["profileId"] != profile_id:
            continue
        moment = parse_at(item["at"])
        if moment is None or (start is not None and moment < start):
            continue
        keyed.append((moment, item["id"], item))
    keyed.sort(key=lambda entry: (entry[0], entry[1]))
    return [entry[2] for entry in keyed]


def utf16_length(text):
    return len(text.encode("utf-16-le")) // 2


def is_clean_text(text, limit):
    """A string with no lone surrogates, no control or bidi characters, at most `limit` UTF-16 units."""
    if not isinstance(text, str) or SURROGATE_RE.search(text) or CONTROL_RE.search(text):
        return False
    return utf16_length(text) <= limit


def empty_state():
    return {"version": SCHEMA_VERSION, "activeProfile": None, "unit": "mgdl", "profiles": [], "readings": []}


def strict_int(value, bounds):
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < bounds[0] or value > bounds[1]:
        return None
    return value


def strict_tenths(value, bounds):
    """A JSON number with at most one decimal inside bounds, normalised to int or one-decimal float."""
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return None
    if abs(value * 10 - round(value * 10)) > 1e-6 or value < bounds[0] or value > bounds[1]:
        return None
    rounded = round(value * 10) / 10
    return int(rounded) if rounded.is_integer() else rounded


def clean_profile(item, seen, index):
    where = "profiles[%d]" % index
    if not isinstance(item, dict):
        return None, where + " is not an object"
    pid = item.get("id")
    if not isinstance(pid, str) or not PROFILE_ID_RE.match(pid):
        return None, where + " has an invalid id"
    if pid in seen:
        return None, where + " repeats id " + pid
    name = item.get("name")
    if not is_clean_text(name, LIMITS["name_max"]) or not name.strip():
        return None, where + " has an invalid name"
    color = item.get("color")
    if not isinstance(color, str) or not COLOR_RE.match(color):
        return None, where + " has an invalid color"
    created = item.get("createdAt")
    if parse_at(created) is None:
        return None, where + " has an invalid createdAt"
    seen.add(pid)
    return {"id": pid, "name": name, "color": color.lower(), "createdAt": created}, None


def clean_reading(item, profile_ids, seen, index):
    where = "readings[%d]" % index
    if not isinstance(item, dict):
        return None, where + " is not an object"
    rid = item.get("id")
    if not isinstance(rid, str) or not READING_ID_RE.match(rid):
        return None, where + " has an invalid id"
    if rid in seen:
        return None, where + " repeats id " + rid
    pid = item.get("profileId")
    if not isinstance(pid, str) or pid not in profile_ids:
        return None, where + " references an unknown profile"
    at = item.get("at")
    if parse_at(at) is None:
        return None, where + " has an invalid timestamp"
    glucose = strict_int(item.get("glucose"), LIMITS["glucose"])
    if glucose is None:
        return None, where + " has a glucose value out of bounds"
    carbs = item.get("carbs")
    if carbs is not None and strict_int(carbs, LIMITS["carbs"]) is None:
        return None, where + " has carbs out of bounds"
    insulin = item.get("insulin")
    if insulin is not None:
        insulin = strict_tenths(insulin, LIMITS["insulin"])
        if insulin is None:
            return None, where + " has insulin out of bounds"
    context = item.get("context", "")
    if context not in CONTEXTS:
        return None, where + " has an unknown context"
    note = item.get("note", "")
    if not is_clean_text(note, LIMITS["note_max"]):
        return None, where + " has an invalid note"
    seen.add(rid)
    return {"id": rid, "profileId": pid, "at": at, "glucose": glucose, "context": context,
            "carbs": carbs, "insulin": insulin, "note": note}, None


def validate_state(obj):
    """Return a normalised state document or raise StoreError(EXIT_REJECTED)."""
    if not isinstance(obj, dict):
        raise StoreError(EXIT_REJECTED, "state is not an object")
    errors = []
    if obj.get("version") != SCHEMA_VERSION:
        errors.append("unsupported state version")
    unit = obj.get("unit", "mgdl")
    if unit not in UNITS:
        errors.append("unit must be mgdl or mmol")
    profiles_in = obj.get("profiles")
    readings_in = obj.get("readings")
    if not isinstance(profiles_in, list):
        errors.append("profiles must be an array")
    elif len(profiles_in) > LIMITS["profiles"]:
        errors.append("too many profiles (max %d)" % LIMITS["profiles"])
    if not isinstance(readings_in, list):
        errors.append("readings must be an array")
    elif len(readings_in) > LIMITS["readings"]:
        errors.append("too many readings (max %d)" % LIMITS["readings"])
    if errors:
        raise StoreError(EXIT_REJECTED, "invalid state: " + "; ".join(errors))

    profiles, profile_ids = [], set()
    for index, item in enumerate(profiles_in):
        profile, error = clean_profile(item, profile_ids, index)
        if error:
            errors.append(error)
            if len(errors) >= LIMITS["errors_max"]:
                break
        else:
            profiles.append(profile)
    readings, reading_ids = [], set()
    if len(errors) < LIMITS["errors_max"]:
        for index, item in enumerate(readings_in):
            item_clean, error = clean_reading(item, profile_ids, reading_ids, index)
            if error:
                errors.append(error)
                if len(errors) >= LIMITS["errors_max"]:
                    break
            else:
                readings.append(item_clean)
    active = obj.get("activeProfile")
    if active is not None and (not isinstance(active, str) or active not in profile_ids):
        errors.append("activeProfile references an unknown profile")
    if errors:
        raise StoreError(EXIT_REJECTED, "invalid state: " + "; ".join(errors))
    return {"version": SCHEMA_VERSION, "activeProfile": active, "unit": unit,
            "profiles": profiles, "readings": readings}


def parse_state_json(raw):
    try:
        return json.loads(raw.decode("utf-8", "strict"))
    except (UnicodeDecodeError, ValueError, RecursionError) as exc:
        raise StoreError(EXIT_REJECTED, "state is not valid JSON: " + type(exc).__name__) from None


def compact_json(obj):
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False, allow_nan=False)


# ------------------------------------------------------------ file access

def refuse(path_hint, exc):
    """Translate an OSError from a guarded open into a StoreError."""
    if exc.errno in (errno.ELOOP, errno.ENOTDIR, errno.EPERM, errno.EACCES):
        return StoreError(EXIT_REJECTED, "refusing %s: %s" % (path_hint, exc.strerror))
    return StoreError(EXIT_IO, "cannot access %s: %s" % (path_hint, exc.strerror))


def open_dir_chain(anchor, parts, create, mode, private):
    """Open `anchor` then walk `parts` with held descriptors; return the final dirfd.

    Every component below the anchor must be a real directory owned by the
    current user. Missing components are created only when `create` is set.
    With `private`, the final directory is repaired to 0700 if it is wider.
    Raises FileNotFoundError when a component is missing and `create` is off.
    """
    if not anchor.startswith("/"):
        raise StoreError(EXIT_REJECTED, "directory anchor must be an absolute path")
    try:
        fd = os.open(anchor, DIR_FLAGS)
    except FileNotFoundError:
        raise
    except OSError as exc:
        raise refuse(anchor, exc) from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
            raise StoreError(EXIT_REJECTED, "refusing %s: not a directory owned by the current user" % anchor)
        for name in parts:
            try:
                nfd = os.open(name, DIR_FLAGS, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, mode, dir_fd=fd)
                    nfd = os.open(name, DIR_FLAGS, dir_fd=fd)
                except OSError as exc:
                    raise refuse(name, exc) from None
            except OSError as exc:
                raise refuse(name, exc) from None
            os.close(fd)
            fd = nfd
            info = os.fstat(fd)
            if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
                raise StoreError(EXIT_REJECTED, "refusing %s: not a directory owned by the current user" % name)
        if private and (info.st_mode & 0o077):
            os.fchmod(fd, 0o700)
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_bounded(dirfd, name, limit):
    """Read a regular, single-link, user-owned file of at most `limit` bytes; None if absent."""
    try:
        fd = os.open(name, FILE_READ_FLAGS, dir_fd=dirfd)
    except FileNotFoundError:
        return None
    except OSError as exc:
        raise refuse(name, exc) from None
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise StoreError(EXIT_REJECTED, "refusing %s: not a regular file" % name)
        if info.st_uid != os.geteuid():
            raise StoreError(EXIT_REJECTED, "refusing %s: not owned by the current user" % name)
        if info.st_nlink != 1:
            raise StoreError(EXIT_REJECTED, "refusing %s: file has more than one link" % name)
        if info.st_size > limit:
            raise StoreError(EXIT_REJECTED, "refusing %s: larger than %d bytes" % (name, limit))
        os.set_blocking(fd, True)
        data = b""
        while len(data) <= limit:
            chunk = os.read(fd, min(65536, limit + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        if len(data) > limit:
            raise StoreError(EXIT_REJECTED, "refusing %s: grew past %d bytes" % (name, limit))
        return data
    finally:
        os.close(fd)


def write_all(fd, data):
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        view = view[written:]


def write_atomic(dirfd, name, data):
    """Write `data` to an exclusive 0600 temporary next to `name`, then rename over it."""
    tmp = ".%s.%s.tmp" % (name, secrets.token_hex(8))
    fd = os.open(tmp, FILE_CREATE_FLAGS, 0o600, dir_fd=dirfd)
    try:
        os.fchmod(fd, 0o600)
        write_all(fd, data)
        os.fsync(fd)
        os.rename(tmp, name, src_dir_fd=dirfd, dst_dir_fd=dirfd)
        os.fsync(dirfd)
    except BaseException:
        try:
            os.unlink(tmp, dir_fd=dirfd)
        except OSError:
            pass
        raise
    finally:
        os.close(fd)


def create_export(dirfd, base, extension, data):
    """Create base[-N].extension exclusively (0600) and return the name used.

    Exports hold health data, so they are private to the user. A failed write
    or fsync unlinks the just-created file through the held directory descriptor.
    """
    for attempt in range(1, MAX_EXPORT_ATTEMPTS + 1):
        name = "%s%s%s" % (base, "" if attempt == 1 else "-%d" % attempt, extension)
        try:
            fd = os.open(name, FILE_CREATE_FLAGS, 0o600, dir_fd=dirfd)
        except FileExistsError:
            continue
        except OSError as exc:
            raise refuse(name, exc) from None
        try:
            write_all(fd, data)
            os.fsync(fd)
        except BaseException:
            try:
                os.unlink(name, dir_fd=dirfd)
            except OSError:
                pass
            raise
        finally:
            os.close(fd)
        os.fsync(dirfd)
        return name
    raise StoreError(EXIT_IO, "too many existing exports named %s" % base)


# --------------------------------------------------------------- locations

def home_dir():
    home = os.environ.get("HOME") or os.path.expanduser("~")
    if not home.startswith("/"):
        raise StoreError(EXIT_IO, "HOME is not an absolute path")
    return os.path.normpath(home)


def state_chain():
    xdg = os.environ.get("XDG_STATE_HOME", "")
    if xdg.startswith("/"):
        return os.path.normpath(xdg), ["glicomy"]
    return home_dir(), [".local", "state", "glicomy"]


def user_dirs_documents(home):
    """XDG_DOCUMENTS_DIR from ~/.config/user-dirs.dirs, or None."""
    try:
        dirfd = open_dir_chain(home, [".config"], create=False, mode=0o700, private=False)
    except (FileNotFoundError, StoreError):
        return None
    try:
        raw = read_bounded(dirfd, "user-dirs.dirs", MAX_USER_DIRS_BYTES)
    except StoreError:
        return None
    finally:
        os.close(dirfd)
    if raw is None:
        return None
    for line in raw.decode("utf-8", "replace").splitlines():
        match = USER_DIRS_RE.match(line)
        if not match:
            continue
        value = match.group(1)
        if value.startswith("$HOME"):
            value = home + value[len("$HOME"):]
        if value.startswith("/"):
            return os.path.normpath(value)
    return None


def is_directory(path):
    try:
        fd = os.open(path, DIR_FLAGS)
    except OSError:
        return False
    os.close(fd)
    return True


def documents_dir():
    env = os.environ.get("XDG_DOCUMENTS_DIR", "")
    if env.startswith("/"):
        return os.path.normpath(env)
    home = home_dir()
    parsed = user_dirs_documents(home)
    if parsed:
        return parsed
    documents = os.path.join(home, "Documents")
    return documents if is_directory(documents) else home


def profile_slug(name):
    runs = SLUG_RUN_RE.findall(name or "")
    slug = "-".join(runs)[:24].rstrip("-")
    return slug or "profile"




# ------------------------------------------------------------- operations

def load_state():
    anchor, parts = state_chain()
    try:
        dirfd = open_dir_chain(anchor, parts, create=False, mode=0o700, private=True)
    except FileNotFoundError:
        return empty_state()
    try:
        raw = read_bounded(dirfd, STATE_FILE, MAX_STATE_BYTES)
    finally:
        os.close(dirfd)
    if raw is None:
        return empty_state()
    return validate_state(parse_state_json(raw))


def cmd_load():
    return load_state()


def cmd_save():
    payload = sys.stdin.buffer.read(MAX_STATE_BYTES + 1)
    if len(payload) > MAX_STATE_BYTES:
        raise StoreError(EXIT_REJECTED, "state exceeds %d bytes" % MAX_STATE_BYTES)
    state = validate_state(parse_state_json(payload))
    data = compact_json(state).encode("utf-8")
    anchor, parts = state_chain()
    dirfd = open_dir_chain(anchor, parts, create=True, mode=0o700, private=True)
    try:
        write_atomic(dirfd, STATE_FILE, data)
    finally:
        os.close(dirfd)
    return {"ok": True, "readings": len(state["readings"])}


def csv_cell(value):
    text = "" if value is None else str(value)
    return "'" + text if CSV_FORMULA_RE.match(text) else text


def csv_bytes(readings):
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(CSV_HEADER)
    for item in readings:
        moment = parse_at(item["at"])
        label = CATEGORY_BY_KEY[category_of(item["glucose"], item["context"])][0]
        writer.writerow([format_date(moment), format_time(moment), item["glucose"],
                         format_glucose(item["glucose"], "mmol"), label, csv_cell(item["context"]),
                         "" if item["carbs"] is None else item["carbs"], format_insulin(item["insulin"]),
                         csv_cell(item["note"])])
    return buffer.getvalue().encode("utf-8")


def load_pdf_module():
    """Import the sibling PDF writer by path; -I keeps the script directory off sys.path."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "glicomy_pdf.py")
    spec = importlib.util.spec_from_file_location("glicomy_pdf", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def report_rows(readings, unit):
    rows = []
    for item in readings:
        moment = parse_at(item["at"])
        label, color = CATEGORY_BY_KEY[category_of(item["glucose"], item["context"])]
        rows.append({
            "when": moment, "date": format_date(moment), "time": format_time(moment),
            "value": to_display(item["glucose"], unit), "text": format_glucose(item["glucose"], unit),
            "category": label, "color": color, "context": item["context"],
            "carbs": "" if item["carbs"] is None else str(item["carbs"]),
            "insulin": format_insulin(item["insulin"]), "note": item["note"],
        })
    return rows


def report_distribution(readings, unit):
    """Share of readings per category (each judged by its context) with both legend ranges."""
    counts = {key: 0 for key, _label, _color in CATEGORIES}
    for item in readings:
        counts[category_of(item["glucose"], item["context"])] += 1
    total = len(readings)
    return [{"label": label, "color": color,
             "premeal": category_range(key, unit, ""), "postmeal": category_range(key, unit, "After meal"),
             "pct": math.floor(counts[key] * 100 / total + 0.5) if total else 0}
            for key, label, color in CATEGORIES]


def report_stats(readings, unit):
    """Summary lines in the display unit; mirrors Model.stats()."""
    values = [item["glucose"] for item in readings]
    if not values:
        return []
    count = len(values)
    mean = sum(values) / count
    sd = math.sqrt(sum((value - mean) ** 2 for value in values) / (count - 1)) if count > 1 else 0.0
    mean_mg = math.floor(mean + 0.5)
    sd_mg = math.floor(sd + 0.5)
    cv = math.floor(sd / mean * 100 + 0.5) if mean > 0 else 0
    ea1c = math.floor((mean + 46.7) / 28.7 * 10 + 0.5) / 10
    label = UNIT_LABELS[unit]
    return [
        ("Average", "%s %s" % (format_glucose(mean_mg, unit), label)),
        ("SD / CV", "%s %s / %d%%" % (format_glucose(sd_mg, unit), label, cv)),
        ("Range", "%s-%s %s" % (format_glucose(min(values), unit), format_glucose(max(values), unit), label)),
        ("Est. A1C", "%.1f%%" % ea1c),
        ("Readings", str(count)),
    ]


def pdf_bytes(profile, range_key, readings, unit, now):
    pdf = load_pdf_module()
    band = (to_display(PREMEAL_TARGET[0], unit), to_display(PREMEAL_TARGET[1], unit),
            to_display(POSTMEAL_TARGET_HIGH, unit))
    return pdf.build_report(profile["name"], profile["color"], RANGE_LABELS[range_key], UNIT_LABELS[unit],
                            band, report_rows(readings, unit), report_distribution(readings, unit),
                            report_stats(readings, unit), now)


def cmd_export(fmt, profile_id, range_key, unit):
    state = load_state()
    profile = next((item for item in state["profiles"] if item["id"] == profile_id), None)
    if profile is None:
        raise StoreError(EXIT_REJECTED, "unknown profile %s" % profile_id)
    now = local_now()
    readings = filter_readings(state["readings"], profile_id, range_key, now)
    if fmt == "csv":
        data, extension = csv_bytes(readings), ".csv"
    else:
        data, extension = pdf_bytes(profile, range_key, readings, unit, now), ".pdf"
    base = "Glicomy-%s-%s" % (profile_slug(profile["name"]), now.strftime("%Y%m%d-%H%M"))
    documents = documents_dir()
    try:
        dirfd = open_dir_chain(documents, [EXPORT_FOLDER], create=True, mode=0o700, private=False)
    except FileNotFoundError:
        raise StoreError(EXIT_IO, "documents directory %s does not exist" % documents) from None
    try:
        name = create_export(dirfd, base, extension, data)
    finally:
        os.close(dirfd)
    return {"ok": True, "path": os.path.join(documents, EXPORT_FOLDER, name), "rows": len(readings)}


# ------------------------------------------------------------------- main

USAGE = "usage: glicomy_store.py load | save | export csv|pdf --profile <id> --range 7d|30d|all --unit mgdl|mmol"
EXPORT_FORMATS = ("csv", "pdf")
EXPORT_FLAGS = ("--profile", "--range", "--unit")


def parse_args(argv):
    if not argv:
        raise StoreError(EXIT_USAGE, USAGE)
    op = argv[0]
    if op in ("load", "save"):
        if len(argv) != 1:
            raise StoreError(EXIT_USAGE, USAGE)
        return (op,)
    if op != "export" or len(argv) != 2 + 2 * len(EXPORT_FLAGS) or argv[1] not in EXPORT_FORMATS:
        raise StoreError(EXIT_USAGE, USAGE)
    options = {}
    for index in range(2, len(argv), 2):
        flag, value = argv[index], argv[index + 1]
        if flag not in EXPORT_FLAGS or flag in options:
            raise StoreError(EXIT_USAGE, USAGE)
        options[flag] = value
    if (not PROFILE_ID_RE.match(options["--profile"]) or options["--range"] not in RANGES
            or options["--unit"] not in UNITS):
        raise StoreError(EXIT_USAGE, USAGE)
    return ("export", argv[1], options["--profile"], options["--range"], options["--unit"])


def main(argv):
    os.umask(0o077)
    try:
        args = parse_args(argv)
        if args[0] == "load":
            result = cmd_load()
        elif args[0] == "save":
            result = cmd_save()
        else:
            result = cmd_export(*args[1:])
    except StoreError as exc:
        sys.stderr.write(exc.message.replace("\n", " ") + "\n")
        return exc.code
    except OSError as exc:
        sys.stderr.write("I/O failure: %s\n" % (exc.strerror or exc))
        return EXIT_IO
    sys.stdout.write(compact_json(result) + "\n")
    sys.stdout.flush()
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
