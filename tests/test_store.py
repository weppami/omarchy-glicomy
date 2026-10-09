"""Tests for bin/glicomy_store.py.

Run with: /usr/bin/python3 -m unittest discover -s tests -v

Every test runs the helper exactly as the panel does (python3 -I -S ... as an
argv array) against a throw-away HOME / XDG_STATE_HOME / XDG_DOCUMENTS_DIR.
"""
import csv
import importlib.util
import io
import json
import errno
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, "bin")
STORE = os.path.join(BIN, "glicomy_store.py")
PYTHON = "/usr/bin/python3"

PROFILE = "p_0123456789ab"
OTHER_PROFILE = "p_ba9876543210"
EMPTY_STATE = {"version": 1, "activeProfile": None, "unit": "mgdl", "profiles": [], "readings": []}


def load_bin_module(name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(BIN, name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def reading(rid, at, glucose, **extra):
    base = {"id": rid, "profileId": PROFILE, "at": at, "glucose": glucose,
            "context": "", "carbs": None, "insulin": None, "note": ""}
    base.update(extra)
    return base


def sample_state():
    return {
        "version": 1,
        "activeProfile": PROFILE,
        "unit": "mgdl",
        "profiles": [
            {"id": PROFILE, "name": "Ana María", "color": "#a855f7", "createdAt": "2026-10-01T09:00"},
            {"id": OTHER_PROFILE, "name": "Bob", "color": "#3b82f6", "createdAt": "2026-10-01T09:05"},
        ],
        "readings": [
            reading("r_000000000001", "2021-10-06T07:33", 196, context="After meal", carbs=60, insulin=4.5,
                    note="=SUM(A1) after pasta"),
            reading("r_000000000002", "2020-01-01T08:00", 92, context="Fasting"),
            reading("r_000000000003", "2021-10-05T21:00", 128, profileId=OTHER_PROFILE),
        ],
    }


def write_file(path, data, mode=0o600):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, mode)
    try:
        os.write(fd, data if isinstance(data, bytes) else data.encode("utf-8"))
    finally:
        os.close(fd)


def read_file(path):
    with open(path, "rb") as handle:
        return handle.read()


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="glicomy-test-")
        self.home = os.path.join(self.tmp, "home")
        self.state_home = os.path.join(self.tmp, "state")
        self.docs = os.path.join(self.tmp, "docs")
        for path in (self.home, self.state_home, self.docs):
            os.mkdir(path, 0o700)
        self.env = {
            "HOME": self.home,
            "XDG_STATE_HOME": self.state_home,
            "XDG_DOCUMENTS_DIR": self.docs,
            "PATH": "/usr/bin",
            "LANG": "C.UTF-8",
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_store(self, *args, stdin=None, env=None):
        return subprocess.run(
            [PYTHON, "-I", "-S", STORE, *args],
            input=stdin, env=env if env is not None else self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False,
        )

    def state_dir(self):
        return os.path.join(self.state_home, "glicomy")

    def state_path(self):
        return os.path.join(self.state_dir(), "state.json")

    def save(self, state, env=None):
        result = self.run_store("save", stdin=json.dumps(state).encode("utf-8"), env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result


class LoadAndSave(StoreTestCase):
    def test_load_on_empty_state_home_returns_empty_state_and_creates_nothing(self):
        result = self.run_store("load")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), EMPTY_STATE)
        self.assertEqual(result.stdout.count(b"\n"), 1, "output is a single line")
        self.assertEqual(os.listdir(self.state_home), [])

    def test_load_when_state_home_is_missing_returns_empty_state(self):
        env = dict(self.env, XDG_STATE_HOME=os.path.join(self.tmp, "absent"))
        result = self.run_store("load", env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), EMPTY_STATE)
        self.assertFalse(os.path.exists(env["XDG_STATE_HOME"]))

    def test_save_then_load_round_trip(self):
        result = self.save(sample_state())
        self.assertEqual(json.loads(result.stdout), {"ok": True, "readings": 3})
        self.assertEqual(stat.S_IMODE(os.stat(self.state_dir()).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(self.state_path()).st_mode), 0o600)
        self.assertEqual(os.listdir(self.state_dir()), ["state.json"], "no temporary left behind")

        loaded = self.run_store("load")
        self.assertEqual(loaded.returncode, 0, loaded.stderr)
        self.assertEqual(json.loads(loaded.stdout), sample_state())

    def test_save_uses_default_state_home_under_home(self):
        env = dict(self.env)
        del env["XDG_STATE_HOME"]
        self.save(sample_state(), env=env)
        path = os.path.join(self.home, ".local", "state", "glicomy", "state.json")
        self.assertTrue(os.path.isfile(path))
        for part in (".local", os.path.join(".local", "state"), os.path.join(".local", "state", "glicomy")):
            self.assertEqual(stat.S_IMODE(os.stat(os.path.join(self.home, part)).st_mode), 0o700)
        loaded = self.run_store("load", env=env)
        self.assertEqual(json.loads(loaded.stdout), sample_state())

    def test_save_rejects_oversized_stdin(self):
        payload = b'{"version":1,"activeProfile":null,"profiles":[],"readings":[],"pad":"' \
            + b"x" * (4 * 1024 * 1024) + b'"}'
        result = self.run_store("save", stdin=payload)
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertFalse(os.path.exists(self.state_dir()))

    def test_save_rejects_invalid_documents_without_writing(self):
        bad = [
            b"not json",
            b"[]",
            json.dumps(dict(sample_state(), version=2)).encode(),
            json.dumps(dict(sample_state(), activeProfile="p_ffffffffffff")).encode(),
            json.dumps(dict(sample_state(), unit="mg")).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 601)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 19)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", "120")])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120.5)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", True)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120, carbs=501)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120, carbs=12.5)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120, insulin=4.25)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120, insulin=-1)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120, insulin="2")])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120, note="x" * 201)])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06T07:33", 120, context="Lunch")])).encode(),
            json.dumps(dict(sample_state(), readings=[reading("r_000000000001", "2026-10-06 07:33", 120)])).encode(),
            json.dumps(dict(sample_state(), profiles=sample_state()["profiles"] * 11)).encode(),
            json.dumps(dict(sample_state(), profiles=[{"id": PROFILE, "name": "", "color": "#a855f7", "createdAt": "2026-10-01T09:00"}])).encode(),
            b"[" * 100000 + b"]" * 100000,
        ]
        for payload in bad:
            result = self.run_store("save", stdin=payload)
            self.assertEqual(result.returncode, 3, (payload[:60], result.stderr))
            self.assertEqual(result.stderr.count(b"\n"), 1, "one-line error on stderr")
        self.assertFalse(os.path.exists(self.state_path()))

    def test_save_rejects_too_many_readings(self):
        state = sample_state()
        state["readings"] = [reading("r_%012x" % i, "2026-10-06T07:33", 120) for i in range(20001)]
        result = self.run_store("save", stdin=json.dumps(state).encode())
        self.assertEqual(result.returncode, 3, result.stderr)
        state["readings"] = state["readings"][:20000]
        result = self.run_store("save", stdin=json.dumps(state).encode())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {"ok": True, "readings": 20000})

    def test_load_refuses_a_symlinked_state_file_and_leaves_the_target_intact(self):
        os.mkdir(self.state_dir(), 0o700)
        victim = os.path.join(self.tmp, "victim.json")
        write_file(victim, json.dumps(sample_state()))
        os.symlink(victim, self.state_path())

        result = self.run_store("load")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, b"")
        self.assertTrue(os.path.islink(self.state_path()), "the planted link is not removed")
        self.assertEqual(json.loads(read_file(victim)), sample_state())

    def test_load_refuses_a_symlinked_state_directory(self):
        elsewhere = os.path.join(self.tmp, "elsewhere")
        os.mkdir(elsewhere, 0o700)
        write_file(os.path.join(elsewhere, "state.json"), json.dumps(sample_state()))
        os.symlink(elsewhere, self.state_dir())
        result = self.run_store("load")
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue(os.path.islink(self.state_dir()))

    def test_load_rejects_a_state_file_owned_by_another_user_or_with_two_links(self):
        os.mkdir(self.state_dir(), 0o700)
        write_file(self.state_path(), json.dumps(sample_state()))
        os.link(self.state_path(), os.path.join(self.tmp, "hardlink.json"))
        result = self.run_store("load")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"state", result.stderr.lower())

    def test_save_does_not_write_through_a_symlink_planted_at_state_json(self):
        os.mkdir(self.state_dir(), 0o700)
        victim = os.path.join(self.tmp, "victim.txt")
        write_file(victim, "must survive")
        os.symlink(victim, self.state_path())

        self.save(sample_state())
        self.assertEqual(read_file(victim), b"must survive")
        self.assertTrue(stat.S_ISREG(os.lstat(self.state_path()).st_mode))
        self.assertEqual(json.loads(read_file(self.state_path())), sample_state())

    def test_load_repairs_a_too_open_state_directory(self):
        os.mkdir(self.state_dir(), 0o755)
        result = self.run_store("load")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(stat.S_IMODE(os.stat(self.state_dir()).st_mode), 0o700)

    def test_usage_errors_exit_with_code_2(self):
        for args in ((), ("bogus",), ("load", "extra"), ("export",), ("export", "csv"),
                     ("export", "csv", "--profile", PROFILE),
                     ("export", "csv", "--range", "all", "--profile", PROFILE),
                     ("export", "csv", "--profile", "nope", "--range", "all", "--unit", "mgdl"),
                     ("export", "csv", "--profile", PROFILE, "--range", "1y", "--unit", "mgdl"),
                     ("export", "csv", "--profile", PROFILE, "--range", "all", "--unit", "mmhg"),
                     ("export", "csv", "--profile", PROFILE, "--range", "all", "--range", "all", "--unit", "mgdl"),
                     ("export", "xml", "--profile", PROFILE, "--range", "all", "--unit", "mgdl")):
            result = self.run_store(*args)
            self.assertEqual(result.returncode, 2, (args, result.stderr))

    def test_save_rejects_lone_surrogates_without_crashing(self):
        for field in ("name", "note"):
            state = sample_state()
            if field == "name":
                state["profiles"][0]["name"] = "Ana \ud800"
            else:
                state["readings"][0]["note"] = "after \udfff coffee"
            payload = json.dumps(state).encode("utf-8")
            self.assertIn(b"\\ud", payload)
            result = self.run_store("save", stdin=payload)
            self.assertEqual(result.returncode, 3, (field, result.stderr))
            self.assertNotIn(b"Traceback", result.stderr)
            self.assertFalse(os.path.exists(self.state_path()))


