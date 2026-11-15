"""Deterministic selection of the expanded 30-instance SWE-bench Lite subset.

Rule (documented in eval-plan.md §3.1):
  sympy   all post-2022 instances (py3.12-compatible), 9
  pytest  version 8.0 only (older pytest cannot run on py3.12), 2
  flask   all 3
  sphinx  11 smallest gold patches
  pylint  version >= 2.14 (2.13 pins a wrapt that cannot import on py3.12), 5
Total 30; superset of the original 5-instance subset.
"""
import json
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "selected_instances_30.json"


def main():
    df = pd.read_parquet(ROOT / "data" / "swe-bench-lite.parquet")
    df["patch_lines"] = df["patch"].str.count("\n")
    picked = []
    sy = df[(df["repo"] == "sympy/sympy") & (df["created_at"] >= "2022")]
    picked.append(sy)
    picked.append(df[(df["repo"] == "pytest-dev/pytest") & (df["version"] == "8.0")])
    picked.append(df[df["repo"] == "pallets/flask"])
    sphinx = df[df["repo"] == "sphinx-doc/sphinx"].sort_values(["patch_lines", "instance_id"])
    # 8435/8627: FTP tests fail under gold on py3.12 (typing.Any became a class;
    # type-alias resolution changed) — environment-incompatible, swapped out.
    sphinx = sphinx[~sphinx["instance_id"].isin(["sphinx-doc__sphinx-8435", "sphinx-doc__sphinx-8627"])]
    picked.append(sphinx.head(11))
    picked.append(df[(df["repo"] == "pylint-dev/pylint") & (df["version"] >= "2.14")])
    sel = pd.concat(picked).sort_values(["repo", "patch_lines", "instance_id"])
    assert len(sel) == 30, len(sel)
    assert sel["instance_id"].is_unique
    old = {i["instance_id"] for i in json.loads((ROOT / "data" / "selected_instances.json").read_text())}
    assert old <= set(sel["instance_id"]), old - set(sel["instance_id"])
    records = sel.drop(columns=["patch_lines"]).to_dict(orient="records")
    OUT.write_text(json.dumps(records, indent=1, ensure_ascii=False))
    print(f"wrote {OUT} ({len(records)} instances)")
    print(sel.groupby("repo").size().to_string())


if __name__ == "__main__":
    main()