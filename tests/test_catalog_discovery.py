"""Nested-repository discovery for catalog; temporary directories only."""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ENGINE = Path(__file__).resolve().parents[1] / "engine"
sys.path.insert(0, str(ENGINE))
from linter import catalog, repositories  # noqa: E402


class RepositoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-repos-")
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def make_repo(self, relative, play=None):
        directory = self.root / relative
        (directory / ".git").mkdir(parents=True, exist_ok=True)
        if play:
            scene = directory / ".test-plays" / play
            scene.mkdir(parents=True, exist_ok=True)
            (scene / "play.json").write_text(
                json.dumps({"version": 1, "scenarioName": play, "steps": []}), encoding="utf-8")
        return directory

    def test_lists_git_repositories_with_play_counts(self):
        self.make_repo("with-plays", "alpha")
        self.make_repo("without-plays")
        result = repositories({"action": "repos", "repoRoot": str(self.root)})
        self.assertTrue(result["ok"])
        self.assertEqual([item["relative"] for item in result["repositories"]], ["with-plays", "without-plays"])
        self.assertEqual(result["repositories"][0]["plays"], 1)
        self.assertEqual(result["repositories"][1]["plays"], 0)

    def test_repositories_with_plays_are_sorted_first(self):
        self.make_repo("aaa-empty")
        self.make_repo("zzz-has-plays", "alpha")
        result = repositories({"action": "repos", "repoRoot": str(self.root)})
        self.assertEqual(result["repositories"][0]["relative"], "zzz-has-plays")

    def test_plain_directories_are_not_offered(self):
        (self.root / "just-a-folder" / ".test-plays" / "x").mkdir(parents=True)
        result = repositories({"action": "repos", "repoRoot": str(self.root)})
        self.assertEqual(result["repositories"], [])

    def test_root_repository_is_listed_once_and_not_descended(self):
        self.make_repo(".", "root-play")
        (self.root / "vendor" / ".git").mkdir(parents=True)
        result = repositories({"action": "repos", "repoRoot": str(self.root)})
        self.assertEqual([item["relative"] for item in result["repositories"]], ["."])

    def test_symlinked_repository_outside_root_is_ignored(self):
        outside = Path(tempfile.mkdtemp(prefix="playtest-outside-repo-")).resolve()
        try:
            (outside / ".git").mkdir(parents=True)
            try:
                (self.root / "escape").symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("filesystem does not allow directory symlinks")
            result = repositories({"action": "repos", "repoRoot": str(self.root)})
            self.assertEqual(result["repositories"], [])
        finally:
            shutil.rmtree(outside, ignore_errors=True)


class DiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="playtest-discovery-")
        self.root = Path(self.temp.name).resolve()

    def tearDown(self):
        self.temp.cleanup()

    def write_play(self, repo, slug):
        directory = self.root / repo / ".test-plays" / slug
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "play.json").write_text(
            json.dumps({"version": 1, "scenarioName": slug, "steps": []}), encoding="utf-8")

    def test_nested_repos_are_surfaced_when_root_has_no_plays(self):
        self.write_play("repoA", "alpha")
        self.write_play("nested/repoB", "beta")
        result = catalog({"action": "catalog", "repoRoot": str(self.root)})
        self.assertTrue(result["ok"])
        self.assertEqual(result["plays"], [])
        found = {Path(item["repoRoot"]).name: item["plays"] for item in result["repoCandidates"]}
        self.assertEqual(found, {"repoA": 1, "repoB": 1})

    def test_candidates_are_hidden_once_the_selected_repo_has_plays(self):
        self.write_play("here", "main")
        self.write_play("repoA", "alpha")
        result = catalog({"action": "catalog", "repoRoot": str(self.root / "here")})
        self.assertEqual([play["slug"] for play in result["plays"]], ["main"])
        self.assertNotIn("repoCandidates", result)

    def test_hidden_and_build_directories_are_not_offered(self):
        for name in (".hidden", "node_modules", "target"):
            self.write_play(name, "scene")
        result = catalog({"action": "catalog", "repoRoot": str(self.root)})
        self.assertNotIn("repoCandidates", result)

    def test_symlink_leaving_the_workspace_is_not_offered(self):
        outside = Path(tempfile.mkdtemp(prefix="playtest-outside-")).resolve()
        try:
            (outside / ".test-plays" / "leak").mkdir(parents=True)
            (outside / ".test-plays" / "leak" / "play.json").write_text(
                json.dumps({"version": 1, "scenarioName": "leak", "steps": []}), encoding="utf-8")
            self.write_play("repoA", "alpha")
            try:
                (self.root / "escape-link").symlink_to(outside, target_is_directory=True)
            except OSError:
                self.skipTest("filesystem does not allow directory symlinks")
            result = catalog({"action": "catalog", "repoRoot": str(self.root)})
            offered = [item["repoRoot"] for item in result.get("repoCandidates", [])]
            self.assertTrue(all(not os.path.realpath(path).startswith(str(outside)) for path in offered), offered)
        finally:
            shutil.rmtree(outside, ignore_errors=True)


    def test_asset_directories_are_never_candidate_repositories(self):
        workspace = self.root / "workspace"
        for name in (".test-plays", "test-plays", ".playtest"):
            hidden = workspace / name / "project"
            hidden.mkdir(parents=True)
            (hidden / ".git").mkdir()
        # A sibling outside those directories must still be found, so a bare [] below
        # cannot be explained by a scan that simply discovers nothing.
        visible = workspace / "real-project"
        (visible / ".git").mkdir(parents=True)
        found = repositories({"repoRoot": str(workspace)})["repositories"]
        self.assertEqual([item["relative"] for item in found], ["real-project"],
                         "only the real repository is offered; copies under asset dirs are not")


if __name__ == "__main__":
    unittest.main()
