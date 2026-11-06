#!/usr/bin/env python3
"""
拟合“逐帧是否发声”的逻辑回归，系数贴进 src/reference/pipeline.ts 的 VOICING_MODELS。

特征由 features.ts 导出（src/reference/pipeline.ts 的 analyzeFeatures），标签是 prepared/<song>/ref.csv（pyin）。
按 songs.json 里的 split 字段区分 dev（拟合）/ test（留出，只用来报告）。

用法：~/voice-pro-eval-venv/bin/python scripts/eval/fit_voicing.py [--variant separated|direct] [--train-variants a,b] [--emit]
"""
import json
import os
import sys
from pathlib import Path

import numpy as np
from scipy.optimize import minimize
from sklearn.metrics import roc_auc_score

DATA = Path(os.environ.get("EVAL_DATA", Path.home() / "voice-pro-eval-data"))
HERE = Path(__file__).resolve().parent
NAMES = json.loads((DATA / "features" / "names.json").read_text())
SMOOTH = (3, 10)  # 上下文平滑半径（帧）
SMOOTHED = ["relE", "prom", "hr", "pv", "flat", "hr5", "jit", "b1", "b2", "b3", "b4", "b5", "b6"]


def boxcar(x: np.ndarray, r: int) -> np.ndarray:
    """与 pipeline.ts 的 smooth() 一致：两端按实际样本数平均。"""
    k = np.ones(2 * r + 1)
    num = np.convolve(x, k, mode="same")
    den = np.convolve(np.ones_like(x), k, mode="same")
    return num / den


def design(feat: np.ndarray, columns: list[str]) -> np.ndarray:
    idx = {n: i for i, n in enumerate(NAMES)}
    cols = []
    for c in columns:
        if "@" in c:
            base, r = c.split("@")
            cols.append(boxcar(feat[:, idx[base]], int(r)))
        else:
            cols.append(feat[:, idx[c]])
    return np.stack(cols, axis=1)


def load(song: str, variant: str, n_hint: int | None = None):
    f = DATA / "features" / song / f"{variant}.f32"
    if not f.exists():
        return None
    raw = np.fromfile(f, dtype=np.float32)
    feat = raw.reshape(-1, len(NAMES)).astype(np.float64)
    ref = np.loadtxt(DATA / "prepared" / song / "ref.csv", delimiter=",")[:, 1]
    n = min(len(feat), len(ref))
    return feat[:n], (ref[:n] > 0).astype(np.float64)


def fit_logistic(x: np.ndarray, y: np.ndarray, l2: float = 1e-3, weight: np.ndarray | None = None):
    mu, sd = x.mean(0), x.std(0) + 1e-9
    z = (x - mu) / sd
    z1 = np.hstack([z, np.ones((len(z), 1))])
    sw = np.ones(len(y)) if weight is None else weight
    sw = sw / sw.sum()

    def loss(w):
        a = z1 @ w
        p = 1 / (1 + np.exp(-a))
        ll = -np.sum(sw * (y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12))) + l2 * np.sum(w[:-1] ** 2)
        g = z1.T @ (sw * (p - y))
        g[:-1] += 2 * l2 * w[:-1]
        return ll, g

    w = minimize(loss, np.zeros(z1.shape[1]), jac=True, method="L-BFGS-B").x
    # 折回原始特征空间：a = sum(coef * x) + bias
    coef = w[:-1] / sd
    bias = w[-1] - np.sum(w[:-1] * mu / sd)
    return coef, bias


def predict(coef, bias, x):
    return 1 / (1 + np.exp(-(x @ coef + bias)))


