#!/usr/bin/env python3
"""
用 mir_eval.melody 给评测结果打分，输出 markdown 表格与 summary.json。

目录约定（eval.ts 产出）：
  <results>/<song>/<variant>.csv         time,f0   流水线逐帧输出（f0=0 表示无声）
  <results>/<song>/<variant>.notes.csv   time,f0   把输出的音符按 10 ms 栅格渲染成 f0 序列
参考：~/voice-pro-eval-data/prepared/<song>/ref.csv

用法：~/voice-pro-eval-venv/bin/python scripts/eval/score.py <results 目录> [--notes]
"""
import json
import os
import sys
from pathlib import Path

import mir_eval
import numpy as np

DATA = Path(os.environ.get("EVAL_DATA", Path.home() / "voice-pro-eval-data"))
METRICS = [
    ("Raw Pitch Accuracy", "RPA"),
    ("Raw Chroma Accuracy", "RCA"),
    ("Voicing Recall", "VR"),
    ("Voicing False Alarm", "VFA"),
    ("Overall Accuracy", "OA"),
]


def read_csv(path: Path):
    arr = np.loadtxt(path, delimiter=",", ndmin=2)
    return arr[:, 0], arr[:, 1]


def diagnose(rt, rf, et, ef) -> dict:
    """参考有声帧的去向：漏检 / 音高对 / 高八度 / 低八度 / 其他错音；以及误报占全部帧的比例。"""
    ref_v, ref_c, est_v, est_c = mir_eval.melody.to_cent_voicing(rt, rf, et, ef)[:4]
    ref_v = ref_v.astype(bool)
    est_v = est_v.astype(bool)
    n_ref = max(1, int(ref_v.sum()))
    both = ref_v & est_v
    err = est_c[both] - ref_c[both]
    ok = np.abs(err) <= 50
    up = np.abs(err - 1200) <= 50
    down = np.abs(err + 1200) <= 50
    up2 = np.abs(err - 2400) <= 50
    down2 = np.abs(err + 2400) <= 50
    other = ~(ok | up | down | up2 | down2)
    return {
        "miss": float((ref_v & ~est_v).sum() / n_ref),
        "ok": float(ok.sum() / n_ref),
        "oct_up": float((up | up2).sum() / n_ref),
        "oct_down": float((down | down2).sum() / n_ref),
        "other_err": float(other.sum() / n_ref),
        "fa_of_all": float((~ref_v & est_v).sum() / max(1, len(ref_v))),
    }


def evaluate(ref_path: Path, est_path: Path, diag: bool = False) -> dict:
    rt, rf = read_csv(ref_path)
    et, ef = read_csv(est_path)
    scores = mir_eval.melody.evaluate(rt, rf, et, ef)
    out = {short: float(scores[full]) for full, short in METRICS}
    if diag:
        out.update({f"d_{k}": v for k, v in diagnose(rt, rf, et, ef).items()})
    return out


def main() -> None:
    results = Path(sys.argv[1])
    with_notes = "--notes" in sys.argv
    songs = sorted(p.name for p in results.iterdir() if p.is_dir())
    variants: list[str] = []
    for s in songs:
        for f in sorted((results / s).glob("*.csv")):
            if f.name.endswith(".notes.csv"):
                continue
            v = f.stem
            if v not in variants:
                variants.append(v)

    summary: dict = {"songs": {}, "mean": {}}
    for s in songs:
        ref = DATA / "prepared" / s / "ref.csv"
        summary["songs"][s] = {}
        for v in variants:
            est = results / s / f"{v}.csv"
            if not est.exists():
                continue
            r = evaluate(ref, est, diag=True)
            notes = results / s / f"{v}.notes.csv"
            if notes.exists():
                n = evaluate(ref, notes)
                r["notes_RPA"], r["notes_OA"] = n["RPA"], n["OA"]
            summary["songs"][s][v] = r

    for v in variants:
        rows = [summary["songs"][s][v] for s in songs if v in summary["songs"][s]]
        if rows:
            summary["mean"][v] = {k: float(np.mean([r[k] for r in rows])) for k in rows[0]}
            summary["mean"][v]["n"] = len(rows)

    (results / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))

    cols = [short for _, short in METRICS]
    if "--diag" in sys.argv:
        dcols = ["d_miss", "d_ok", "d_oct_up", "d_oct_down", "d_other_err", "d_fa_of_all"]
        for v in variants:
            print(f"\n### 诊断 {v}（占参考有声帧的比例；FA 占全部帧）\n")
            print("| 歌曲 | 漏检 | 音高对 | 高八度 | 低八度 | 其他错音 | 误报(占全部帧) |")
            print("|---|---:|---:|---:|---:|---:|---:|")
            for s in songs:
                r = summary["songs"][s].get(v)
                if r:
                    print(f"| {s} | " + " | ".join(f"{r[c] * 100:.1f}" for c in dcols) + " |")
            rows = [summary["songs"][s][v] for s in songs if v in summary["songs"][s]]
            if rows:
                print("| **平均** | " + " | ".join(f"**{np.mean([r[c] for r in rows]) * 100:.1f}**" for c in dcols) + " |")
    for v in variants:
        print(f"\n### {v}\n")
        extra = ["notes_RPA", "notes_OA"] if with_notes else []
        print("| 歌曲 | " + " | ".join(cols + extra) + " |")
        print("|---|" + "---:|" * (len(cols) + len(extra)))
        for s in songs:
            r = summary["songs"][s].get(v)
            if not r:
                continue
            print(f"| {s} | " + " | ".join(f"{r[c] * 100:.1f}" for c in cols + extra if c in r) + " |")
        m = summary["mean"].get(v)
        if m:
            print("| **平均** | " + " | ".join(f"**{m[c] * 100:.1f}**" for c in cols + extra if c in m) + " |")


if __name__ == "__main__":
    main()
