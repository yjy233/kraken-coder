"""SWE-bench Lite subset evaluation for kraken-coder (black-box, no agent changes).

Stages:
  setup  clone repos at base_commit, build venvs, run gold-patch self-check
  run    drive the agent per instance, extract patch, judge FTP+P2P
"""
import argparse
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from agent_runner import run_agent

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "runs" / "swebench"
RESULTS = ROOT / "results"
REPO_URL = {
    "sympy/sympy": "https://github.com/sympy/sympy",
    "pytest-dev/pytest": "https://github.com/pytest-dev/pytest",
    "pallets/flask": "https://github.com/pallets/flask",
    "sphinx-doc/sphinx": "https://github.com/sphinx-doc/sphinx",
    "pylint-dev/pylint": "https://github.com/pylint-dev/pylint",
}
EXTRA_DEPS = {"pytest-dev/pytest": ["hypothesis", "pexpect"],
              "pallets/flask": ["werkzeug==2.3.8", "pytest==7.4.4"],
              "sphinx-doc/sphinx": ["setuptools==80.9.0", "pytest==7.4.4", "html5lib"],
              "pylint-dev/pylint": ["setuptools", "pytest==7.4.4", "py",
                                    "pytest-benchmark==4.0.0", "pytest-timeout", "coverage"]}
# Per-instance pins discovered via gold self-checks (py3.12 / old-dep compatibility).
# sphinxcontrib-* >=1.0.5/2.x call require_sphinx('5.0') at runtime without
# declaring it in metadata, so pip installs them against sphinx 3.x/4.x and the
# test app crashes; alabaster>=0.7.13 similarly requires sphinx>=3.4. Pin the
# era-appropriate versions.
SPHINX_OLD_PINS = ["sphinxcontrib-applehelp==1.0.2", "sphinxcontrib-devhelp==1.0.2",
                   "sphinxcontrib-htmlhelp==1.0.3", "sphinxcontrib-jsmath==1.0.1",
                   "sphinxcontrib-qthelp==1.0.3", "sphinxcontrib-serializinghtml==1.1.5",
                   "alabaster==0.7.12"]
INSTANCE_DEPS = {
    # sphinx 3.x: jinja2>=3.1 removed contextfunction; markupsafe>=2.1 removed
    # soft_unicode; docutils>=0.17 changed APIs sphinx 3.x relies on.
    **{f"sphinx-doc__sphinx-{n}": ["jinja2<3.1", "markupsafe<2.1", "docutils==0.16", *SPHINX_OLD_PINS]
       for n in ["7738", "8595", "8721", "8474", "8506", "7975", "8273", "8282"]},
    "sphinx-doc__sphinx-8713": ["jinja2<3.1", "markupsafe<2.1", "docutils<0.18", *SPHINX_OLD_PINS],  # 4.0
    "sphinx-doc__sphinx-10325": ["docutils<0.20"],  # 5.0
    "sphinx-doc__sphinx-10451": ["docutils<0.20"],  # 5.1
    # sympy 1.10/1.11 test helpers predate pytest 8.
    **{f"sympy__sympy-{n}": ["pytest==7.4.4"] for n in ["22840", "23262", "23191", "23117"]},
    # flask 2.0 era pins (2.3 keeps the repo-level werkzeug 2.3.8).
    "pallets__flask-4045": ["werkzeug==2.0.3", "jinja2==3.0.3", "markupsafe<2.1"],
}
PIP_INDEX = ["-i", "https://pypi.tuna.tsinghua.edu.cn/simple"]
# pylint 2.15's pyproject pins setuptools~=62.6, which crashes on py3.12
# (pkgutil.ImpImporter removed); build with the venv's modern setuptools instead.
NO_BUILD_ISOLATION = {"pylint-dev/pylint"}
# flask 2.0 on py3.12: pkgutil.get_loader DeprecationWarning is turned into an
# error by flask's own filterwarnings=ini; it is an environment artifact, not a
# regression. Command-line -W overrides the ini filter.
INSTANCE_PYTEST_ARGS = {"pallets__flask-4045": ["-W", "ignore::DeprecationWarning"]}
# Shallow fetches have no tags; setuptools-scm would fall back to 0.1.dev1,
# which trips pytest's own minversion check when running its test suite.
SCM_PRETEND = {"pytest-dev/pytest": "8.0.0"}

