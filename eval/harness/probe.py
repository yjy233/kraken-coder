"""Sensitivity probe: re-run one instance with a larger context budget.

Archives the primary artifacts, runs the probe, stores the result as
results/probe_<iid>_bigctx.json (excluded from the primary score), then
restores the primary artifacts. Usage: python3 harness/probe.py <iid> [chars]
"""
import json
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from swebench_eval import (load_instances, setup_repo, extract_patch, evaluate,
                           RESULTS, sh, restore_generated, AGENT_SUFFIX)
from agent_runner import run_agent

ARTIFACTS = ["agent.jsonl", "agent.jsonl.stderr", "agent.cmd.json", "model.patch"]


def main():
    iid = sys.argv[1]
    ctx = int(sys.argv[2]) if len(sys.argv) > 2 else 400_000
    inst = next(r for r in load_instances() if r["instance_id"] == iid)
    base, repo, py = setup_repo(inst)
    for name in ARTIFACTS:
        if (base / name).exists():
            shutil.copy(base / name, base / (name + ".primary"))
    primary_result = RESULTS / f"swe_{iid}.json"
    shutil.copy(primary_result, base / "primary_result.json")

    sh(["git", "reset", "-q", "--hard", "HEAD"], cwd=repo)
    sh(["git", "clean", "-qfdx"], cwd=repo)
    restore_generated(inst, repo)
    message = inst["problem_statement"] + AGENT_SUFFIX.format(repo=inst["repo"])
    print(f"[{iid}] probe ctx={ctx} starting", flush=True)
    metrics = run_agent(message, cwd=repo, home=base / "home",
                        session=f"{iid}-probe{ctx}", max_steps=40,
                        turn_timeout_ms=1_200_000, context_chars=ctx,
                        log_path=base / "agent.jsonl")
    patch_lines = extract_patch(inst, repo, base / "model.patch")
    result = evaluate(inst, base, repo, py)
    gold = json.loads((base / "gold_check.json").read_text())
    record = {**result, "run_tag": f"probe{ctx}", "context_chars": ctx,
              "gold_check_passed": gold["ftp_passed"] and gold.get("p2p_passed", True),
              "patch_lines": patch_lines,
              "agent": {k: v for k, v in metrics.items() if k != "answer"},
              "answer_excerpt": metrics["answer"][:800]}
    (RESULTS / f"probe_{iid}_bigctx.json").write_text(json.dumps(record, indent=1, ensure_ascii=False))

    for name in ARTIFACTS:
        if (base / (name + ".primary")).exists():
            shutil.copy(base / (name + ".primary"), base / name)
    shutil.copy(base / "primary_result.json", primary_result)
    print(f"[{iid}] probe resolved={result['resolved']} category={result['category']} "
          f"reqs={metrics['model_requests']} wall={metrics['wall_seconds']}s", flush=True)


if __name__ == "__main__":
    main()