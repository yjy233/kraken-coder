# 黑盒 Eval 与测评结果

本目录包含当前配置模型的多步任务验收，以及通过公开 CLI 测得的历史 Kimi `kimi-k3.1-pro` 基准结果。

## 用当前模型验收一次多步任务

两次真实运行的对照、JSONL 复核和小时级任务的验收口径见[长任务运行验收](../docs/11-long-task-validation.md)。

仓库内有一个可重复的真实故障：执行输出很长的 shell 命令后，模型的下一次请求可能因上下文超限而失败。安装项目依赖并配置好根目录 `.env` 后，运行：

```bash
node --import tsx eval/harness/run_shell_context.mjs
```

脚本在 `eval/runs/` 中从固定提交生成干净副本，启动独立的本地 Agent Server，用当前模型和 learner 模式执行一次修复。每次运行都会产生真实模型调用。默认使用当前配置的步数上限（项目默认 16），外部观察时限为 15 分钟。测试客户端代答普通补丁和题面列出的测试命令。当前网页服务及其审批设置不参与实验。

终端打印本次产物目录。先看 `summary.json` 中的 `pass`、`status`、`failure`、`modelSteps`、`tools` 和 `seconds`。`deliveryOK` 要求回合正常收尾、独立验收全绿、新增的回归测试在原版失败且在候选版通过、原有测试与类型检查通过。`pass` 还会检查改动范围，允许实现源码、新回归测试，以及仓库协作说明指定的学习记录 `docs/08-learning-progress.md`。这份记录会单列在 `extraPaths`。

`before.log` 和 `after.log` 使用真实 shell 输出核对首尾、退出状态和预算，固定基线为 4 失败 / 4 通过。`journal.log` 在两种算法模式下经真实工具和离线模型适配器运行完整回合，分别核对发给模型的压缩输出和实际写入会话文件的原文。`project/` 保存候选补丁，`home/sessions/` 保留真实模型轨迹。复查已有实验不需要模型调用：

```bash
node --import tsx eval/harness/run_shell_context.mjs --grade-run eval/runs/shell-context-实际目录名
```

要对比步数限制，可以给运行脚本加 `--max-steps 48`，从干净副本独立重跑，再并列报告两次结果。这个案例测一次多步修复。要测半小时或一小时的工作，需另选该时长、具有外部验收的真实任务，并单列人工等待、超时和限流。

## 当前结果

结果来自 2026-11-15 的已有测量，2026-11-16 整理发布；本次发布没有重新调用模型。

| 基准 | 计划规模 | 已有有效结果 | 通过情况 |
| --- | --- | --- | --- |
| SWE-bench Lite 子集 | 30 实例 | 13 | 4/13 resolved，约 30.8% |
| Aider Polyglot Python 子集 | 34 题 | 33 | ≤2 次尝试 33/33 通过，首次尝试 31/33 |

运行因账户额度耗尽中断，17 个 SWE 实例和 Polyglot 的 `zipper` 尚未完成；对应 429 记录单独隔离。以上分数以有效结果为分母，不能当作全部计划任务的最终分数，也不能与官方榜单直接比较。SWE 判分还包含 gold 自检校准后的环境排除项，详见报告。

- [测评结果报告](results/report.md)：逐题结果、失败原因、环境排除与敏感性探针。
- [机器可读汇总](results/summary.json)：覆盖范围、缺失任务清单、通过率和运行开销。
- [测评方案](eval-plan.md)：选样、协议、判分方式、环境修复和续跑说明。
- `results/swe_*.json`：FTP/P2P 判分、环境排除、模型开销与回答摘要。
- `results/polyglot_*.json`：逐次尝试的独立测试结果、输出和模型开销。
- `results/pilot/`、`results/probe_*.json`、`results/quarantine_429/`：分别保存先导轮、上下文预算探针和额度失败，均不混入主分数。

历史测评没有记录精确的 Agent 提交号，不能承诺逐位复现模型轨迹。完整 JSONL、仓库克隆、venv 和上游 Exercism checkout 留在本地，不提交到 Git；此发布保留逐题结果和输出摘要。

## 离线复查

在仓库根目录运行，不访问模型：

```bash
python3 -m unittest discover -s eval/tests -v
python3 eval/harness/report.py
```

报告由已有 JSON 重新汇总，不会续跑缺失题目。

## 重新运行或续跑

使用 Node.js 24+、Python 3.12、Git。先构建 Agent，并在根目录 `.env` 配置 compatible 服务：

```bash
npm ci
npm run build
python3.12 -m venv eval/runs/harness-venv
. eval/runs/harness-venv/bin/activate
python -m pip install -r eval/requirements.txt
```

默认 CLI 和 `.env` 相对当前 checkout 定位，也可通过 `KRAKEN_EVAL_NODE`、`KRAKEN_EVAL_CLI`、`KRAKEN_EVAL_ENV_FILE` 指定。密钥不写入结果文件。

以下命令会下载仓库、创建任务环境，并在 `run` 阶段实际调用付费模型。续跑只补缺失结果，保持串行运行并使用新的 run-tag：

```bash
cd eval
python harness/select_instances.py
python harness/swebench_eval.py --stage setup --instances selected_instances_30.json
python harness/polyglot_eval.py --slugs-file data/polyglot_slugs_34.json --skip-existing --run-tag new-run
python harness/swebench_eval.py --stage run --instances selected_instances_30.json --skip-existing --run-tag new-run
python harness/report.py
```

网络代理需按自己的环境配置；方案中保留了原机器的配置作为历史说明，并非必需端口。
