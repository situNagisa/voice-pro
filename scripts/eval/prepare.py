#!/usr/bin/env python3
"""
评测数据准备：对 songs.json 里的每首歌，从干声人声 stem 提取参考 f0（librosa.pyin）。

输入：~/voice-pro-eval-data/<set>/raw/<dir>/ 下的 mix 与人声 stem（数据不入仓库）。
输出：~/voice-pro-eval-data/prepared/<id>/
  mix.wav      44.1 kHz 双声道 float32（评测流水线的输入）
  vocals.wav   44.1 kHz 双声道 float32（干声）
  ref.csv      time,f0（10 ms 间隔，f0=0 表示无声），mir_eval 格式
  meta.json    时长、有声占比、音域、人声/伴奏响度比等统计

用法：~/voice-pro-eval-venv/bin/python scripts/eval/prepare.py [--force] [id ...]
"""
import json
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import librosa
import librosa.core.pitch as _librosa_pitch
import numpy as np
import soundfile as sf
from scipy.signal import butter, sosfiltfilt


def _parabolic_interpolation(x: np.ndarray, *, axis: int = -2) -> np.ndarray:
    """numpy 版抛物线插值。librosa 自带的 numba guvectorize 版本在 Python 3.14 下会段错误。"""
    xi = np.swapaxes(x, -1, axis)
    shifts = np.zeros_like(xi)
    a = xi[..., 2:] + xi[..., :-2] - 2 * xi[..., 1:-1]
    b = (xi[..., 2:] - xi[..., :-2]) / 2
    with np.errstate(divide="ignore", invalid="ignore"):
        inner = np.where(np.abs(b) >= np.abs(a), 0.0, -b / a)
    shifts[..., 1:-1] = np.nan_to_num(inner)
    return np.swapaxes(shifts, -1, axis)


_librosa_pitch._parabolic_interpolation = _parabolic_interpolation

DATA = Path(os.environ.get("EVAL_DATA", Path.home() / "voice-pro-eval-data"))
HERE = Path(__file__).resolve().parent
TARGET_SR = 44100
PYIN_SR = 24000
PYIN_HOP = 240  # 10 ms
PYIN_FRAME = 2048  # 85 ms：低音男声也有足够周期数
FMIN = 75.0  # 略高于 D2；更低的多是底噪/低频伴奏泄漏，不是人声
FMAX = 1100.0
GATE_DB = -45.0  # 低于人声 stem 响亮段 45 dB 以上的帧直接判无声


def load_stereo(path: Path) -> np.ndarray:
    data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    data = data.T
    if data.shape[0] == 1:
        data = np.vstack([data[0], data[0]])
    elif data.shape[0] > 2:
        data = data[:2]
    if sr != TARGET_SR:
        data = librosa.resample(data, orig_sr=sr, target_sr=TARGET_SR, axis=1)
    return np.ascontiguousarray(data.astype(np.float32))


