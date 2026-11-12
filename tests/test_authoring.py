"""Asset authoring: an empty business skeleton, and a play grown from recorded evidence."""
import io
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))
from authoring import _derive_http, _draftable  # noqa: E402
from cli import dispatch  # noqa: E402


class AuthoringTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-author-")
        self.root = Path(self.temp.name).resolve()
        (self.root / ".test-plays").mkdir()
        self.write(self.root / ".test-plays/config.json", {
            "targets": {"local": {"baseUrl": "http://127.0.0.1:1"}},
            "databases": {"main": {"driver": "sqlite", "path": "${runDir}/db.sqlite"}}})

    def tearDown(self):
        self.temp.cleanup()

    def write(self, path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def read(self, path):
        return json.loads((self.root / ".test-plays" / path).read_text(encoding="utf-8"))

    def play_with_observed_steps(self, name="probe", expect=None):
        expect = expect or [{}, {}]
        self.write(self.root / ".test-plays" / name / "play.json", {
            "version": 1, "scenarioName": "桩接口探测", "mode": "explore", "steps": [
                {"stepNo": 1, "name": "查库存", "type": "http", "method": "GET",
                 "path": "${mock.api.url}/stock", "expect": expect[0]},
                {"stepNo": 2, "name": "做预留", "type": "http", "method": "POST", "path": "${mock.api.url}/reserve",
                 "body": {"quantity": 3}, "expect": expect[1]}]})
        self.write(self.root / ".test-plays" / name / "scenario.json", {
            "variables": {}, "setup": [], "cleanup": [],
            "mocks": [{"id": "api", "port": 0, "routes": [
                {"method": "GET", "path": "/stock", "status": 200, "body": {"available": 10, "unit": "pcs"}},
                {"method": "POST", "path": "/reserve", "status": 200,
                 "body": {"available": 7, "reserved": 3, "token": "secret-value-1"}}]}]})

    def run_play(self, play, scenario=None):
        command = {"action": "run", "repoRoot": str(self.root), "play": play}
        if scenario:
            command["scenario"] = scenario
        output = io.StringIO()
        result = dispatch(command, output)
        self.assertEqual([json.loads(line) for line in output.getvalue().splitlines()][-1]["type"], "run_finished")
        return result

    # ---- create ---------------------------------------------------------------
    def test_create_makes_a_readable_empty_business_play(self):
        created = dispatch({"action": "create", "repoRoot": str(self.root), "name": "station-offline-guard",
                            "title": "下线后不应继续接单", "target": "local",
                            "description": "验证工作站下线后接单标志被业务侧停止"})
        self.assertTrue(created["ok"])
        play = self.read("station-offline-guard/play.json")
        self.assertEqual(play["scenarioName"], "下线后不应继续接单", "标题必须是能读懂的中文业务句")
        self.assertEqual(play["mode"], "explore", "空骨架不能声称已验证")
        self.assertEqual(play["steps"], [])
        self.assertEqual(play["target"], "local")
        scenario = self.read("station-offline-guard/scenario.json")
        self.assertEqual([scenario["variables"], scenario["setup"], scenario["cleanup"], scenario["mocks"]],
                         [{}, [], [], []])
        notes = (self.root / ".test-plays/station-offline-guard/NOTES.md").read_text(encoding="utf-8")
        self.assertIn("依据", notes, "骨架必须提醒补齐断言来源")
        issues = dispatch({"action": "lint", "repoRoot": str(self.root)})["issues"]
        self.assertTrue(any(i["code"] == "no_assertions" for i in issues), issues)
        self.assertEqual(dispatch({"action": "lint", "repoRoot": str(self.root)})["errors"], 0)

    def test_create_never_overwrites_and_refuses_bad_input(self):
        dispatch({"action": "create", "repoRoot": str(self.root), "name": "dup", "title": "重复"})
        with self.assertRaises(Exception) as twice:
            dispatch({"action": "create", "repoRoot": str(self.root), "name": "dup", "title": "又一遍"})
        self.assertIn("already exists", str(twice.exception))
        for bad in ({"name": "Bad_Name"}, {"name": "ok-slug", "target": "nope"}):
            with self.assertRaises(Exception, msg=str(bad)):
                dispatch({"action": "create", "repoRoot": str(self.root), "title": "标题", **bad})

    def test_one_declared_target_is_inferred_instead_of_asked(self):
        # The fixture config declares exactly one target; asking which one is busywork.
        created = dispatch({"action": "create", "repoRoot": str(self.root), "name": "infer-me", "title": "下线后不应继续接单"})
        self.assertTrue(created["targetInferred"])
        self.assertEqual(created["target"], "local")
        self.assertEqual(self.read("infer-me/play.json")["target"], "local")

    def test_ambiguous_or_missing_targets_are_never_guessed(self):
        self.write(self.root / ".test-plays" / "config.json",
                   {"targets": {"local": {"baseUrl": "http://127.0.0.1:1"},
                                "staging": {"baseUrl": "http://127.0.0.1:2"}}})
        created = dispatch({"action": "create", "repoRoot": str(self.root), "name": "two-targets", "title": "两个目标时不猜"})
        self.assertFalse(created["targetInferred"])
        self.assertNotIn("target", self.read("two-targets/play.json"),
                         "picking between two services is a human decision")
        self.write(self.root / ".test-plays" / "config.json", {"targets": {}, "databases": {}})
        bare = dispatch({"action": "create", "repoRoot": str(self.root), "name": "no-config-target", "title": "没有目标也能建骨架"})
        self.assertNotIn("target", self.read("no-config-target/play.json"))
        self.assertTrue(bare["ok"])

    def test_a_title_alone_is_enough_to_create(self):
        created = dispatch({"action": "create", "repoRoot": str(self.root), "title": "批次单回退 NEW 的回归"})
        self.assertTrue(created["ok"])
        self.assertRegex(created["slug"], r"^[a-z0-9]+(-[a-z0-9]+)*$", "derived name stays a kebab slug")
        self.assertTrue(created["slug"].startswith("new-"), "Latin tokens from the sentence carry meaning")
        self.assertEqual(self.read(created["slug"] + "/play.json")["scenarioName"], "批次单回退 NEW 的回归",
                         "the readable title, not the path, is what the list shows")
        with self.assertRaises(Exception):
            dispatch({"action": "create", "repoRoot": str(self.root)})   # neither title nor name

    def test_two_identical_sentences_stay_in_two_directories(self):
        first = dispatch({"action": "create", "repoRoot": str(self.root), "title": "重复标题"})
        second = dispatch({"action": "create", "repoRoot": str(self.root), "title": "重复标题"})
        self.assertNotEqual(first["slug"], second["slug"], "a colliding name must not overwrite the earlier play")

    # ---- draft ----------------------------------------------------------------
    def test_saving_a_run_needs_no_arguments_but_the_run(self):
        self.play_with_observed_steps()
        result = self.run_play("probe")
        drafted = dispatch({"action": "draft", "repoRoot": str(self.root), "runId": result["runId"]})
        self.assertTrue(drafted["ok"])
        self.assertEqual(drafted["slug"], "probe-observed", "the name follows the played slug")
        play = self.read("probe-observed/play.json")
        self.assertEqual(play["scenarioName"], "桩接口探测（沉淀）", "the title follows the play title")
        again = dispatch({"action": "draft", "repoRoot": str(self.root), "runId": result["runId"]})
        self.assertNotEqual(again["slug"], drafted["slug"], "a second save must not overwrite the first")
    def test_draft_writes_observed_values_and_labels_them(self):
        self.play_with_observed_steps()
        result = self.run_play("probe")
        self.assertEqual(result["verdict"], "inconclusive", "无断言的运行不能算通过")
        drafted = dispatch({"action": "draft", "repoRoot": str(self.root), "runId": result["runId"],
                            "name": "probe-baseline", "title": "桩接口探测（沉淀）"})
        self.assertTrue(drafted["ok"])
        play = self.read("probe-baseline/play.json")
        self.assertEqual(play["mode"], "explore")
        self.assertEqual(play["source"]["kind"], "draft")
        self.assertEqual(play["source"]["runId"], result["runId"])
        first, second = play["steps"]
        self.assertEqual(first["expect"], {"status": 200, "json": {"$.available": 10, "$.unit": "pcs"}})
        self.assertEqual(second["expect"]["status"], 200)
        self.assertEqual(second["expect"]["json"]["$.reserved"], 3)
        self.assertNotIn("$.token", second["expect"].get("json", {}),
                         "响应里的密钥类字段不能被写成断言")
        self.assertIn("观察到", (self.root / ".test-plays/probe-baseline/NOTES.md").read_text(encoding="utf-8"))
        # The draft must be immediately usable: it lints and previews like any other play.
        self.assertEqual(dispatch({"action": "lint", "repoRoot": str(self.root)})["errors"], 0)
        inspection = dispatch({"action": "inspect", "repoRoot": str(self.root), "play": "probe-baseline"})
        self.assertTrue(inspection["ok"], inspection["issues"])
        self.assertGreater(inspection["preview"]["assertions"], 0)

    def test_draft_keeps_existing_expectations_instead_of_rewriting_them(self):
        self.play_with_observed_steps(expect=[{"status": 200}, {"status": 200, "json": {"$.available": 7}}])
        result = self.run_play("probe")
        dispatch({"action": "draft", "repoRoot": str(self.root), "runId": result["runId"], "name": "keep"})
        steps = self.read("keep/play.json")["steps"]
        self.assertEqual(steps[0]["expect"], {"status": 200, "json": {"$.available": 10, "$.unit": "pcs"}},
                         "原有断言保留，只补没写过的字段")
        self.assertEqual(steps[1]["expect"]["json"]["$.available"], 7, "已写过的字段保留作者给的值")
        self.assertEqual(steps[1]["expect"]["json"]["$.reserved"], 3, "没写过的字段才补上观察值")
        self.assertNotIn("$.token", steps[1]["expect"]["json"], "脱敏字段不进断言")

    def test_a_failed_step_never_becomes_someone_elses_expectation(self):
        self.play_with_observed_steps(expect=[{}, {"status": 200, "json": {"$.available": 999}}])
        self.write(self.root / ".test-plays" / "probe" / "scenario-strict.json", {
            "variables": {}, "setup": [], "cleanup": [],
            "mocks": [{"id": "api", "port": 0, "routes": [
                {"method": "GET", "path": "/stock", "status": 200, "body": {"available": 10}},
                {"method": "POST", "path": "/reserve", "status": 200, "body": {"available": 7}}]}]})
        result = self.run_play("probe", "scenario-strict.json")
        self.assertEqual(result["verdict"], "failed")
        dispatch({"action": "draft", "repoRoot": str(self.root), "runId": result["runId"], "name": "from-failure"})
        steps = self.read("from-failure/play.json")["steps"]
        self.assertEqual(steps[1]["expect"]["json"]["$.available"], 999, "失败步的旧预期必须原样保留")
        self.assertNotIn("$.reserved", steps[1]["expect"]["json"], "失败响应不得转成新预期")
        notes = (self.root / ".test-plays/from-failure/NOTES.md").read_text(encoding="utf-8")
        self.assertIn("该步在这次运行失败", notes)

    def test_draft_refuses_unknown_run_and_ambiguous_play(self):
        self.play_with_observed_steps("one")
        self.play_with_observed_steps("two")
        first = self.run_play("one")
        with self.assertRaises(Exception):
            dispatch({"action": "draft", "repoRoot": str(self.root), "runId": "0" * 16, "name": "ghost"})
        both = dispatch({"action": "run", "repoRoot": str(self.root), "plays": ["one", "two"]})
        with self.assertRaises(Exception) as ambiguous:
            dispatch({"action": "draft", "repoRoot": str(self.root), "runId": both["runId"], "name": "which"})
        self.assertIn("Select one play", str(ambiguous.exception))
        chosen = dispatch({"action": "draft", "repoRoot": str(self.root), "runId": both["runId"],
                           "name": "picked", "play": "one"})
        self.assertEqual(chosen["fromPlay"], "one")
        self.assertEqual(first["verdict"], "inconclusive")

    def test_draft_copies_the_scenario_that_produced_the_run(self):
        self.play_with_observed_steps()
        result = self.run_play("probe")
        dispatch({"action": "draft", "repoRoot": str(self.root), "runId": result["runId"], "name": "copy-scenario"})
        scenario = self.read("copy-scenario/scenario.json")
        self.assertEqual([route["path"] for route in scenario["mocks"][0]["routes"]], ["/stock", "/reserve"])
        self.assertIn("沉淀", scenario["description"])

    # ---- pure helpers ---------------------------------------------------------
    def test_redacted_and_error_status_values_are_not_draftable(self):
        self.assertFalse(_draftable("[REDACTED]"))
        self.assertTrue(_draftable(7))
        expect, skipped = _derive_http({"response": {"status": 500, "body": {"ok": False}}})
        self.assertNotIn("status", expect, "5xx 不能写成预期状态")
        self.assertTrue(skipped)




    def test_a_playback_creates_the_ignore_rule_when_assets_were_copied_in(self):
        # npm strips .gitignore from packages, so a repo can hold valid plays with no ignore
        # rule at all; the first playback must add it before it writes evidence.
        ignore = self.root / ".test-plays" / ".gitignore"
        self.play_with_observed_steps()
        self.assertFalse(ignore.exists(), "hand-written assets start without any ignore rule")
        dispatch({"action": "inspect", "repoRoot": str(self.root), "play": "probe"})
        self.assertFalse(ignore.exists(), "previewing alone must not touch the repository")
        result = self.run_play("probe")
        self.assertEqual(result["status"], "completed")
        self.assertTrue((self.root / ".test-plays" / "runs" / result["runId"]).is_dir())
        self.assertIn("/runs/", ignore.read_text(encoding="utf-8"),
                      "writing evidence must also keep it out of git")

class LayoutTests(unittest.TestCase):
    """One directory per repository, and the old layout never reads as "no plays found"."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-layout-")
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def test_create_makes_the_asset_directory_with_a_self_ignore(self):
        created = dispatch({"action": "create", "repoRoot": str(self.root), "name": "fresh-play", "title": "新剧本"})
        self.assertTrue(created["ok"])
        assets = self.root / ".test-plays"
        ignore = (assets / ".gitignore").read_text(encoding="utf-8")
        self.assertIn("/runs/", ignore, "generated evidence must not need the repo root gitignore")
        self.assertIn("/cache/", ignore)
        self.assertFalse((assets / "runs").exists(), "creating a play must not pre-create evidence dirs")

    def test_old_layout_is_rejected_with_migration_steps(self):
        (self.root / "test-plays").mkdir()
        (self.root / ".playtest.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(Exception) as caught:
            dispatch({"action": "catalog", "repoRoot": str(self.root)})
        message = str(caught.exception)
        self.assertIn("pre-1.9 layout", message)
        self.assertIn("git mv test-plays .test-plays", message)
        self.assertIn(".test-plays/config.json", message)

    def test_reserved_generated_names_are_not_plays(self):
        dispatch({"action": "create", "repoRoot": str(self.root), "name": "real-play", "title": "真剧本"})
        for reserved in ("runs", "cache"):
            with self.assertRaises(Exception, msg=reserved):
                dispatch({"action": "create", "repoRoot": str(self.root), "name": reserved, "title": "占用生成目录"})
        (self.root / ".test-plays" / "runs" / "abc123").mkdir(parents=True)
        (self.root / ".test-plays" / "runs" / "abc123" / "play.json").write_text("{}", encoding="utf-8")
        catalog = dispatch({"action": "catalog", "repoRoot": str(self.root)})
        self.assertEqual([play["slug"] for play in catalog["plays"]], ["real-play"],
                         "evidence directories must never appear as plays")


if __name__ == "__main__":
    unittest.main()
