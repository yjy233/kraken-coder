# kraken-coder 测评方案

测量日期：2026-11-15 · 发布整理：2026-11-16 · 状态：扩展测评因额度耗尽中断（计划 30 SWE 实例 + 34 polyglot 题）

## 1. 目标与约束

- **被测对象**：[kraken-coder](../README.md)（Codex 风格教学 coding agent，TypeScript/Node 24+）。
- **硬约束**：不修改 agent 任何实现代码。测评只通过其公开 CLI（`dist/cli.js exec`）以黑盒方式驱动；harness 位于仓库 `eval/` 子目录（纯新增，不触碰 agent 实现与任何现有文件），`eval/runs/` 等运行产物已 gitignore。
- **模型配置**：沿用项目 `.env` 的 compatible 协议（Kimi 中国站 `kimi-k3.1-pro`），这是项目文档中唯一完成过真实任务联调的配置。`--mode reference`（默认参考算法路径）、`--approval full-auto --allow-shell`（非交互测评必须全自动，否则审批会被自动拒绝）。
- **规模**：首轮 pilot 为 SWE-bench Lite 5 实例 + polyglot Python 8 题；扩展轮为 **SWE-bench Lite 30 实例 + polyglot Python 全部 34 题**（含首轮 5+8，协议一致，结果合并）。结论只作方向性参考，不能外推为完整榜单分数。

## 2. 基准选择

| 候选 | 知名度 | 适配性 | 结论 |
| --- | --- | --- | --- |
| **SWE-bench Lite** | coding agent 事实标准（Princeton，300 真实 GitHub issue） | 与 agent 的"读仓库→apply_patch→shell 跑测试"链路完全对应 | ✅ 选 1 |
| **Aider polyglot** | Aider 官方 leaderboard 基准，225 道 Exercism 难题、6 语言 | 考文件编辑+测试闭环，本地无需 Docker，Python 子集可直接跑 | ✅ 选 2 |
| Terminal-Bench 2.x | 知名终端 agent 基准 | 需要 x86 Docker 镜像群，本机 arm64 模拟成本高 | ❌ 留作扩展 |
| HumanEval / MBPP | 知名但面向函数级代码生成 | 不是 agent 式仓库任务，区分度低 | ❌ |

两者互补：SWE-bench 测**真实仓库缺陷定位与修复**（导航、上下文管理、验证闭环），polyglot 测**按规格实现+编辑格式+测试反馈下自我修正**。

## 3. 样本选择（确定性规则，可复现）

### 3.1 SWE-bench Lite（30/300）

数据：`princeton-nlp/SWE-bench_Lite` test split（`data/swe-bench-lite.parquet`，SHA-256 与 HF 官方逐字节一致：`7a21f37b…`）。

首轮 5 实例规则：只取纯 Python、可在本机 Python 3.12 直接 `pip install -e .` 的仓库（sympy / pytest / flask）；sympy 只取 2022 年后的实例；按 gold patch 行数升序取小任务。

扩展 30 实例规则（`harness/select_instances.py`，确定性可复现，清单 `data/selected_instances_30.json`）：

| 仓库 | 数量 | 规则 |
| --- | --- | --- |
| sympy/sympy | 9 | 全部 2022 年后实例（版本 1.10–1.13，py3.12 兼容） |
| pytest-dev/pytest | 2 | 仅版本 8.0（更老的 pytest 无法在 py3.12 运行） |
| pallets/flask | 3 | 全部 |
| sphinx-doc/sphinx | 11 | gold patch 行数最小的 11 个（8435/8627 的 FTP 测试在 py3.12 下 gold 即失败——`typing.Any` 变为类、类型别名解析变化——换出，由 8282/10451 递补） |
| pylint-dev/pylint | 5 | 版本 ≥2.14（2.13 钉的 wrapt 在 py3.12 无法导入，gold 自检暴露后换出） |

排除 django（测试用自家 runner 而非 pytest，harness 不适配）、matplotlib/scikit-learn/astropy（C 扩展编译成本高）、requests（P2P 依赖 httpbin 网络夹具）、xarray/seaborn（numpy 栈钉版成本高，留作后续扩展）。30 实例为首轮 5 实例的超集。

### 3.2 Aider polyglot · Python 全集（34/34）

题源：`Aider-AI/polyglot-benchmark` 仓库 python/exercises/practice（官方 34 题清单存 `data/polyglot_slugs_34.json`），练习文件取自 `exercism/python`。首轮 8 题按字母序每隔 4 题取样；扩展轮跑全部 34 题，首轮 8 题结果直接复用（协议一致）。每题运行前用 `.meta/example.py` 参考解做环境自检（34/34 通过），参考解不进入 agent 工作区。

## 4. 运行协议

### 4.1 统一调用

```bash
node dist/cli.js exec \
  --provider compatible --mode reference --approval full-auto --allow-shell \
  --cwd <任务工作区> --home <运行数据目录> --session <id> \
  --message <任务> --json \
  --max-steps 40 --turn-timeout-ms 1200000 --request-timeout-ms 120000 \
  --env-file .env
```

