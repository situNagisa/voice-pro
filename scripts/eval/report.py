#!/usr/bin/env python3
"""
把两次评测结果（score.py 的 summary.json）整理成 docs/EVAL.md 里用的 markdown 表格。

用法：~/voice-pro-eval-venv/bin/python scripts/eval/report.py <调优前结果目录> <调优后结果目录> <章节>
章节：dataset | per-song | means | diag | direct
"""
import json
import os
import sys
from pathlib import Path

DATA = Path(os.environ.get("EVAL_DATA", Path.home() / "voice-pro-eval-data"))
HERE = Path(__file__).resolve().parent
SONGS = {s["id"]: s for s in json.loads((HERE / "songs.json").read_text())["songs"]}


def pct(x: float) -> str:
    return f"{x * 100:.1f}"


def mean(values):
    values = list(values)
    return sum(values) / len(values) if values else float("nan")


def meta(sid: str) -> dict:
    return json.loads((DATA / "prepared" / sid / "meta.json").read_text())


def dataset() -> None:
    print("| id | 歌曲 / 艺术家 | 来源 / 许可 | 类型 | 时长 | 参考有声占比 | 人声/伴奏 | 集 |")
    print("|---|---|---|---|---:|---:|---:|---|")
    for sid, s in SONGS.items():
        if not (DATA / "prepared" / sid / "meta.json").exists():
            continue
        m = meta(sid)
        link = f"[页面]({s['url']})" if s.get("url") else "—"
        ratio = "—" if s.get("skipSeparation") else f"{m['vocal_to_accomp_db']:+.1f} dB"
        mm, ss = divmod(round(m["duration"]), 60)
        print(
            f"| {sid} | {s['title']} / {s['artist']} | {link}；{s['license']} | {s['tags']} | {mm}:{ss:02d} | "
            f"{pct(m['voiced_ratio'])}% | {ratio} | {s['split']} |"
        )


def per_song(base: dict, final: dict) -> None:
    print("| 歌曲 | 集 | OA 前→后 | RPA 前→后 | VR 后 | VFA 后 | 音符 OA 前→后 | 干声 stem OA（后） |")
    print("|---|---|---:|---:|---:|---:|---:|---:|")
    for sid, f in final["songs"].items():
        variant = "separated" if "separated" in f else "direct"
        b = base["songs"].get(sid, {}).get(variant)
        x = f.get(variant)
        if not b or not x:
            continue
        o = f.get("oracle")
        print(
            f"| {sid} | {SONGS[sid]['split']} | {pct(b['OA'])}→**{pct(x['OA'])}** | {pct(b['RPA'])}→**{pct(x['RPA'])}** | "
            f"{pct(x['VR'])} | {pct(x['VFA'])} | {pct(b['notes_OA'])}→{pct(x['notes_OA'])} | {pct(o['OA']) if o else '—'} |"
        )


def means(base: dict, final: dict) -> None:
    def group(summary: dict, variant: str, split: str | None, real_only: bool = True):
        rows = []
        for sid, v in summary["songs"].items():
            if variant not in v:
                continue
            s = SONGS[sid]
            if real_only and s.get("skipSeparation"):
                continue
            if split and s["split"] != split:
                continue
            rows.append(v[variant])
        return rows

    keys = ["RPA", "RCA", "VR", "VFA", "OA", "notes_OA"]
    print("| 流水线 | 歌曲集 | 首数 | " + " | ".join(keys) + " |")
    print("|---|---|---:|" + "---:|" * len(keys))
    for label, variant in [("分离 + 提取（App 真实路径）", "separated"), ("干声 stem 直接提取（上限）", "oracle")]:
        for name, summary in [("调优前", base), ("调优后", final)]:
            for split, split_name in [(None, "全部真实歌曲"), ("dev", "dev"), ("test", "test（留出）")]:
                rows = group(summary, variant, split)
                if not rows:
                    continue
                cells = [pct(mean(r[k] for r in rows)) for k in keys]
                bold = name == "调优后"
                cells = [f"**{c}**" if bold and k == "OA" else c for c, k in zip(cells, keys)]
                print(f"| {label} · {name} | {split_name} | {len(rows)} | " + " | ".join(cells) + " |")


def direct(base: dict, final: dict) -> None:
    print("| 对象 | 版本 | 首数 | RPA | VR | VFA | OA |")
    print("|---|---|---:|---:|---:|---:|---:|")
    for label, demo in [("真实歌曲整曲直接提取（不分离）", False), ("合成示例歌（App 走此路径）", True)]:
        for name, summary in [("调优前", base), ("调优后", final)]:
            rows = [
                v["direct"]
                for sid, v in summary["songs"].items()
                if "direct" in v and bool(SONGS[sid].get("skipSeparation")) == demo
            ]
            if rows:
                print(
                    f"| {label} | {name} | {len(rows)} | {pct(mean(r['RPA'] for r in rows))} | {pct(mean(r['VR'] for r in rows))} | "
                    f"{pct(mean(r['VFA'] for r in rows))} | {pct(mean(r['OA'] for r in rows))} |"
                )


def diag(base: dict, final: dict) -> None:
    keys = [("d_miss", "漏检"), ("d_ok", "音高对"), ("d_oct_up", "高八度"), ("d_oct_down", "低八度"), ("d_other_err", "其他错音")]
    print("| 版本 | " + " | ".join(n for _, n in keys) + " | 误报（占全部帧） |")
    print("|---|" + "---:|" * (len(keys) + 1))
    for name, summary in [("调优前", base), ("调优后", final)]:
        rows = [
            v["separated"]
            for sid, v in summary["songs"].items()
            if "separated" in v and not SONGS[sid].get("skipSeparation")
        ]
        print(
            f"| {name} | "
            + " | ".join(pct(mean(r[k] for r in rows)) for k, _ in keys)
            + f" | {pct(mean(r['d_fa_of_all'] for r in rows))} |"
        )


def main() -> None:
    base = json.loads((Path(sys.argv[1]) / "summary.json").read_text())
    final = json.loads((Path(sys.argv[2]) / "summary.json").read_text())
    section = sys.argv[3]
    {"dataset": lambda: dataset(), "per-song": lambda: per_song(base, final), "means": lambda: means(base, final), "direct": lambda: direct(base, final), "diag": lambda: diag(base, final)}[section]()


if __name__ == "__main__":
    main()
