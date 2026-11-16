"""Offline publication checks; no network or model calls."""
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("eval_report", Path(__file__).resolve().parents[1] / "harness" / "report.py")
report = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(report)


class ReportTests(unittest.TestCase):
    def test_primary_scores_exclude_quarantine_pilot_and_probes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            results = root / "results"
            for path in [root / "data", results / "quarantine_429", results / "pilot"]:
                path.mkdir(parents=True, exist_ok=True)
            def write(path, value):
                path.write_text(json.dumps(value))
            write(root / "data/selected_instances_30.json", [{"instance_id": "done"}, {"instance_id": "pending"}])
            write(root / "data/polyglot_slugs_34.json", ["done", "pending"])
            write(results / "swe_done.json", {"instance_id": "done", "resolved": True, "category": "resolved", "agent": {"model_requests": 2}})
            write(results / "polyglot_done.json", {"slug": "done", "pass": True, "attempts": [{"tests": {"all_pass": False}}, {"tests": {"all_pass": True}, "agent": {"model_requests": 3}}]})
            write(results / "quarantine_429/swe_pending.json", {"instance_id": "pending", "resolved": False})
            write(results / "pilot/swe_done.json", {"instance_id": "done", "resolved": False})
            write(results / "probe_pending.json", {"instance_id": "pending", "resolved": True})
            with patch.object(report, "ROOT", root), patch.object(report, "RESULTS", results):
                summary = report.build_summary()
            self.assertEqual(summary["status"], "partial")
            self.assertEqual(summary["swebench_lite"]["evaluated"], 1)
            self.assertEqual(summary["swebench_lite"]["resolved"], 1)
            self.assertEqual(summary["swebench_lite"]["missing"], ["pending"])
            self.assertEqual(summary["polyglot_python"]["evaluated"], 1)
            self.assertEqual(summary["polyglot_python"]["passed_on_first_attempt"], 0)
            self.assertEqual(summary["polyglot_python"]["passed_within_two_attempts"], 1)
            self.assertEqual(summary["primary_attempt_totals"]["model_requests"], 5)
            self.assertEqual(summary["excluded_from_primary_score"], {"quota_failure_records": 1, "pilot_records": 1, "sensitivity_probe_records": 1})

    def test_no_results_does_not_report_a_zero_or_perfect_score(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            results = root / "results"
            results.mkdir()
            (root / "data/selected_instances_30.json").write_text('[{"instance_id": "pending"}]')
            (root / "data/polyglot_slugs_34.json").write_text('["pending"]')
            with patch.object(report, "ROOT", root), patch.object(report, "RESULTS", results):
                summary = report.build_summary()
            self.assertEqual(summary["status"], "partial")
            self.assertIsNone(summary["swebench_lite"]["resolved_rate_on_evaluated"])
            self.assertIsNone(summary["polyglot_python"]["pass_rate_on_evaluated"])
            self.assertEqual(summary["primary_attempt_totals"]["model_requests"], 0)


if __name__ == "__main__":
    unittest.main()