def main() -> None:
    args = sys.argv[1:]
    variant = args[args.index("--variant") + 1] if "--variant" in args else "separated"
    train_variants = (args[args.index("--train-variants") + 1] if "--train-variants" in args else variant).split(",")
    songs = json.loads((HERE / "songs.json").read_text())["songs"]
    songs = [s for s in songs if (DATA / "prepared" / s["id"] / "ref.csv").exists()]
    dev = [s for s in songs if s.get("split", "dev") == "dev" and not s.get("skipSeparation")]
    test = [s for s in songs if s.get("split") in ("test", "demo")] if variant == "direct" else [s for s in songs if s.get("split") == "test"]
    if "--with-demo" in args:
        dev += [s for s in songs if s.get("skipSeparation")]

    base = ["relE", "prom", "hr", "pv", "hf", "flat", "nCand", "midi", "cand2", "hr5", "jit", "b1", "b2", "b3", "b4", "b5", "b6"]
    if variant == "direct" or "--width" in args:
        base.append("width")
        SMOOTHED.append("width")
    ctx = [f"{n}@{r}" for n in SMOOTHED for r in SMOOTH]
    ctx_old = [f"{n}@{r}" for n in ["relE", "prom", "hr", "pv", "flat"] for r in SMOOTH]
    sets = {
        "old": ["relE", "prom", "hr", "pv", "hf", "flat", "nCand", "midi", "cand2"] + ctx_old,
        "relE": ["relE"],
        "relE+prom+hr": ["relE", "prom", "hr"],
        "raw": base,
        "raw+ctx": base + ctx,
    }

    demo_weight = float(args[args.index("--demo-weight") + 1]) if "--demo-weight" in args else 1.0

    def gather(group, variants):
        xs, ys, ids, ws = [], [], [], []
        for s in group:
            for v in variants:
                if s.get("skipSeparation"):
                    # 合成示例歌没有“分离后”版本，App 里就是整曲直接提取；单一模型要同时覆盖它
                    v = "direct"
                d = load(s["id"], v)
                if d is None:
                    continue
                xs.append(d[0])
                ys.append(d[1])
                ids.append((s["id"], v))
                ws.append(np.full(len(d[1]), demo_weight if s.get("skipSeparation") else 1.0))
        gather.weights = ws
        return xs, ys, ids

    dev_x, dev_y, _ = gather(dev, train_variants)
    dev_w = np.concatenate(gather.weights)
    test_x, test_y, test_ids = gather(test, [variant])
    print(f"训练 {len(dev_x)} 条序列，留出 {len(test_x)} 条；训练变体 {train_variants}，评估变体 {variant}")

    # 单特征 AUC（在 dev 上）
    allx = np.vstack(dev_x)
    ally = np.concatenate(dev_y)
    print("\n单特征 AUC（dev）：")
    for i, n in enumerate(NAMES):
        try:
            auc = roc_auc_score(ally, allx[:, i])
        except ValueError:
            continue
        print(f"  {n:6s} {auc:.3f}")

    if "--prune" in args:
        # L1 筛掉冗余列，减少要贴进 pipeline.ts 的系数
        from sklearn.linear_model import LogisticRegression

        c_value = float(args[args.index("--prune") + 1])
        cols = sets["raw+ctx"]
        X = np.vstack([design(x, cols) for x in dev_x])
        mu, sd = X.mean(0), X.std(0) + 1e-9
        sub = np.random.default_rng(0).choice(len(X), size=min(len(X), 200000), replace=False)
        clf = LogisticRegression(penalty="l1", C=c_value, solver="liblinear", max_iter=300).fit((X[sub] - mu) / sd, ally[sub])
        keep = [c for c, w in zip(cols, clf.coef_[0]) if abs(w) > 1e-6]
        print(f"\nL1 保留 {len(keep)}/{len(cols)} 列：{keep}")
        sets["pruned"] = keep

    results = {}
    for name, cols in sets.items():
        X = np.vstack([design(x, cols) for x in dev_x])
        coef, bias = fit_logistic(X, ally, weight=dev_w)
        accs, aucs = [], []
        for x, y in zip(test_x, test_y):
            p = predict(coef, bias, design(x, cols))
            accs.append(np.mean((p > 0.5) == (y > 0.5)))
            aucs.append(roc_auc_score(y, p))
        results[name] = (coef, bias)
        print(f"\n[{name}] 留出集 voicing 帧准确率 {np.mean(accs) * 100:.1f}%，AUC {np.mean(aucs):.3f}")
        if name == ("pruned" if "pruned" in sets else "raw+ctx"):
            for (sid, v), a in zip(test_ids, accs):
                print(f"    {sid:28s} {a * 100:.1f}%")

    if "--emit" in args:
        name = args[args.index("--emit") + 1]
        coef, bias = results[name]
        model = {"columns": sets[name], "coef": [float(f"{c:.6g}") for c in coef], "bias": float(f"{bias:.6g}")}
        out = args[args.index("--out") + 1] if "--out" in args else None
        text = json.dumps(model)
        if out:
            Path(out).write_text(text)
        print("\n模型：", text)


if __name__ == "__main__":
    main()