- 每任务独立 `--home`（会话 JSONL 隔离）、独立工作区；venv 放在仓库目录之外，避免污染 git diff。
- **会话 ID 必须每轮唯一**（`<instance>-<run-tag>`）：kraken-coder 的 L5 会话恢复会复用同 ID 的历史上下文，重测若沿用旧 ID，agent 会"记得"上一轮的答案，测量被污染。首轮 pilot 与正式轮因此使用不同 session。
- 从 stdout JSONL 采集指标：`model.start` 计数=模型请求数，`tool.start`/`tool.end(ok)`=工具调用与失败数，`turn.completed.answer`=最终答复，另记 wall time 与退出码。

### 4.2 SWE-bench 流程（每实例）

1. **环境**：`git fetch --depth 1 origin <base_commit>` 取仓库快照 → 独立 venv `pip install -e .`。
2. **Gold 自检**：在副本上应用 gold patch + test_patch，跑 FAIL_TO_PASS。通过才证明环境可信；失败则先修环境，不浪费模型调用。
3. **Agent 求解**：干净 base_commit 工作区，消息=problem_statement 原文+固定收尾指令+一行prepared环境说明（`../venv` 已装好仓库与测试依赖，用 `../venv/bin/python` 跑测试）。**不给** test_patch、gold patch、hints_text、FTP 测试名（防泄漏）。环境说明对齐官方 harness"环境已备好"的语义，避免把"自行 bootstrap Python 环境"的噪声计入 bug 修复能力（首轮无此说明的轨迹保留在 `results/pilot/` 作对照）。
4. **补丁提取**：`git add -A && git diff --cached`（含新增文件）。
5. **判分**：重置到 base → 应用 agent 补丁 → 应用 test_patch → 跑 FAIL_TO_PASS 与 PASS_TO_PASS。**resolved = 经下文环境校准后的两组门均通过**；采用 FTP/P2P 框架，但不等同于官方容器及逐参数判分。空补丁/应用失败直接计未解决。
6. sympy 的测试名是裸函数名：先 grep 定位测试文件，用 pytest 按函数名过滤执行。
7. **环境钉版（gold 自检暴露后修复）**：flask 需 `werkzeug==2.3.8`（新版删除 `url_quote`）与 `pytest==7.4.4`（conftest 用 `monkeypatch.notset`）；flask 2.0 实例（4045）另钉 `werkzeug==2.0.3 / jinja2==3.0.3 / markupsafe<2.1`。pytest 仓库浅克隆无 tag，需 `SETUPTOOLS_SCM_PRETEND_VERSION=8.0.0` 否则触发自身 minversion 检查；pytest 仓库的 venv 不另装发行版 pytest（仓库本身即被测包）。sphinx 3.x 钉 `jinja2<3.1 / markupsafe<2.1 / docutils==0.16`，4.0 钉 `docutils<0.18`，5.0 钉 `docutils<0.20`，测试统一 `pytest==7.4.4 + html5lib`；pylint 测试需 `pytest==7.4.4 / pytest-benchmark==4.0.0 / pytest-timeout / coverage`；sympy 1.10/1.11 钉 `pytest==7.4.4`（测试助手早于 pytest 8）。gold 自检在**原仓库目录内**应用补丁（editable 安装指向原目录，副本不会被导入），跑完重置回 base。
8. **判分环境二次修复（首轮测评暴露）**：`git clean -x` 会删掉 pytest 仓库 gitignore 的生成文件 `src/_pytest/_version.py`，导致仓库无法导入、agent 跑测试与判分全部失真——每次 clean 后必须重建该文件，受影响的 pytest 实例需重跑。sympy 裸测试名在全仓库重复出现，P2P 定位改为**锚定 FAIL_TO_PASS 所在测试文件**，避免 grep 首个命中落到错误文件（首轮 sympy-24213 的 31 个 P2P 只跑到 2 个）。gold 自检升级为 FTP+P2P 双门。
9. **判分口径校准**：(a) 数据集中参数化测试 ID 与本机 pytest 版本的格式化不一致，P2P 改按**函数粒度**执行（含全部参数化变体，比官方逐参数列表更严）；(b) gold 补丁下仍失败的 P2P 测试属环境差异（py3.12/新 setuptools），记入 `env_excluded` 并从判分门中剔除，报告中明示；(c) skipped 与 gold 行为一致，不计回归；(d) 空 P2P 列表视为通过。

### 4.3 polyglot 流程（每题，Aider 两次尝试协议）

1. 任务目录只放：`instructions.md`、`<slug>.py` 桩、`<slug>_test.py`。**剔除 `.meta/example.py` 参考解**，防止 agent 用 shell 偷看答案。
2. 尝试 1：消息=题目说明+"实现桩文件使测试通过，可运行 pytest，不得改测试文件"。结束后 harness 独立跑 pytest。
3. 若失败 → 尝试 2：同一 session 续跑，消息附上次测试输出（截断 4000 字符），模拟 Aider 的测试反馈重试。
4. **pass = 任一次尝试后测试全绿**；同时记录尝试 1 通过率。

