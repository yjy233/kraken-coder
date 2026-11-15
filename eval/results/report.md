# kraken-coder 初步测评结果

被测：kraken-coder（reference 模式，full-auto）× Kimi `kimi-k3.1-pro`（compatible 协议）。
协议与偏差见 [eval-plan.md](../eval-plan.md)。样本为小 subset，分数不可与官方榜单直接比较。

## 1. SWE-bench Lite（13 实例子集）

| 实例 | 结果 | 分类 | gold 自检 | 补丁行数 | agent 开销 |
| --- | --- | --- | --- | --- | --- |
| pallets__flask-4045 | ❌ | ftp_failed | 通过 | 14 | 11 请求 / 34 工具（失败 2）/ 113.7s |
| pallets__flask-4992 | ❌ | empty_patch | 通过 | 0 | 18 请求 / 36 工具（失败 2）/ 232.5s |
| pallets__flask-5063 | ✅ resolved | resolved | 通过 | 114 | 35 请求 / 34 工具（失败 2）/ 398.1s |
| pylint-dev__pylint-6506 | ❌ | empty_patch | 通过 | 0 | 9 请求 / 25 工具（失败 0）/ 100.5s |
| pylint-dev__pylint-7080 | ❌ | empty_patch | 通过 | 0 | 6 请求 / 23 工具（失败 0）/ 40.5s |
| pylint-dev__pylint-7114 | ❌ | empty_patch | 通过 | 0 | 10 请求 / 30 工具（失败 0）/ 140.2s |
| pylint-dev__pylint-7228 | ❌ | empty_patch | 通过 | 0 | 6 请求 / 24 工具（失败 1）/ 53.6s |
| pylint-dev__pylint-7993 | ✅ resolved | resolved | 通过 | 60 | 25 请求 / 24 工具（失败 1）/ 205.5s |
| pytest-dev__pytest-11143 | ✅ resolved | resolved | 通过 | 30 | 15 请求 / 27 工具（失败 0）/ 151.5s |
| pytest-dev__pytest-11148 | ❌ | empty_patch | 通过 | 0 | 5 请求 / 15 工具（失败 0）/ 37.0s |
| sphinx-doc__sphinx-7738 | ❌ | empty_patch | 通过 | 0 | 15 请求 / 14 工具（失败 2）/ 58.1s |
| sympy__sympy-24102 | ❌ | ftp_failed | 通过 | 15 | 11 请求 / 23 工具（失败 2）/ 131.1s |
| sympy__sympy-24213 | ✅ resolved | resolved | 通过 | 13 | 19 请求 / 19 工具（失败 0）/ 97.0s |

**% Resolved = 4/13 = 31%**

按仓库：pallets/flask 1/3；pylint-dev/pylint 1/5；pytest-dev/pytest 1/2；sphinx-doc/sphinx 0/1；sympy/sympy 1/2

### 未解决：pallets__flask-4045
- FAIL_TO_PASS 未过：tests.test_blueprints::test_route_decorator_custom_endpoint_with_dots
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：pallets__flask-4992
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：pylint-dev__pylint-6506
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：pylint-dev__pylint-7080
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：pylint-dev__pylint-7114
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：pylint-dev__pylint-7228
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：pytest-dev__pytest-11148
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：sphinx-doc__sphinx-7738
- agent 错误：Context budget exceeded by current turn; read smaller ranges or increase --context-chars

### 未解决：sympy__sympy-24102
- FAIL_TO_PASS 未过：sympy.parsing.tests.test_mathematica::test_mathematica

## 2. Aider polyglot · Python 子集（33 题，≤2 次尝试）

| 练习 | 结果 | 尝试次数 | 各次尝试开销 |
| --- | --- | --- | --- |
| affine-cipher | ✅ pass | 1 | 6 请求 / 9 工具（失败 0）/ 54.9s |
| beer-song | ✅ pass | 1 | 9 请求 / 12 工具（失败 0）/ 64.1s |
| book-store | ✅ pass | 1 | 8 请求 / 11 工具（失败 0）/ 73.4s |
| bottle-song | ✅ pass | 1 | 9 请求 / 12 工具（失败 0）/ 57.8s |
| bowling | ✅ pass | 1 | 10 请求 / 9 工具（失败 0）/ 117.3s |
| connect | ✅ pass | 1 | 12 请求 / 11 工具（失败 0）/ 93.9s |
| dominoes | ✅ pass | 1 | 10 请求 / 12 工具（失败 0）/ 98.8s |
| dot-dsl | ✅ pass | 1 | 12 请求 / 11 工具（失败 0）/ 62.9s |
| food-chain | ✅ pass | 1 | 9 请求 / 12 工具（失败 0）/ 56.6s |
| forth | ✅ pass | 1 | 9 请求 / 12 工具（失败 0）/ 143.0s |
| go-counting | ✅ pass | 2 | 3 请求 / 6 工具（失败 0）/ 408.0s；8 请求 / 7 工具（失败 1）/ 88.3s |
| grade-school | ✅ pass | 1 | 11 请求 / 13 工具（失败 1）/ 43.8s |
| grep | ✅ pass | 1 | 8 请求 / 13 工具（失败 2）/ 56.3s |
| hangman | ✅ pass | 1 | 8 请求 / 11 工具（失败 0）/ 50.4s |
| list-ops | ✅ pass | 1 | 9 请求 / 11 工具（失败 0）/ 57.8s |
| paasio | ✅ pass | 1 | 10 请求 / 14 工具（失败 0）/ 119.6s |
| phone-number | ✅ pass | 1 | 10 请求 / 17 工具（失败 5）/ 82.7s |
| pig-latin | ✅ pass | 1 | 8 请求 / 11 工具（失败 0）/ 85.8s |
| poker | ✅ pass | 1 | 11 请求 / 13 工具（失败 1）/ 78.3s |
| pov | ✅ pass | 1 | 11 请求 / 14 工具（失败 2）/ 146.8s |
| proverb | ✅ pass | 1 | 6 请求 / 9 工具（失败 2）/ 36.5s |
| react | ✅ pass | 1 | 12 请求 / 20 工具（失败 5）/ 170.4s |
| rest-api | ✅ pass | 1 | 10 请求 / 17 工具（失败 5）/ 121.1s |
| robot-name | ✅ pass | 1 | 9 请求 / 16 工具（失败 5）/ 115.9s |
| scale-generator | ✅ pass | 1 | 8 请求 / 11 工具（失败 0）/ 82.7s |
| sgf-parsing | ✅ pass | 1 | 11 请求 / 16 工具（失败 3）/ 152.0s |
| simple-linked-list | ✅ pass | 1 | 10 请求 / 17 工具（失败 6）/ 70.2s |
| transpose | ✅ pass | 1 | 5 请求 / 6 工具（失败 0）/ 53.9s |
| tree-building | ✅ pass | 1 | 9 请求 / 12 工具（失败 0）/ 105.9s |
| two-bucket | ✅ pass | 1 | 8 请求 / 10 工具（失败 0）/ 87.7s |
| variable-length-quantity | ✅ pass | 1 | 13 请求 / 12 工具（失败 0）/ 107.6s |
| wordy | ✅ pass | 1 | 9 请求 / 11 工具（失败 0）/ 93.2s |
| zebra-puzzle | ✅ pass | 2 | 2 请求 / 1 工具（失败 0）/ 490.2s；7 请求 / 10 工具（失败 0）/ 135.2s |

