#!/usr/bin/env python3
"""
分离质量：缓存里的分离人声 vs 真实人声 stem 的 SDR（dB，越高越好）。
用法：~/voice-pro-eval-venv/bin/python scripts/eval/sdr.py [song ...]  [--glob 'vocals-*.wav']
会列出每个缓存文件（不同哈希 = 不同分离代码/重叠设置）的 SDR，方便对比分段拼接参数。
"""
import glob
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

DATA = Path(os.environ.get("EVAL_DATA", Path.home() / "voice-pro-eval-data"))


def main() -> None:
    songs = [a for a in sys.argv[1:] if not a.startswith("--")] or sorted(
        p.name for p in (DATA / "cache").iterdir() if p.is_dir()
    )
    rows: dict[str, list[float]] = {}
    for song in songs:
        ref, _ = sf.read(DATA / "prepared" / song / "vocals.wav", dtype="float64", always_2d=True)
        for f in sorted(glob.glob(str(DATA / "cache" / song / "vocals-*.wav")), key=os.path.getmtime):
            est, _ = sf.read(f, dtype="float64", always_2d=True)
            n = min(len(ref), len(est))
            r, e = ref[:n], est[:n]
            sdr = 10 * np.log10(np.sum(r**2) / (np.sum((r - e) ** 2) + 1e-12))
            tag = Path(f).stem.split("-", 1)[1]
            rows.setdefault(tag, []).append(sdr)
            print(f"{song:32s} {tag}  SDR {sdr:6.2f} dB")
    print()
    for tag, values in rows.items():
        print(f"{tag}: {len(values)} 首平均 SDR {np.mean(values):.2f} dB")


if __name__ == "__main__":
    main()