class ExportCsv(StoreTestCase):
    def export(self, *args, env=None):
        result = self.run_store("export", *args, env=env)
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_export_csv_writes_the_documented_rows(self):
        self.save(sample_state())
        out = self.export("csv", "--profile", PROFILE, "--range", "all", "--unit", "mgdl")
        self.assertEqual(out["rows"], 2)
        self.assertEqual(os.path.dirname(out["path"]), os.path.join(self.docs, "Glicomy"))
        self.assertRegex(os.path.basename(out["path"]), r"^Glicomy-Ana-Mar-a-\d{8}-\d{4}\.csv$")
        self.assertEqual(stat.S_IMODE(os.stat(out["path"]).st_mode), 0o600)

        rows = list(csv.reader(io.StringIO(read_file(out["path"]).decode("utf-8"))))
        self.assertEqual(rows[0], ["Date", "Time", "Glucose (mg/dL)", "Glucose (mmol/L)", "Category", "Context",
                                   "Carbs (g)", "Insulin (u)", "Note"])
        self.assertEqual(rows[1], ["Jan 1, 2020", "8:00 AM", "92", "5.1", "In target", "Fasting", "", "", ""])
        self.assertEqual(rows[2], ["Oct 6, 2021", "7:33 AM", "196", "10.9", "High", "After meal", "60", "4.5",
                                   "'=SUM(A1) after pasta"])
        self.assertEqual(len(rows), 3)

    def test_export_csv_range_filters_and_second_export_gets_a_new_name(self):
        state = sample_state()
        store = load_bin_module("glicomy_store")
        today = store.to_at(store.local_now().replace(hour=9, minute=0))
        state["readings"].append(reading("r_00000000000a", today, 121))
        self.save(state)
        first = self.export("csv", "--profile", PROFILE, "--range", "7d", "--unit", "mgdl")
        self.assertEqual(first["rows"], 1)
        second = self.export("csv", "--profile", PROFILE, "--range", "7d", "--unit", "mgdl")
        self.assertNotEqual(first["path"], second["path"])
        self.assertTrue(os.path.isfile(first["path"]) and os.path.isfile(second["path"]))

    def test_export_csv_with_no_readings_writes_only_the_header(self):
        self.save(sample_state())
        out = self.export("csv", "--profile", OTHER_PROFILE, "--range", "7d", "--unit", "mgdl")
        self.assertEqual(out["rows"], 0)
        rows = list(csv.reader(io.StringIO(read_file(out["path"]).decode("utf-8"))))
        self.assertEqual(len(rows), 1)
        self.assertRegex(os.path.basename(out["path"]), r"^Glicomy-Bob-\d{8}-\d{4}\.csv$")

    def test_export_unknown_profile_is_rejected(self):
        self.save(sample_state())
        result = self.run_store("export", "csv", "--profile", "p_ffffffffffff", "--range", "all", "--unit", "mgdl")
        self.assertEqual(result.returncode, 3, result.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.docs, "Glicomy")))

    def test_export_refuses_a_symlink_planted_at_the_glicomy_folder(self):
        self.save(sample_state())
        victim_dir = os.path.join(self.tmp, "victim-dir")
        os.mkdir(victim_dir, 0o700)
        os.symlink(victim_dir, os.path.join(self.docs, "Glicomy"))
        result = self.run_store("export", "csv", "--profile", PROFILE, "--range", "all", "--unit", "mgdl")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.listdir(victim_dir), [])
        self.assertTrue(os.path.islink(os.path.join(self.docs, "Glicomy")))

    def test_export_refuses_a_symlinked_documents_directory(self):
        self.save(sample_state())
        victim_dir = os.path.join(self.tmp, "victim-docs")
        os.mkdir(victim_dir, 0o700)
        link = os.path.join(self.tmp, "docs-link")
        os.symlink(victim_dir, link)
        result = self.run_store("export", "csv", "--profile", PROFILE, "--range", "all", "--unit", "mgdl",
                                env=dict(self.env, XDG_DOCUMENTS_DIR=link))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(os.listdir(victim_dir), [])

    def test_documents_dir_falls_back_to_user_dirs_then_home_documents_then_home(self):
        self.save(sample_state())
        env = dict(self.env)
        del env["XDG_DOCUMENTS_DIR"]

        os.mkdir(os.path.join(self.home, ".config"), 0o700)
        write_file(os.path.join(self.home, ".config", "user-dirs.dirs"),
                   '# comment\nXDG_DESKTOP_DIR="$HOME/Desktop"\nXDG_DOCUMENTS_DIR="$HOME/MyDocs"\n')
        os.mkdir(os.path.join(self.home, "MyDocs"), 0o700)
        out = self.export("csv", "--profile", PROFILE, "--range", "all", "--unit", "mgdl", env=env)
        self.assertEqual(os.path.dirname(out["path"]), os.path.join(self.home, "MyDocs", "Glicomy"))

        os.unlink(os.path.join(self.home, ".config", "user-dirs.dirs"))
        os.mkdir(os.path.join(self.home, "Documents"), 0o700)
        out = self.export("csv", "--profile", PROFILE, "--range", "all", "--unit", "mgdl", env=env)
        self.assertEqual(os.path.dirname(out["path"]), os.path.join(self.home, "Documents", "Glicomy"))

        shutil.rmtree(os.path.join(self.home, "Documents"))
        out = self.export("csv", "--profile", PROFILE, "--range", "all", "--unit", "mgdl", env=env)
        self.assertEqual(os.path.dirname(out["path"]), os.path.join(self.home, "Glicomy"))


