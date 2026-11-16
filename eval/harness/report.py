"""Aggregate results/*.json into results/report.md."""
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RESULTS = ROOT / "results"


def build_summary():
    """Count primary results separately from probes, pilot runs and quota failures."""
    swe = [json.loads(p.read_text()) for p in sorted(RESULTS.glob("swe_*.json"))]
    poly = [json.loads(p.read_text()) for p in sorted(RESULTS.glob("polyglot_*.json"))]
    selected = json.loads((ROOT / "data" / "selected_instances_30.json").read_text())
    slugs = json.loads((ROOT / "data" / "polyglot_slugs_34.json").read_text())
    missing_swe = sorted({r["instance_id"] for r in selected} - {r["instance_id"] for r in swe})
    missing_poly = sorted(set(slugs) - {r["slug"] for r in poly})
    resolved = sum(bool(r.get("resolved")) for r in swe)
    passed = sum(bool(r.get("pass")) for r in poly)
    first_try = sum(bool(r.get("attempts") and r["attempts"][0].get("tests", {}).get("all_pass")) for r in poly)
    agents = [r.get("agent", {}) for r in swe] + [a.get("agent", {}) for r in poly for a in r.get("attempts", [])]
    return {
        "schema_version": 1,
        "status": "partial" if missing_swe or missing_poly else "complete",
        "model": "kimi-k3.1-pro",
        "provider": "compatible",
        "mode": "reference",
        "context_chars": 120000,
        "agent_revision_at_measurement": None,
        "provenance_note": "Historical measurements from the saved per-task JSON files; exact agent revision was not recorded. Publishing this report does not rerun the model.",
        "swebench_lite": {
            "planned": len(selected), "evaluated": len(swe), "resolved": resolved,
            "resolved_rate_on_evaluated": resolved / len(swe) if swe else None,
            "missing": missing_swe,
            "categories": dict(sorted(Counter(r.get("category", "unknown") for r in swe).items())),
            "p2p_environment_exclusions": {r["instance_id"]: r["p2p_env_excluded"] for r in swe if r.get("p2p_env_excluded")},
        },
        "polyglot_python": {
            "planned": len(slugs), "evaluated": len(poly), "passed_within_two_attempts": passed,
            "passed_on_first_attempt": first_try,
            "pass_rate_on_evaluated": passed / len(poly) if poly else None,
            "missing": missing_poly,
        },
        "excluded_from_primary_score": {
            "quota_failure_records": len(list((RESULTS / "quarantine_429").glob("*.json"))),
            "pilot_records": len(list((RESULTS / "pilot").glob("*.json"))),
            "sensitivity_probe_records": len(list(RESULTS.glob("probe_*.json"))),
        },
        "primary_attempt_totals": {
            "model_requests": sum(a.get("model_requests", 0) for a in agents),
            "tool_calls": sum(a.get("tool_calls", 0) for a in agents),
            "tool_failures": sum(a.get("tool_failures", 0) for a in agents),
            "wall_seconds_sum": round(sum(a.get("wall_seconds", 0) for a in agents), 1),
        },
    }


def fmt_agent(a):
    return (f"{a.get('model_requests', '?')} 请求 / {a.get('tool_calls', '?')} 工具"
            f"（失败 {a.get('tool_failures', '?')}）/ {a.get('wall_seconds', '?')}s")


def main():
    summary = build_summary()
    swe = sorted(RESULTS.glob("swe_*.json"))
    poly = sorted(RESULTS.glob("polyglot_*.json"))
    lines = ["# kraken-coder 初步测评结果", "",
             "被测：kraken-coder（reference 模式，full-auto）× Kimi `kimi-k3.1-pro`（compatible 协议）。",
             "协议与偏差见 [eval-plan.md](../eval-plan.md)。样本为小 subset，分数不可与官方榜单直接比较。", ""]
    coverage = summary["swebench_lite"], summary["polyglot_python"]
    lines += ["## 运行覆盖范围", "",
              f"- SWE-bench：已获得 {coverage[0]['evaluated']}/{coverage[0]['planned']} 个实例的有效结果。",
              f"- Polyglot Python：已获得 {coverage[1]['evaluated']}/{coverage[1]['planned']} 题的有效结果；待完成：{', '.join(coverage[1]['missing']) or '无'}。",
              "- 本轮因账户额度耗尽而中断。HTTP 429 记录保存在 [quarantine_429/](quarantine_429/)，不计入有效结果分母；未完成项不等同于模型答错。",
              "- 下列通过率仅针对已有有效结果；不是计划全集的最终分数。机器可读汇总见 [summary.json](summary.json)。", ""]

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
        rows.append(f"| [{r['instance_id']}]({f.name}) | {'✅ resolved' if r.get('resolved') else '❌'} "
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
        rows.append(f"| [{r['slug']}]({f.name}) | {'✅ pass' if r.get('pass') else '❌'} "
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
                         "- pytest-11148@400k：记录了 6 次请求、总耗时 1066.6s，并以请求超时中止。"
                         "这些汇总值不提供逐请求延迟，不能据此断言每次请求都耗时约 178s；预算、服务延迟与超时需要分别核查。",
                         "- 结论：默认预算确实是主协议失败模式的直接原因之一，但单纯放大预算不足以提升解决率；"
                         "需要同时改进上下文裁剪策略、请求超时与修复质量。", ""]
    else:
        lines += ["（未运行）", ""]

    lines += ["## 5. 说明", "",
              "- 主协议：默认 120k 字符上下文预算、reference 模式、full-auto、prepared venv 环境说明、每轮独立会话。",
              "- 首轮 pilot（无环境说明、旧判分口径）存档于 `results/pilot/`，仅作过程对照，不计入主分数。",
              "- 判分独立于 agent 自述：SWE 以 harness 重跑 FTP+P2P 为准，polyglot 以 harness 重跑 pytest 为准。",
              "- 本次发布包含逐题 JSON（上表可点击），保存请求/工具次数、测试结果和输出摘要；完整 JSONL、虚拟环境及工作区仅保留在本地 `runs/`，不随 Git 发布。",
              "- 历史测评未记录精确 agent 提交号；本次仅整理已有测量结果，没有重新调用模型。后续复测应记录 agent revision 与环境版本。",
              "- 副作用披露：pilot 轮 flask agent 曾用系统 Python 自行安装 pytest 8.3.5 / Werkzeug 2.2.3 / "
              "itsdangerous 2.2.0（pyenv 3.12.11 默认环境）；正式轮已改用 prepared venv，未再污染。",
              "- 本报告为子集结果；多模型对照与 Docker 官方环境复测见方案第 6 节。", ""]
    (RESULTS / "report.md").write_text("\n".join(lines))
    (RESULTS / "summary.json").write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n")
    print(f"report written: {RESULTS / 'report.md'} (swe={len(swe)}, polyglot={len(poly)})")


if __name__ == "__main__":
    main()