AGENT_SUFFIX = """

---
You are working in a checkout of {repo} at the commit where this issue was reported.
Fix the issue in this repository: inspect the code, make focused edits with apply_patch,
and verify with the shell tool (run a minimal reproduction or relevant existing tests).
Do not edit existing test files to force them to pass; fix the source code.
Environment: a prepared Python virtualenv with this repository installed (editable) plus
test dependencies lives at ../venv relative to the workspace root. Use ../venv/bin/python
to run tests, e.g. `../venv/bin/python -m pytest <test_file> -q`. Do not install packages
into the system Python.
When done, briefly summarize what you changed and what you verified.
"""


def sh(cmd, cwd=None, timeout=900, check=True, env=None):
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout, env=env)
    if check and proc.returncode != 0:
        raise RuntimeError(f"cmd failed: {cmd}\n{proc.stdout[-3000:]}\n{proc.stderr[-3000:]}")
    return proc


def load_instances(path=None):
    return json.loads((ROOT / "data" / (path or "selected_instances.json")).read_text())


def parse_tests(raw):
    return json.loads(raw) if isinstance(raw, str) else raw


def setup_repo(inst):
    iid = inst["instance_id"]
    base = RUNS / iid
    repo = base / "repo"
    if not (repo / ".git").exists():
        repo.mkdir(parents=True, exist_ok=True)
        sh(["git", "init", "-q"], cwd=repo)
        sh(["git", "remote", "add", "origin", REPO_URL[inst["repo"]]], cwd=repo)
        sh(["git", "fetch", "--depth", "1", "-q", "origin", inst["base_commit"]], cwd=repo, timeout=1200)
        sh(["git", "checkout", "-q", "FETCH_HEAD"], cwd=repo)
    venv = base / "venv"
    py = venv / "bin" / "python"
    if not py.exists():
        sh([sys.executable, "-m", "venv", str(venv)])
        sh([str(py), "-m", "pip", "install", "-q", "--upgrade", "pip", *PIP_INDEX], timeout=600)
        no_iso = inst["repo"] in NO_BUILD_ISOLATION
        if no_iso:
            sh([str(py), "-m", "pip", "install", "-q", "setuptools", "wheel", *PIP_INDEX], timeout=600)
        env = None
        if inst["repo"] in SCM_PRETEND:
            env = {**os.environ, "SETUPTOOLS_SCM_PRETEND_VERSION": SCM_PRETEND[inst["repo"]]}
        sh([str(py), "-m", "pip", "install", "-q", "-e", str(repo), *PIP_INDEX,
            *(["--no-build-isolation"] if no_iso else [])], cwd=repo, timeout=1200, env=env)
        if inst["repo"] != "pytest-dev/pytest":  # the pytest repo IS the installed pytest
            sh([str(py), "-m", "pip", "install", "-q", "pytest", *PIP_INDEX], timeout=600)
    # Idempotent: also applied to pre-existing venvs so pin fixes land on retry.
    for dep in EXTRA_DEPS.get(inst["repo"], []) + INSTANCE_DEPS.get(iid, []):
        sh([str(py), "-m", "pip", "install", "-q", dep, *PIP_INDEX], timeout=600)
    return base, repo, py