class PureHelpers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.store = load_bin_module("glicomy_store")

    def test_profile_slug(self):
        slug = self.store.profile_slug
        self.assertEqual(slug("Ana María!! 2026"), "Ana-Mar-a-2026")
        self.assertEqual(slug("   "), "profile")
        self.assertEqual(slug("Ñandú"), "and")
        self.assertEqual(slug("../../etc/passwd"), "etc-passwd")
        self.assertLessEqual(len(slug("a" * 30 + " " + "b" * 30)), 24)
        self.assertFalse(slug("abcdefghijklmnopqrstuvw xyz").endswith("-"))

    def test_category_of_matches_the_model(self):
        c = self.store.category_of
        premeal = {20: "veryLow", 53: "veryLow", 54: "low", 69: "low", 70: "belowTarget", 79: "belowTarget",
                   80: "inRange", 130: "inRange", 131: "high", 176: "high", 250: "high", 251: "veryHigh", 600: "veryHigh"}
        for context in ("", "Fasting", "Before meal", "Bedtime", "Overnight", "Exercise", "Other"):
            for value, key in premeal.items():
                self.assertEqual(c(value, context), key, (context, value))
        postmeal = {69: "low", 70: "inRange", 176: "inRange", 180: "inRange", 181: "high", 251: "veryHigh"}
        for value, key in postmeal.items():
            self.assertEqual(c(value, "After meal"), key, value)

    def test_units_and_rounding_match_the_model(self):
        store = self.store
        self.assertEqual(store.format_glucose(100, "mmol"), "5.5")
        self.assertEqual(store.format_glucose(70, "mmol"), "3.9")
        self.assertEqual(store.format_glucose(180, "mmol"), "10.0")
        self.assertEqual(store.format_glucose(181, "mmol"), "10.0")
        self.assertEqual(store.format_glucose(250, "mmol"), "13.9")
        self.assertEqual(store.format_glucose(128, "mgdl"), "128")
        self.assertEqual(store.format_insulin(None), "")
        self.assertEqual(store.format_insulin(4), "4")
        self.assertEqual(store.format_insulin(4.5), "4.5")
        self.assertEqual(store.strict_tenths(4.5, (0, 100)), 4.5)
        self.assertEqual(store.strict_tenths(2.0, (0, 100)), 2)
        self.assertIsNone(store.strict_tenths(4.25, (0, 100)))
        self.assertIsNone(store.strict_tenths(True, (0, 100)))

    def test_distribution_ranges_do_not_overlap(self):
        dist = self.store.report_distribution([], "mmol")
        self.assertEqual([e["premeal"] for e in dist], ["< 3.0", "3.0-3.8", "3.9-4.4", "4.5-7.2", "7.3-13.9", "> 13.9"])
        self.assertEqual([e["postmeal"] for e in dist], ["< 3.0", "3.0-3.8", "", "3.9-10.0", "10.1-13.9", "> 13.9"])
        dist = self.store.report_distribution([], "mgdl")
        self.assertEqual([e["premeal"] for e in dist], ["< 54", "54-69", "70-79", "80-130", "131-250", "> 250"])
        self.assertEqual([e["postmeal"] for e in dist], ["< 54", "54-69", "", "70-180", "181-250", "> 250"])

    def test_distribution_judges_each_reading_by_context(self):
        readings = [{"glucose": 176, "context": ""}, {"glucose": 176, "context": "After meal"}]
        pct = {e["label"]: e["pct"] for e in self.store.report_distribution(readings, "mgdl")}
        self.assertEqual((pct["High"], pct["In target"]), (50, 50))

    def test_report_stats(self):
        readings = [{"glucose": value} for value in (80, 120, 160)]
        stats = dict(self.store.report_stats(readings, "mgdl"))
        self.assertEqual(stats["Average"], "120 mg/dL")
        self.assertEqual(stats["SD / CV"], "40 mg/dL / 33%")
        self.assertEqual(stats["Range"], "80-160 mg/dL")
        self.assertEqual(stats["Est. A1C"], "5.8%")
        self.assertEqual(self.store.report_stats([], "mgdl"), [])

    def test_formatting_matches_the_model(self):
        store = self.store
        dt = store.parse_at("2026-10-06T07:33")
        self.assertEqual(store.format_date(dt), "Oct 6, 2026")
        self.assertEqual(store.format_time(dt), "7:33 AM")
        self.assertEqual(store.format_time(store.parse_at("2026-10-06T00:05")), "12:05 AM")
        self.assertEqual(store.format_time(store.parse_at("2026-10-06T12:00")), "12:00 PM")
        self.assertIsNone(store.parse_at("2026-02-30T07:33"))
        self.assertIsNone(store.parse_at("2026-10-06T07:33:00"))

    def test_range_start(self):
        store = self.store
        now = store.parse_at("2026-10-06T12:00")
        self.assertEqual(store.range_start("7d", now), store.parse_at("2026-09-30T00:00"))
        self.assertEqual(store.range_start("30d", now), store.parse_at("2026-09-07T00:00"))
        self.assertIsNone(store.range_start("all", now))



