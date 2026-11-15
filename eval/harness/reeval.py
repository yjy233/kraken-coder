"""Re-judge a saved model.patch without re-running the agent (e.g. after a
harness fix). Usage: python3 harness/reeval.py <instance_id>
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from swebench_eval import (load_instances, setup_repo, evaluate, sh,
                           restore_generated, RESULTS)


def main():
    iid = sys.argv[1]
    inst = next(r for r in load_instances() if r["instance_id"] == iid)
    base, repo, py = setup_repo(inst)
    sh(["git", "reset", "-q", "--hard", "HEAD"], cwd=repo)
    sh(["git", "clean", "-qfdx"], cwd=repo)
    restore_generated(inst, repo)
    result = evaluate(inst, base, repo, py)
    out = RESULTS / f"swe_{iid}.json"
    record = json.loads(out.read_text()) if out.exists() else {}
    record.update(result)
    out.write_text(json.dumps(record, indent=1, ensure_ascii=False))
    print(f"{iid}: resolved={result['resolved']} category={result['category']} "
          f"ftp={len(result.get('ftp', {}).get('tests', {}))} "
          f"p2p={len(result.get('p2p', {}).get('tests', {}))}")


if __name__ == "__main__":
    main()