"""Black-box driver for kraken-coder: invokes the built CLI, parses JSONL metrics.

Does not import or modify any agent code.
"""
import json
import subprocess
import time
from pathlib import Path

NODE = "node"
CLI = "/Users/bill/code/kraken-coder/dist/cli.js"
ENV_FILE = "/Users/bill/code/kraken-coder/.env"


def run_agent(message, cwd, home, session, *, max_steps=40,
              turn_timeout_ms=1_200_000, request_timeout_ms=120_000,
              context_chars=None, log_path=None):
    # Provider 429 is an infra error, not agent behaviour: cool down and retry
    # with a fresh session (same id would L5-restore the aborted turn).
    for attempt in range(3):
        sess = session if attempt == 0 else f"{session}-r429{attempt}"
        metrics = _run_once(message, cwd, home, sess, max_steps=max_steps,
                            turn_timeout_ms=turn_timeout_ms,
                            request_timeout_ms=request_timeout_ms,
                            context_chars=context_chars, log_path=log_path)
        if "429" not in (metrics.get("agent_error") or ""):
            return metrics
        if attempt < 2:
            print(f"  [429] rate limited; cooling down 120s before retry {attempt + 1}", flush=True)
            time.sleep(120)
    return metrics


def _run_once(message, cwd, home, session, *, max_steps=40,
              turn_timeout_ms=1_200_000, request_timeout_ms=120_000,
              context_chars=None, log_path=None):
    cwd, home = Path(cwd), Path(home)
    home.mkdir(parents=True, exist_ok=True)
    cmd = [
        NODE, CLI, "exec",
        "--provider", "compatible", "--mode", "reference",
        "--approval", "full-auto", "--allow-shell",
        "--cwd", str(cwd), "--home", str(home), "--session", session,
        "--message", message, "--json",
        "--max-steps", str(max_steps),
        "--turn-timeout-ms", str(turn_timeout_ms),
        "--request-timeout-ms", str(request_timeout_ms),
        "--env-file", ENV_FILE,
    ]
    if context_chars:
        cmd += ["--context-chars", str(context_chars)]
    t0 = time.time()
    error = None
    try:
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            timeout=turn_timeout_ms / 1000 + 180, cwd=str(cwd),
        )
        stdout, stderr, exit_code = proc.stdout, proc.stderr, proc.returncode
    except subprocess.TimeoutExpired as exc:
        stdout = (exc.stdout or b"").decode() if isinstance(exc.stdout, bytes) else (exc.stdout or "")
        stderr = (exc.stderr or b"").decode() if isinstance(exc.stderr, bytes) else (exc.stderr or "")
        exit_code, error = -1, "harness_timeout"
    wall = round(time.time() - t0, 1)

    events = []
    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            pass

    answer, failure = "", None
    for ev in events:
        if ev.get("type") == "turn.completed":
            answer = ev.get("answer", "")
        elif ev.get("type") in ("turn.failed", "turn.cancelled"):
            failure = ev.get("error", ev["type"])
    tool_ends = [ev for ev in events if ev.get("type") == "tool.end"]
    metrics = {
        "model_requests": sum(1 for ev in events if ev.get("type") == "model.start"),
        "tool_calls": sum(1 for ev in events if ev.get("type") == "tool.start"),
        "tool_failures": sum(1 for ev in tool_ends if ev.get("ok") is False),
        "wall_seconds": wall,
        "exit_code": exit_code,
        "agent_error": error or failure,
        "answer": answer,
    }
    if log_path:
        log_path = Path(log_path)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(stdout)
        log_path.with_suffix(".stderr").write_text(stderr)
        (log_path.parent / (log_path.stem + ".cmd.json")).write_text(
            json.dumps({"cmd": cmd, "metrics": metrics}, indent=1, ensure_ascii=False))
    return metrics