class ExportPdf(StoreTestCase):
    @classmethod
    def setUpClass(cls):
        cls.pdf = load_bin_module("glicomy_pdf")

    def state_with_readings(self, count):
        state = sample_state()
        state["readings"] = [
            reading("r_%012x" % index, "2025-%02d-%02dT%02d:30" % (1 + index // 28 % 12, 1 + index % 28, 6 + index % 12),
                    60 + (index * 37) % 260)
            for index in range(count)
        ]
        return state

    def test_export_pdf_for_0_5_and_60_readings(self):
        from test_pdf import count_pages, expected_pages, verify_xref
        for count in (0, 5, 60):
            self.save(self.state_with_readings(count))
            result = self.run_store("export", "pdf", "--profile", PROFILE, "--range", "all", "--unit", ("mgdl", "mmol")[count % 2])
            self.assertEqual(result.returncode, 0, result.stderr)
            out = json.loads(result.stdout)
            self.assertEqual(out["rows"], count)
            self.assertRegex(os.path.basename(out["path"]), r"^Glicomy-Ana-Mar-a-\d{8}-\d{4}(-\d+)?\.pdf$")
            data = read_file(out["path"])
            self.assertEqual(count_pages(data), expected_pages(self.pdf, count), "readings=%d" % count)
            verify_xref(self, data)
            self.assertIn(b"(Ana Mar\xeda) Tj", data)
            if count:
                self.assertIn(b"(From Jan 1, 2025 to ", data)
            else:
                self.assertIn(b"(All readings) Tj", data)
                self.assertIn(b"(No readings in this range) Tj", data)


class ExportInProcess(StoreTestCase):
    """Calls cmd_export directly so the helper's own umask does not mask the modes it asks for."""

    def setUp(self):
        super().setUp()
        self.store = load_bin_module("glicomy_store")
        self.save(sample_state())
        patcher = mock.patch.dict(os.environ, self.env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)
        old_umask = os.umask(0o022)
        self.addCleanup(os.umask, old_umask)

    def test_export_creates_a_private_folder_and_file(self):
        out = self.store.cmd_export("csv", PROFILE, "all", "mgdl")
        folder = os.path.join(self.docs, "Glicomy")
        self.assertEqual(stat.S_IMODE(os.stat(folder).st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(os.stat(out["path"]).st_mode), 0o600)

    def test_export_leaves_a_pre_existing_folder_mode_alone(self):
        folder = os.path.join(self.docs, "Glicomy")
        os.mkdir(folder)
        os.chmod(folder, 0o755)
        self.store.cmd_export("csv", PROFILE, "all", "mgdl")
        self.assertEqual(stat.S_IMODE(os.stat(folder).st_mode), 0o755)

    def test_failed_write_removes_the_partial_export(self):
        def no_space(fd, data):
            os.write(fd, data[:10])
            raise OSError(errno.ENOSPC, os.strerror(errno.ENOSPC))

        with mock.patch.object(self.store, "write_all", no_space):
            with self.assertRaises(OSError):
                self.store.cmd_export("csv", PROFILE, "all", "mgdl")
        folder = os.path.join(self.docs, "Glicomy")
        self.assertEqual([name for name in os.listdir(folder) if name.startswith("Glicomy-")], [])

    def test_failed_fsync_removes_the_partial_export(self):
        real_fsync = os.fsync
        calls = []

        def failing_fsync(fd):
            calls.append(fd)
            if len(calls) == 1:
                raise OSError(errno.EIO, os.strerror(errno.EIO))
            return real_fsync(fd)

        with mock.patch.object(self.store.os, "fsync", failing_fsync):
            with self.assertRaises(OSError):
                self.store.cmd_export("csv", PROFILE, "all", "mgdl")
        folder = os.path.join(self.docs, "Glicomy")
        self.assertEqual([name for name in os.listdir(folder) if name.startswith("Glicomy-")], [])


if __name__ == "__main__":
    unittest.main()