def locate_sympy_tests(repo, names):
    """Map bare sympy test function names to (file, name) pairs."""
    located = {}
    for name in names:
        proc = sh(["grep", "-rl", "--include=*.py", f"def {name}(", "sympy/"], cwd=repo, check=False)
        files = [f for f in proc.stdout.splitlines() if "/tests/" in f]
        if not files:
            files = proc.stdout.splitlines()
        if not files:
            raise RuntimeError(f"cannot locate sympy test {name}")
        located[name] = files[0]
    return located


def run_pytest(py, repo, targets, junit, timeout=900, extra=()):
    """targets: list of node ids, or (file, [names]) groups for sympy."""
    cmd = [str(py), "-m", "pytest", "-q", "--tb=short", "-p", "no:cacheprovider",
           f"--junitxml={junit}", *extra]
    for t in targets:
        if isinstance(t, tuple):
            file, names = t
            cmd += [file, "-k", " or ".join(names)]
        else:
            cmd.append(t)
    proc = sh(cmd, cwd=repo, timeout=timeout, check=False)
    results = {}
    if Path(junit).exists():
        for case in ET.parse(junit).getroot().iter("testcase"):
            key = case.get("classname", "") + "::" + case.get("name", "")
            failed = case.find("failure") is not None or case.find("error") is not None
            skipped = case.find("skipped") is not None
            results[key] = "failed" if failed else ("skipped" if skipped else "passed")
    return {"exit_code": proc.returncode, "tests": results,
            "tail": (proc.stdout[-2500:] + proc.stderr[-1500:])}


def build_targets(inst, repo, names):
    if inst["repo"] == "sympy/sympy":
        # Bare test names repeat across sympy; anchor on the file holding the
        # first FAIL_TO_PASS test instead of taking the first repo-wide grep hit.
        ftp = parse_tests(inst["FAIL_TO_PASS"])
        anchor = locate_sympy_tests(repo, [ftp[0]])[ftp[0]]
        located = {}
        for name in names:
            hit = sh(["grep", "-l", f"def {name}(", anchor], cwd=repo, check=False)
            located[name] = anchor if hit.returncode == 0 else locate_sympy_tests(repo, [name])[name]
        groups = {}
        for name in names:
            groups.setdefault(located[name], []).append(name)
        return [(f, ns) for f, ns in groups.items()]
    # Parameterized ids in the dataset may not match this pytest version's
    # formatting; run at function granularity (all params = stricter superset).
    seen, out = set(), []
    for node in names:
        base = node.split("[", 1)[0]
        if base not in seen:
            seen.add(base)
            out.append(base)
    return out


def base_key(junit_key):
    cls, _, name = junit_key.partition("::")
    return cls + "::" + name.split("[", 1)[0]


def restore_generated(inst, repo):
    # git clean -x removes setuptools-scm's gitignored _version.py; without it
    # the pytest repo cannot even be imported.
    if inst["repo"] == "pytest-dev/pytest":
        (repo / "src" / "_pytest" / "_version.py").write_text(
            "__version__ = version = '8.0.0'\n__version_tuple__ = version_tuple = (8, 0, 0)\n")


def judge(run):
    tests = run["tests"]
    # Skipped tests behave identically under the gold patch (markers/optional
    # deps); they are not regressions. Failed/error are.
    return bool(tests) and all(v in ("passed", "skipped") for v in tests.values())