def frame_rms(y: np.ndarray, sr: int, hop_s: float = 0.01, win_s: float = 0.04) -> np.ndarray:
    hop = int(sr * hop_s)
    win = int(sr * win_s)
    pad = np.pad(y, (win // 2, win // 2))
    n = (len(y) // hop) + 1
    out = np.zeros(n, dtype=np.float32)
    for i in range(n):
        seg = pad[i * hop : i * hop + win]
        out[i] = np.sqrt(np.mean(seg * seg) + 1e-12)
    return out


def prepare(song: dict, force: bool) -> dict:
    sid = song["id"]
    out = DATA / "prepared" / sid
    meta_path = out / "meta.json"
    if meta_path.exists() and not force:
        return json.loads(meta_path.read_text())
    out.mkdir(parents=True, exist_ok=True)

    root = DATA / song["dir"]
    vocals = load_stereo(root / song["vocals"])
    if song.get("mix"):
        mix = load_stereo(root / song["mix"])
        n = min(mix.shape[1], vocals.shape[1])
        mix, vocals = mix[:, :n], vocals[:, :n]
    else:
        # 没有现成混音时：干声 + 伴奏 stem。伴奏过短则循环、过长则截断，
        # 并按“有声段人声 RMS / 伴奏 RMS”= accompaniment_target_db（默认 -3 dB，接近真实混音）定增益。
        accomp = load_stereo(root / song["accompaniment"])
        n = vocals.shape[1]
        if accomp.shape[1] < n:
            accomp = np.tile(accomp, (1, int(np.ceil(n / accomp.shape[1]))))
        accomp = accomp[:, :n]
        v_rms = frame_rms(vocals.mean(axis=0), TARGET_SR)
        active = v_rms > np.percentile(v_rms, 95) * 10 ** (-35 / 20)
        a_rms = frame_rms(accomp.mean(axis=0), TARGET_SR)
        k = min(len(active), len(a_rms))
        ratio_now = np.sqrt(np.mean(v_rms[:k][active[:k]] ** 2)) / (np.sqrt(np.mean(a_rms[:k][active[:k]] ** 2)) + 1e-9)
        target = 10 ** (song.get("accompaniment_target_db", -3.0) / 20)
        mix = vocals + accomp * (ratio_now / target)
    peak = float(np.max(np.abs(mix)))
    if peak > 0.99:
        scale = 0.99 / peak
        mix = mix * scale
        vocals = vocals * scale
    sf.write(str(out / "mix.wav"), mix.T, TARGET_SR, subtype="FLOAT")
    sf.write(str(out / "vocals.wav"), vocals.T, TARGET_SR, subtype="FLOAT")

    # 去掉 70 Hz 以下的隆隆声/直流，避免 pyin 把它当成基频
    mono = sosfiltfilt(butter(4, 70, "highpass", fs=TARGET_SR, output="sos"), vocals.mean(axis=0)).astype(np.float32)
    y = librosa.resample(mono, orig_sr=TARGET_SR, target_sr=PYIN_SR)
    f0, voiced_flag, _ = librosa.pyin(
        y,
        fmin=FMIN,
        fmax=FMAX,
        sr=PYIN_SR,
        frame_length=PYIN_FRAME,
        hop_length=PYIN_HOP,
        center=True,
        resolution=0.1,
        switch_prob=0.01,
        fill_na=None,
    )
    rms = frame_rms(mono, TARGET_SR)
    m = min(len(rms), len(f0))
    f0, voiced_flag, rms = f0[:m], voiced_flag[:m], rms[:m]
    loud = np.percentile(rms, 95)
    gate = loud * 10 ** (GATE_DB / 20)
    voiced = voiced_flag & np.isfinite(f0) & (rms > gate)
    ref = np.where(voiced, f0, 0.0)
    t = np.arange(m) * 0.01
    with open(out / "ref.csv", "w") as fh:
        for ti, fi in zip(t, ref):
            fh.write(f"{ti:.3f},{fi:.3f}\n")

    voiced_hz = ref[ref > 0]
    acc_rms = frame_rms((mix - vocals).mean(axis=0), TARGET_SR)[:m]
    voc_rms = rms
    sel = ref > 0
    vm_db = (
        float(20 * np.log10(np.mean(voc_rms[sel] ** 2) ** 0.5 / (np.mean(acc_rms[sel] ** 2) ** 0.5 + 1e-9)))
        if sel.any()
        else None
    )
    midi = 69 + 12 * np.log2(voiced_hz / 440.0) if len(voiced_hz) else np.array([])
    meta = {
        "id": sid,
        "duration": round(mono.shape[0] / TARGET_SR, 2),
        "frames": int(m),
        "voiced_ratio": round(float(voiced.mean()), 3),
        "median_f0_hz": round(float(np.median(voiced_hz)), 1) if len(voiced_hz) else None,
        "midi_p5_p95": [round(float(np.percentile(midi, 5)), 1), round(float(np.percentile(midi, 95)), 1)]
        if len(midi)
        else None,
        "vocal_to_accomp_db": round(vm_db, 1) if vm_db is not None else None,
    }
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
    print(sid, meta, flush=True)
    return meta


def _job(args):
    return prepare(*args)


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    songs = json.loads((HERE / "songs.json").read_text())["songs"]
    if args:
        songs = [s for s in songs if s["id"] in args]
    songs = [s for s in songs if (DATA / s["dir"] / s["vocals"]).exists() and (DATA / s["dir"] / (s.get("mix") or s["accompaniment"])).exists()]
    with ProcessPoolExecutor(max_workers=min(8, len(songs) or 1)) as ex:
        list(ex.map(_job, [(s, force) for s in songs]))


if __name__ == "__main__":
    main()