## 5. 指标

- 主指标：SWE-bench **% Resolved**（30 实例）、polyglot **% Pass after ≤2 attempts**（34 题）。
- 过程指标：每任务模型请求数、工具调用数/失败数、wall time、补丁行数、最终答复摘要。
- 失败分类：环境失败 / agent 报错或超时 / 空补丁 / 补丁应用失败 / FTP 未过 / P2P 回归 / 测试未过（polyglot）。

## 6. 与官方协议的偏差（效度威胁）

1. **子集而非全集**：30/300 与 34/225（polyglot 官方 6 语言），且 SWE 子集偏向小补丁、纯 Python 仓库，分数不能与官方榜单直接比较。
2. **无 Docker 官方镜像**：手工 venv + Python 3.12（官方按实例钉版本），环境差异可能影响个别测试；gold 自检用于兜底。
3. **单轨迹测量**：SWE 每实例一次求解，polyglot 按协议最多两次尝试；没有多次独立采样，温度/随机性未控制。
4. **polyglot 仅 Python**：官方 6 语言 225 题，这里测 Python 全部 34 题；两次尝试协议保留，但反馈格式与 Aider 原版 prompt 不完全一致。
5. **harness 本身未校准**：kraken-coder 是教学项目，上下文窗口 120k 字符、整轮裁剪，大仓库任务可能因上下文不足失败——这属于被测系统能力，不是测评 bug。
6. 模型为单一 `kimi-k3.1-pro`，结果反映"agent 框架 × 该模型"的组合，不能单独归因于任一方。

## 7. 复现

```bash
cd eval
python3 harness/select_instances.py                  # 生成 30 实例清单（确定性）
python3 harness/swebench_eval.py --stage setup --instances selected_instances_30.json
python3 harness/swebench_eval.py --stage run --instances selected_instances_30.json --run-tag r3
python3 harness/polyglot_eval.py --slugs-file data/polyglot_slugs_34.json --skip-existing
python3 harness/report.py                            # 汇总 results/ → results/report.md
```

网络：GitHub/HF 需走代理（本机 Clash Verge 混合端口 127.0.0.1:7897）。harness 用 `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.https://github.com.proxy GIT_CONFIG_VALUE_0=http://127.0.0.1:7897` 只代理 GitHub；pip 直连 tuna 镜像（不要给 pip 设代理环境变量）。

## 8. 预算与停止条件

- 每任务上限：SWE 40 步 / 20 分钟，polyglot 24 步 / 8 分钟；单请求超时 120s。
- 任一任务 agent 进程崩溃或 API 连续鉴权失败 → 记录后继续下一任务；gold 自检失败 → 暂停该实例并报告。
- 预计总时长 30–60 分钟，模型请求约 200–400 次。

### 8.1 扩展轮中断事件（2026-11-15）与续跑

扩展轮 SWE 与 polyglot 两批并发运行期间，Kimi 账户余额耗尽，API 返回 429
（`exceeded_current_quota_error`，账户 suspended）。agent 只暴露 `Provider HTTP 429`，
harness 已加 120s 冷却 ×2 次重试（ fresh session 后缀 `-r429N`，避免 L5 恢复被中止的回合），
但余额耗尽属持久性 429，重试无效。处置：

- 受污染结果（agent_error 含 429）移入 `results/quarantine_429/` 存档，不计入分数：
  SWE 17 实例（sphinx 10 + sympy 7）+ polyglot zipper。真实结果保留：SWE 13 实例、polyglot 33 题。
- 并发是诱因之一，但根因是余额；续跑必须**串行**（先 polyglot 后 SWE），避免再触顶。
- 充值后续跑（gold 自检与 venv 均已就绪，`--skip-existing` 只补缺失结果，新 run-tag 保证会话独立）：

```bash
cd eval
python3 harness/polyglot_eval.py --slugs-file data/polyglot_slugs_34.json --skip-existing --run-tag r4
python3 harness/swebench_eval.py --stage run --instances selected_instances_30.json --skip-existing --run-tag r4
python3 harness/report.py
```

## 9. 敏感性探针（不计入主分数）

主协议固定默认 `--context-chars 120000`。对因 `Context budget exceeded` 失败的实例，用 `harness/probe.py <iid> 400000` 以约 3.33 倍预算重跑一次（独立会话、归档并恢复主产物），结果存 `results/probe_*.json`。用途：区分"默认预算是瓶颈"与"模型修复能力不足"。探针只改预算一个变量，其余协议不变。

2026-11-16 的发布整理仅补充结果覆盖范围、报告导航与路径可移植性，未重跑模型，也未修改 Agent 实现。当前有效结果为 SWE 13/30（resolved 4）、polyglot 33/34（≤2 次尝试通过 33，首次通过 31）；余下任务见 `results/summary.json`。harness 的原始硬编码路径已改为相对 checkout 定位，保留环境变量覆盖方式。历史测量没有记录精确 Agent 提交号。