def gold_check(inst, base, repo, py):
    # In-place: editable installs import from `repo`, so a patched copy would
    # not be exercised. Apply gold+test patch, run FTP, then restore base.
    sh(["git", "reset", "-q", "--hard", "HEAD"], cwd=repo)
    sh(["git", "clean", "-qfdx"], cwd=repo)
    restore_generated(inst, repo)
    (base / "gold.patch").write_text(inst["patch"])
    (base / "test.patch").write_text(inst["test_patch"])
    sh(["git", "apply", str(base / "gold.patch")], cwd=repo)
    sh(["git", "apply", str(base / "test.patch")], cwd=repo)
    ftp = parse_tests(inst["FAIL_TO_PASS"])
    extra = INSTANCE_PYTEST_ARGS.get(inst["instance_id"], [])
    out = run_pytest(py, repo, build_targets(inst, repo, ftp), base / "gold-junit.xml", extra=extra)
    p2p = parse_tests(inst["PASS_TO_PASS"])
    p2p_out = run_pytest(py, repo, build_targets(inst, repo, p2p), base / "gold-p2p-junit.xml", extra=extra) if p2p else {"tests": {}}
    # P2P tests that already fail under the gold patch in this environment
    # cannot discriminate agent behaviour; calibrate them out of the gate.
    env_excluded = sorted({base_key(k) for k, v in p2p_out["tests"].items() if v == "failed"})
    gated = {k: v for k, v in p2p_out["tests"].items() if base_key(k) not in env_excluded}
    sh(["git", "reset", "-q", "--hard", "HEAD"], cwd=repo)
    sh(["git", "clean", "-qfdx"], cwd=repo)
    restore_generated(inst, repo)
    return {"ftp_passed": judge(out),
            "p2p_passed": (bool(gated) and all(v in ("passed", "skipped") for v in gated.values())) if p2p else True,
            "ftp_count": len(out["tests"]), "p2p_count": len(p2p_out["tests"]),
            "env_excluded": env_excluded, "detail": out, "p2p_detail": p2p_out}


def extract_patch(inst, repo, dest):
    sh(["git", "add", "-A"], cwd=repo)
    proc = sh(["git", "diff", "--cached"], cwd=repo)
    dest.write_text(proc.stdout)
    sh(["git", "reset", "-q", "--hard", "HEAD"], cwd=repo)
    sh(["git", "clean", "-qfdx"], cwd=repo)
    restore_generated(inst, repo)
    return len(proc.stdout.splitlines())


def evaluate(inst, base, repo, py):
    iid = inst["instance_id"]
    patch_file = base / "model.patch"
    result = {"instance_id": iid, "repo": inst["repo"]}
    if not patch_file.exists() or not patch_file.read_text().strip():
        result.update(resolved=False, category="empty_patch")
        return result
    proc = sh(["git", "apply", str(patch_file)], cwd=repo, check=False)
    if proc.returncode != 0:
        result.update(resolved=False, category="patch_apply_failed", detail=proc.stderr[-1000:])
        return result
    proc = sh(["git", "apply", str(base / "test.patch")], cwd=repo, check=False)
    if proc.returncode != 0:
        result.update(resolved=False, category="test_patch_conflict", detail=proc.stderr[-1000:])
        return result
    ftp = parse_tests(inst["FAIL_TO_PASS"])
    p2p = parse_tests(inst["PASS_TO_PASS"])
    extra = INSTANCE_PYTEST_ARGS.get(iid, [])
    ftp_run = run_pytest(py, repo, build_targets(inst, repo, ftp), base / "ftp-junit.xml", extra=extra)
    p2p_run = run_pytest(py, repo, build_targets(inst, repo, p2p), base / "p2p-junit.xml", extra=extra) if p2p else {"tests": {}}
    gold = json.loads((base / "gold_check.json").read_text()) if (base / "gold_check.json").exists() else {}
    excluded = set(gold.get("env_excluded", []))
    p2p_gated = {k: v for k, v in p2p_run["tests"].items() if base_key(k) not in excluded}
    ftp_ok = judge(ftp_run)
    p2p_ok = (bool(p2p_gated) and all(v in ("passed", "skipped") for v in p2p_gated.values())) if p2p else True
    result.update(
        resolved=ftp_ok and p2p_ok,
        category="resolved" if (ftp_ok and p2p_ok) else ("ftp_failed" if not ftp_ok else "p2p_regression"),
        ftp=ftp_run, p2p=p2p_run, p2p_env_excluded=sorted(excluded),
    )
    sh(["git", "reset", "-q", "--hard", "HEAD"], cwd=repo)
    sh(["git", "clean", "-qfdx"], cwd=repo)
    restore_generated(inst, repo)
    return result


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["setup", "run", "all"], default="all")
    ap.add_argument("--only", help="instance_id filter")
    ap.add_argument("--run-tag", default="r2",
                    help="unique session suffix; reusing a session id would restore "
                         "the previous run's context and contaminate the measurement")
    ap.add_argument("--context-chars", type=int, default=None,
                    help="override the agent's default 120k context budget (sensitivity probes)")
    ap.add_argument("--instances", default=None,
                    help="instance list filename under data/ (default selected_instances.json)")
    ap.add_argument("--skip-existing", action="store_true",
                    help="skip instances that already have a results file")
    args = ap.parse_args()
    RESULTS.mkdir(parents=True, exist_ok=True)
    for inst in load_instances(args.instances):
        iid = inst["instance_id"]
        if args.only and args.only not in iid:
            continue
        if args.skip_existing and (RESULTS / f"swe_{iid}.json").exists():
            print(f"[{iid}] skipped: result exists", flush=True)
            continue
        try:
            run_instance(inst, args)
        except Exception as exc:  # one bad instance must not kill the batch
            print(f"[{iid}] SETUP/RUN ERROR: {exc}", flush=True)


