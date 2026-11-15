"""Aider polyglot (Python subset) evaluation for kraken-coder.

Protocol follows Aider: up to 2 attempts; after a failed first attempt the
agent receives the unit-test output and may fix its solution (same session).
Reference solutions (.meta/) are never copied into the task workspace.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from agent_runner import run_agent

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs" / "polyglot"
RESULTS = ROOT / "results"
EXERCISM = ROOT / "data" / "exercism-python"
SLUGS = ["affine-cipher", "bowling", "food-chain", "grade-school",
         "paasio", "poker", "scale-generator", "wordy"]
PIP_INDEX = ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]

TASK_TEMPLATE = """Here are the instructions for a coding exercise:

{instructions}

Implement the solution in `{module}.py` (a stub file already exists in the workspace) so that ALL tests in `{module}_test.py` pass.
- Use the shell tool to run the tests: python -m pytest {module}_test.py -q
- Do not modify the test file.
- Read instructions.md in the workspace if you need the spec again.
When done, briefly summarize your implementation and the test result.
"""

RETRY_TEMPLATE = """The tests are still failing. Here is the latest test output:

```
{output}
```

Fix `{module}.py` so all tests pass, then re-run: python -m pytest {module}_test.py -q
Do not modify the test file.
"""


def sh(cmd, cwd=None, timeout=900, check=True):
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise RuntimeError(f"cmd failed: {cmd}\n{proc.stdout[-2000:]}\n{proc.stderr[-2000:]}")
    return proc


def ensure_exercism(slugs):
    if not (EXERCISM / ".git").exists():
        EXERCISM.parent.mkdir(parents=True, exist_ok=True)
        sh(["git", "clone", "--depth", "1", "--filter=blob:none", "--sparse", "-q",
            "https://github.com/exercism/python", str(EXERCISM)], timeout=1200)
    paths = [f"exercises/practice/{s}" for s in slugs]
    sh(["git", "sparse-checkout", "set", *paths], cwd=EXERCISM, timeout=600)


def ensure_venv():
    venv = RUNS / "venv"
    py = venv / "bin" / "python"
    if not py.exists():
        RUNS.mkdir(parents=True, exist_ok=True)
        sh([sys.executable, "-m", "venv", str(venv)])
        sh([str(py), "-m", "pip", "install", "-q", "pytest", *PIP_INDEX], timeout=600)
    return venv, py


def build_workspace(slug):
    src = EXERCISM / "exercises" / "practice" / slug
    ws = RUNS / slug / "workspace"
    if ws.exists():
        shutil.rmtree(ws)
    ws.mkdir(parents=True)
    module = slug.replace("-", "_")
    instructions = (src / ".docs" / "instructions.md").read_text()
    append = src / ".docs" / "instructions.append.md"
    if append.exists():
        instructions += "\n\n" + append.read_text()
    (ws / "instructions.md").write_text(instructions)
    shutil.copy(src / f"{module}.py", ws / f"{module}.py")
    shutil.copy(src / f"{module}_test.py", ws / f"{module}_test.py")
    for helper in src.glob("*.py"):
        if helper.name not in (f"{module}.py", f"{module}_test.py"):
            shutil.copy(helper, ws / helper.name)
    return ws, module, instructions


def run_tests(py, ws, module, junit):
    proc = sh([str(py), "-m", "pytest", f"{module}_test.py", "-q", "--tb=short",
               "-p", "no:cacheprovider", f"--junitxml={junit}"], cwd=ws, check=False)
    passed = failed = 0
    if Path(junit).exists():
        for case in ET.parse(junit).getroot().iter("testcase"):
            if case.find("failure") is not None or case.find("error") is not None:
                failed += 1
            else:
                passed += 1
    return {"passed": passed, "failed": failed, "exit_code": proc.returncode,
            "all_pass": proc.returncode == 0 and failed == 0 and passed > 0,
            "output": (proc.stdout + proc.stderr)[-4000:]}


def env_check(slug, py):
    """Run the exercise tests against the reference solution (.meta/example.py)
    in a scratch dir. Validates deps/helpers before spending agent calls."""
    src = EXERCISM / "exercises" / "practice" / slug
    module = slug.replace("-", "_")
    with tempfile.TemporaryDirectory() as tmp:
        ws = Path(tmp)
        shutil.copy(src / ".meta" / "example.py", ws / f"{module}.py")
        shutil.copy(src / f"{module}_test.py", ws / f"{module}_test.py")
        for helper in src.glob("*.py"):
            if helper.name not in (f"{module}.py", f"{module}_test.py"):
                shutil.copy(helper, ws / helper.name)
        return run_tests(py, ws, module, ws / "junit.xml")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slugs-file", help="JSON list of slugs (default: original 8)")
    ap.add_argument("--skip-existing", action="store_true",
                    help="skip slugs that already have a results file")
    ap.add_argument("--run-tag", default="r1", help="unique session suffix")
    ap.add_argument("--env-check-only", action="store_true",
                    help="validate reference solutions pass tests; no agent calls")
    args = ap.parse_args()
    slugs = json.loads(Path(args.slugs_file).read_text()) if args.slugs_file else SLUGS
    ensure_exercism(slugs)
    venv, py = ensure_venv()
    os.environ["PATH"] = str(venv / "bin") + os.pathsep + os.environ.get("PATH", "")
    RESULTS.mkdir(parents=True, exist_ok=True)
    for slug in slugs:
        if args.skip_existing and (RESULTS / f"polyglot_{slug}.json").exists():
            print(f"[{slug}] skipped: result exists", flush=True)
            continue
        if args.env_check_only:
            t = env_check(slug, py)
            print(f"[{slug}] env-check all_pass={t['all_pass']} "
                  f"passed={t['passed']} failed={t['failed']}", flush=True)
            if not t["all_pass"]:
                print(t["output"][-1200:], flush=True)
            continue
        ws, module, instructions = build_workspace(slug)
        base = RUNS / slug
        attempts = []
        final = None
        for attempt in (1, 2):
            if attempt == 1:
                message = TASK_TEMPLATE.format(instructions=instructions, module=module)
            else:
                message = RETRY_TEMPLATE.format(output=attempts[-1]["test_output"], module=module)
            print(f"[{slug}] attempt {attempt} starting", flush=True)
            metrics = run_agent(message, cwd=ws, home=base / "home", session=f"{slug}-{args.run_tag}",
                                max_steps=24, turn_timeout_ms=480_000,
                                log_path=base / f"attempt{attempt}.jsonl")
            tests = run_tests(py, ws, module, base / f"attempt{attempt}-junit.xml")
            attempts.append({"attempt": attempt,
                             "agent": {k: v for k, v in metrics.items() if k != "answer"},
                             "answer_excerpt": metrics["answer"][:500],
                             "tests": {k: v for k, v in tests.items() if k != "output"},
                             "test_output": tests["output"],
                             "test_output_tail": tests["output"][-1500:]})
            final = tests
            if tests["all_pass"]:
                break
        record = {"slug": slug, "pass": bool(final and final["all_pass"]),
                  "attempts_used": len(attempts), "attempts": attempts}
        (RESULTS / f"polyglot_{slug}.json").write_text(json.dumps(record, indent=1, ensure_ascii=False))
        print(f"[{slug}] pass={record['pass']} attempts={len(attempts)}", flush=True)


if __name__ == "__main__":
    main()