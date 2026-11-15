"""Aggregate results/*.json into results/report.md."""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"


def fmt_agent(a):
    return (f"{a.get('model_requests', '?')} 请求 / {a.get('tool_calls', '?')} 工具"
            f"（失败 {a.get('tool_failures', '?')}）/ {a.get('wall_seconds', '?')}s")


def main():
    swe = sorted(RESULTS.glob("swe_*.json"))
    poly = sorted(RESULTS.glob("polyglot_*.json"))
    lines = ["# kraken-coder 初步测评结果", "",
             "被测：kraken-coder（reference 模式，full-auto）× Kimi `kimi-k3.1-pro`（compatible 协议）。",
             "协议与偏差见 [eval-plan.md](../eval-plan.md)。样本为小 subset，分数不可与官方榜单直接比较。", ""]

    lines += [f"## 1. SWE-bench Lite（{len(swe)} 实例子集）", ""]
    resolved = 0
    by_repo = {}
    rows = ["| 实例 | 结果 | 分类 | gold 自检 | 补丁行数 | agent 开销 |",
            "| --- | --- | --- | --- | --- | --- |"]
    for f in swe:
        r = json.loads(f.read_text())
        resolved += bool(r.get("resolved"))
        repo = r.get("repo", "?")
        agg = by_repo.setdefault(repo, [0, 0])
        agg[0] += bool(r.get("resolved"))
        agg[1] += 1
        rows.append(f"| {r['instance_id']} | {'✅ resolved' if r.get('resolved') else '❌'} "
                    f"| {r.get('category', '?')} | {'通过' if r.get('gold_check_passed') else '未过/未做'} "
                    f"| {r.get('patch_lines', '?')} | {fmt_agent(r.get('agent', {}))} |")
    lines += rows + ["", f"**% Resolved = {resolved}/{len(swe)}"
                     + (f" = {resolved / len(swe):.0%}" if swe else "") + "**", ""]
    if len(by_repo) > 1:
        lines += ["按仓库：" + "；".join(f"{repo} {ok}/{n}" for repo, (ok, n) in sorted(by_repo.items())), ""]
    for f in swe:
        r = json.loads(f.read_text())
        if r.get("resolved"):
            continue
        lines.append(f"### 未解决：{r['instance_id']}")
        ftp = r.get("ftp", {}).get("tests", {})
        bad = [k for k, v in ftp.items() if v != "passed"]
        if bad:
            lines.append(f"- FAIL_TO_PASS 未过：{', '.join(bad[:6])}")
        p2p = r.get("p2p", {}).get("tests", {})
        badp = [k for k, v in p2p.items() if v != "passed"]
        if badp:
            lines.append(f"- PASS_TO_PASS 回归：{len(badp)} 个，如 {', '.join(badp[:4])}")
        if r.get("agent", {}).get("agent_error"):
            lines.append(f"- agent 错误：{r['agent']['agent_error']}")
        lines.append("")

    lines += [f"## 2. Aider polyglot · Python 子集（{len(poly)} 题，≤2 次尝试）", ""]
    passed = first_try = 0
    rows = ["| 练习 | 结果 | 尝试次数 | 各次尝试开销 |", "| --- | --- | --- | --- |"]
    for f in poly:
        r = json.loads(f.read_text())
        passed += bool(r.get("pass"))
        first_try += bool(r.get("pass") and r.get("attempts_used") == 1)
        costs = "；".join(fmt_agent(a["agent"]) for a in r.get("attempts", []))
        rows.append(f"| {r['slug']} | {'✅ pass' if r.get('pass') else '❌'} "
                    f"| {r.get('attempts_used', '?')} | {costs} |")
    lines += rows + ["", f"**% Pass = {passed}/{len(poly)}"
                     + (f" = {passed / len(poly):.0%}" if poly else "")
                     + f"**（首次尝试即过：{first_try}）", ""]
    for f in poly:
        r = json.loads(f.read_text())
        if r.get("pass"):
            continue
        last = r.get("attempts", [])[-1] if r.get("attempts") else {}
        lines.append(f"### 未通过：{r['slug']}")
        lines.append(f"- 最终测试：{last.get('tests', {})}")
        lines.append(f"- 输出尾部：`{last.get('test_output_tail', '')[-300:]}`")
        lines.append("")

    lines += ["## 3. 失败与限制分析", ""]
    ctx_budget, other_errors = [], []
    for f in swe:
        r = json.loads(f.read_text())
        err = r.get("agent", {}).get("agent_error") or ""
        if "Context budget" in err:
            ctx_budget.append(r["instance_id"])
        elif err:
            other_errors.append((r["instance_id"], err))
        if r.get("p2p_env_excluded"):
            lines.append(f"- {r['instance_id']}：{len(r['p2p_env_excluded'])} 个 P2P 测试在 gold 补丁下即失败"
                         f"（环境差异），已从判分门剔除：{', '.join(r['p2p_env_excluded'])}")
    if ctx_budget:
        lines.append(f"- **上下文预算是主协议下的硬约束**：{', '.join(ctx_budget)} 的回合以 "
                     "`Context budget exceeded` 终止（默认 `--context-chars 120000`，L4 整轮裁剪）。"
                     "大仓库 + 长 issue 描述会耗尽预算，回合中途终止、无补丁产出。"
                     "但第 4 节探针表明放大预算并未救回这两个实例：预算只是约束之一，"
                     "补丁质量与长上下文请求延迟同样导致失败。")
    for iid, err in other_errors:
        lines.append(f"- {iid}：agent 错误 `{err}`")
    lines.append("")

    lines += ["## 4. 敏感性探针：放大上下文预算（首轮 5 实例实验，不计入主分数）", ""]
    probes = sorted(RESULTS.glob("probe_*.json"))
    if probes:
        rows = ["| 实例 | 预算（字符） | 结果 | 分类 | 开销 |", "| --- | --- | --- | --- | --- |"]
        for f in probes:
            r = json.loads(f.read_text())
            rows.append(f"| {r['instance_id']} | {r.get('context_chars', '?')} "
                        f"| {'✅ resolved' if r.get('resolved') else '❌'} | {r.get('category', '?')} "
                        f"| {fmt_agent(r.get('agent', {}))} |")
        lines += rows + ["",
                         "探针不计入主分数：主协议固定为默认 `--context-chars 120000`。解读：",
                         "- flask-4992@400k：预算错误消失、回合完成，但补丁未过 FTP——瓶颈转为修复质量。"
                         "注意 pilot 轮（不同轨迹）曾 resolved 同一实例，pass@1 轨迹方差显著。",
                         "- pytest-11148@400k：6 次请求耗时 1066s（约 178s/请求）超过 120s 单请求超时被中止——"
                         "长上下文同时放大模型延迟，预算与超时需联动调整。",
                         "- 结论：默认预算确实是主协议失败模式的直接原因之一，但单纯放大预算不足以提升解决率；"
                         "需要同时改进上下文裁剪策略、请求超时与修复质量。", ""]
    else:
        lines += ["（未运行）", ""]

    lines += ["## 5. 说明", "",
              "- 主协议：默认 120k 字符上下文预算、reference 模式、full-auto、prepared venv 环境说明、每轮独立会话。",
              "- 首轮 pilot（无环境说明、旧判分口径）存档于 `results/pilot/`，仅作过程对照，不计入主分数。",
              "- 判分独立于 agent 自述：SWE 以 harness 重跑 FTP+P2P 为准，polyglot 以 harness 重跑 pytest 为准。",
              "- 每任务完整 JSONL 轨迹在 `runs/` 下，可复查工具调用与补丁。",
              "- 副作用披露：pilot 轮 flask agent 曾用系统 Python 自行安装 pytest 8.3.5 / Werkzeug 2.2.3 / "
              "itsdangerous 2.2.0（pyenv 3.12.11 默认环境）；正式轮已改用 prepared venv，未再污染。",
              "- 本报告为子集结果；多模型对照与 Docker 官方环境复测见方案第 6 节。", ""]
    (RESULTS / "report.md").write_text("\n".join(lines))
    print(f"report written: {RESULTS / 'report.md'} (swe={len(swe)}, polyglot={len(poly)})")


if __name__ == "__main__":
    main()