def run_instance(inst, args):
    iid = inst["instance_id"]
    base, repo, py = setup_repo(inst)
    print(f"[{iid}] repo+venv ready", flush=True)
    if args.stage in ("setup", "all"):
        gold = gold_check(inst, base, repo, py)
        (base / "gold_check.json").write_text(json.dumps(gold, indent=1))
        ok = gold["ftp_passed"] and gold["p2p_passed"]
        print(f"[{iid}] gold self-check FTP({gold['ftp_count']})={gold['ftp_passed']} "
              f"P2P({gold['p2p_count']})={gold['p2p_passed']}", flush=True)
        if not ok:
            print(f"[{iid}] GOLD CHECK FAILED - inspect before agent run", flush=True)
    if args.stage in ("run", "all"):
        gold = json.loads((base / "gold_check.json").read_text()) if (base / "gold_check.json").exists() else None
        if gold and not (gold["ftp_passed"] and gold.get("p2p_passed", True)):
            print(f"[{iid}] skipped: gold check failed", flush=True)
            return
        message = inst["problem_statement"] + AGENT_SUFFIX.format(repo=inst["repo"])
        sh(["git", "reset", "-q", "--hard", "HEAD"], cwd=repo)
        sh(["git", "clean", "-qfdx"], cwd=repo)
        restore_generated(inst, repo)
        print(f"[{iid}] agent turn starting", flush=True)
        metrics = run_agent(message, cwd=repo, home=base / "home", session=f"{iid}-{args.run_tag}",
                            max_steps=40, turn_timeout_ms=1_200_000,
                            context_chars=args.context_chars,
                            log_path=base / "agent.jsonl")
        patch_lines = extract_patch(inst, repo, base / "model.patch")
        eval_result = evaluate(inst, base, repo, py)
        record = {**eval_result,
                  "run_tag": args.run_tag,
                  "context_chars": args.context_chars or 120000,
                  "gold_check_passed": (gold["ftp_passed"] and gold.get("p2p_passed", True)) if gold else None,
                  "patch_lines": patch_lines, "agent": {k: v for k, v in metrics.items() if k != "answer"},
                  "answer_excerpt": metrics["answer"][:800]}
        (RESULTS / f"swe_{iid}.json").write_text(json.dumps(record, indent=1, ensure_ascii=False))
        print(f"[{iid}] resolved={eval_result['resolved']} category={eval_result['category']} "
              f"steps={metrics['model_requests']} tools={metrics['tool_calls']} wall={metrics['wall_seconds']}s", flush=True)


if __name__ == "__main__":
    main()