**% Pass = 33/33 = 100%**（首次尝试即过：31）

## 3. 失败与限制分析

- pallets__flask-5063：16 个 P2P 测试在 gold 补丁下即失败（环境差异），已从判分门剔除：tests.test_cli::test_app_cli_has_app_context, tests.test_cli::test_appgroup_app_context, tests.test_cli::test_cli_blueprints, tests.test_cli::test_cli_empty, tests.test_cli::test_cli_name, tests.test_cli::test_find_best_app, tests.test_cli::test_flaskgroup_app_context, tests.test_cli::test_flaskgroup_debug, tests.test_cli::test_flaskgroup_nested, tests.test_cli::test_help_echo_exception, tests.test_cli::test_help_echo_loading_error, tests.test_cli::test_locate_app, tests.test_cli::test_locate_app_raises, tests.test_cli::test_no_command_echo_loading_error, tests.test_cli::test_scriptinfo, tests.test_cli::test_with_appcontext
- **上下文预算是主协议下的硬约束**：pallets__flask-4045, pallets__flask-4992, pylint-dev__pylint-6506, pylint-dev__pylint-7080, pylint-dev__pylint-7114, pylint-dev__pylint-7228, pytest-dev__pytest-11148, sphinx-doc__sphinx-7738 的回合以 `Context budget exceeded` 终止（默认 `--context-chars 120000`，L4 整轮裁剪）。大仓库 + 长 issue 描述会耗尽预算，回合中途终止、无补丁产出。但第 4 节探针表明放大预算并未救回这两个实例：预算只是约束之一，补丁质量与长上下文请求延迟同样导致失败。

## 4. 敏感性探针：放大上下文预算（首轮 5 实例实验，不计入主分数）

| 实例 | 预算（字符） | 结果 | 分类 | 开销 |
| --- | --- | --- | --- | --- |
| pallets__flask-4992 | 400000 | ❌ | ftp_failed | 11 请求 / 22 工具（失败 3）/ 144.7s |
| pytest-dev__pytest-11148 | 400000 | ❌ | empty_patch | 6 请求 / 17 工具（失败 0）/ 1066.6s |

探针不计入主分数：主协议固定为默认 `--context-chars 120000`。解读：
- flask-4992@400k：预算错误消失、回合完成，但补丁未过 FTP——瓶颈转为修复质量。注意 pilot 轮（不同轨迹）曾 resolved 同一实例，pass@1 轨迹方差显著。
- pytest-11148@400k：6 次请求耗时 1066s（约 178s/请求）超过 120s 单请求超时被中止——长上下文同时放大模型延迟，预算与超时需联动调整。
- 结论：默认预算确实是主协议失败模式的直接原因之一，但单纯放大预算不足以提升解决率；需要同时改进上下文裁剪策略、请求超时与修复质量。

## 5. 说明

- 主协议：默认 120k 字符上下文预算、reference 模式、full-auto、prepared venv 环境说明、每轮独立会话。
- 首轮 pilot（无环境说明、旧判分口径）存档于 `results/pilot/`，仅作过程对照，不计入主分数。
- 判分独立于 agent 自述：SWE 以 harness 重跑 FTP+P2P 为准，polyglot 以 harness 重跑 pytest 为准。
- 每任务完整 JSONL 轨迹在 `runs/` 下，可复查工具调用与补丁。
- 副作用披露：pilot 轮 flask agent 曾用系统 Python 自行安装 pytest 8.3.5 / Werkzeug 2.2.3 / itsdangerous 2.2.0（pyenv 3.12.11 默认环境）；正式轮已改用 prepared venv，未再污染。
- 本报告为子集结果；多模型对照与 Docker 官方环境复测见方案第 6 节。
