# 真实歌曲评测与调优

> 目标：用带干声 stem 的真实歌曲，量化「分离人声 → 提取原唱旋律」整条流水线的准确率，并据此调参。
> 数据只在本机 `~/voice-pro-eval-data/` 使用，不进仓库、不进 App；仓库里只有脚本（`scripts/eval/`）和本文档。

## 1. 结论速览

- 在 22 首真实歌曲（ccMixter，含 2 首中文）上，**分离 + 提取**的 Overall Accuracy 从 **64.3% 提到 79.9%**，Raw Pitch Accuracy 从 38.1% 到 72.7%，音符序列 OA 从 61.4% 到 74.4%。留出的 test 集（10 首，拟合和搜索都没用过）OA 为 79.5%，与 dev 集 80.3% 接近，没有明显过拟合。22 首里每一首的 OA 都提高了（+1.8 ~ +32.0 个点）。
- 调优前的主要问题不是音高，而是**发声判定过于保守**：在已经判为有声的帧里音高 98% 是对的，但真实歌曲里只有 38.7% 的有声帧被判为有声（Voicing Recall）。合成示例歌上的阈值是照合成人声定的，对真实人声完全不适用。调优后 Voicing Recall 82.5%，代价是 Voicing False Alarm 从 0.7% 升到 12.1%（OA 同时看这两头，直接以 OA 为目标）。
- 合成示例歌（App 里跳过分离、直接对整曲提取）没有变差，OA 从 94.3 / 96.6 / 97.5 提到 98.4 / 98.2 / 99.0。
- 人声分离本身不是瓶颈：把真实干声 stem 直接喂给提取（上限）OA 为 82.5%，分离后为 79.9%，只差 2.6 个点；20 首 ccMixter 的分离结果平均 SDR 11.2 dB。
- **不分离直接对真实混音提取基本不可用**（§4.3，RPA 16%）；App 本来也只在分离失败时才会走到这里。

## 2. 评测方法

流程（`scripts/eval/eval.ts`，node + `tsx`）：

1. 混音（44.1 kHz 双声道）→ `onnxruntime-node` 加载 `public/models/kuielab_a_vocals.onnx` 分离。分段/拼接用的是 App 同一份纯函数 `src/separation/chunking.ts`（以及 `stft.ts`），不是另写一套；分离结果按源码哈希缓存，改 `src/reference` 不会触发重新分离。
2. 对分离出的人声调用 `src/reference/pipeline.ts` 的 `runExtraction`，得到逐帧 f0（10 ms 一帧）和音符。
3. 三条对照线（`--variants`）：
   - `separated`：分离 + 提取，App 的真实路径；
   - `direct`：不分离，对混音直接提取；
   - `oracle`：把干声 stem 直接喂给提取，用来把「分离的损失」和「提取算法的损失」分开。
4. 合成示例歌（`src/demo`）：node 里没有 `OfflineAudioContext`，所以 `scripts/eval/render-demo.mjs` 用无头 Chromium（playwright）按当前工作区的合成器渲染出 mix/人声 stem，提取和评测仍在 node 里跑。App 对示例歌跳过分离，因此示例歌只有 `direct` 一条线。
5. 打分（`scripts/eval/score.py`）：直接调用 `mir_eval.melody.evaluate`，指标为 Raw Pitch Accuracy（±50 音分）、Raw Chroma Accuracy、Voicing Recall、Voicing False Alarm、Overall Accuracy。另外把输出的**音符**按 10 ms 栅格渲染成 f0 序列，用同样的指标算一遍（表中 notes_OA），反映谱面/打分真正用到的音符层。

**标准答案**：对干声 stem 先做 70 Hz 高通，再用 `librosa.pyin`（fmin 75 Hz、fmax 1100 Hz，24 kHz，帧长 2048，hop 10 ms，音高分辨率 0.1 半音，switch_prob 0.01）得到参考 f0；比 stem 最响亮段低 45 dB 以上的帧一律判无声（`scripts/eval/prepare.py`）。这不是人工标注，局限见 §6。

**数据划分**：12 首 dev（拟合发声模型、搜索参数）、10 首 test（留出，只用来报告）、3 首合成示例歌（单独报告；发声模型的训练集包含它们，拟合时权重 ×10、搜索参数时权重 ×3，以保证不变差；留一首示例歌不参与拟合时发声帧准确率为 98.0–99.1%）。分析失败原因时看过个别 test 歌曲的频谱图，但没有用 test 的数字做任何拟合或参数选择。

## 3. 数据集

来源：[ccMixter 人声分离语料](http://liutkus.net/ccmixter_corpus.zip)（Antoine Liutkus 2014 整理，50 首完整歌曲，每首 `source-01.wav` 伴奏、`source-02.wav` 人声、`mix.wav` = 二者之和；全部来自 ccmixter.org，均为 Creative Commons 许可，语料 README 注明「允许科学用途，大多不允许商用」）。选了其中 20 首（跨女声/男声/童声、流行/摇滚/电子/民谣/布鲁斯、伴奏重和慢歌）。每首的 ccMixter 页面和具体许可见下表；**只用于本地评测**。语料 zip 5.1 GB，按需用 HTTP range 只取了需要的 40 个文件，不是整包下载。

中文：ccMixter 上没有找到带分轨的普通话流行歌曲，只有 solos_to_use 上传的两段中文**干声**（CC BY-NC）。我把它们和 CC 授权的伴奏按「有声段人声/伴奏 = -3 dB」合成了 2 条混音（表中 `zh-*`，`synthetic_mix`），算 test 集。它们是中文传统/粤语歌，不是普通话流行；这点见 §8。

没有使用任何商业歌曲（MIR-1K 等卡拉 OK 数据集含商业歌曲伴奏，所以没用）。

| id | 歌曲 / 艺术家 | 来源 / 许可 | 类型 | 时长 | 参考有声占比 | 人声/伴奏 | 集 |
|---|---|---|---|---:|---:|---:|---|
| casimps1-could-be | Could Be / casimps1 | [页面](https://ccmixter.org/files/casimps1/41607)；CC BY-NC 3.0 | 女声+男声, 摇滚, MIDI 伴奏 | 3:48 | 51.8% | -5.7 dB | dev |
| casimps1-twinkle | Twinkle Twinkle Little Star / casimps1 | [页面](https://ccmixter.org/files/casimps1/32400)；CC BY-NC 3.0 | 童声, 童谣, 慢 | 1:17 | 40.2% | -6.3 dB | test |
| casimps1-bingo | Bingo (B-I-N-G-O) / casimps1 | [页面](https://ccmixter.org/files/casimps1/32398)；CC BY-NC 3.0 | 童声, 童谣 | 1:30 | 23.3% | -5.5 dB | dev |
| doxent-alice | Alice In the City / doxent | [页面](https://ccmixter.org/files/doxent/43310)；CC BY 3.0 | 女声, 钢琴/管弦, 慢歌 | 3:26 | 65.8% | +2.1 dB | test |
| mindmapthat-holidays | Not So Happy Holidays / mindmapthat | [页面](https://ccmixter.org/people/mindmapthat)；CC BY-NC 3.0 | 女声（具体授权以 ccMixter 页面为准） | 3:36 | 50.5% | -3.3 dB | dev |
| unreal-dm-californian-winter | Californian Winter / unreal_dm | [页面](https://ccmixter.org/files/unreal_dm/44742)；CC BY-NC 3.0 | 女声, 吉他/滑棒, 摇滚 | 3:20 | 80.2% | -6.5 dB | dev |
| nikmusik-white-lies | Little White Lies / Nikmusik | [页面](https://ccmixter.org/files/Nikmusik/44893)；CC BY-NC 3.0 | 男声, 独立摇滚/电子, 流行 | 3:24 | 39.5% | -4.9 dB | test |
| geert-blue-boy | Blue Boy / geertveneklaas | [页面](https://ccmixter.org/files/geertveneklaas/24843)；CC BY-NC 3.0 | 男声, 弦乐, 慢歌 | 4:02 | 42.2% | +2.5 dB | test |
| saw-amy-blues | Amy Winehouse Blues / stellarartwars | [页面](https://ccmixter.org/files/stellarartwars/39777)；CC BY-NC 3.0 | 电子/钢琴, 布鲁斯 | 3:56 | 60.0% | +2.6 dB | dev |
| saw-dollar | Dollar (Nice & Spicy Mix) / stellarartwars | [页面](https://ccmixter.org/files/stellarartwars/43380)；CC BY-NC 3.0 | 电子, 伴奏重 | 3:09 | 62.4% | -7.6 dB | dev |
| saw-winter-glow | Winter Glow (SAW liquid d&b mix) / stellarartwars | [页面](https://ccmixter.org/files/stellarartwars/44108)；CC BY-NC 3.0 | drum&bass, 伴奏重 | 4:21 | 71.2% | -5.4 dB | test |
| javolenus-king-henry | King Henry (Border Ballad) / Javolenus | [页面](https://ccmixter.org/files/Javolenus/41022)；CC BY-NC 3.0 | 男声, 民谣, 木吉他 | 5:15 | 73.9% | -0.6 dB | dev |
| copperhead-need-you | Need You Baby / copperhead | [页面](https://ccmixter.org/files/copperhead/42643)；CC BY-NC 3.0 | 男声, 放克/摇滚 | 4:49 | 74.4% | -7.8 dB | test |
| tmray-roulette | Roulette / tmray | [页面](https://ccmixter.org/files/tmray/42189)；CC BY 3.0 | 男声, 摇滚, 萨克斯 | 4:00 | 60.2% | -4.1 dB | dev |
| saw-silent-night | On A Silent Night / stellarartwars | [页面](https://ccmixter.org/files/stellarartwars/44303)；CC BY-NC 3.0 | 电子, 合成器 | 4:51 | 51.0% | -4.4 dB | dev |
| saw-emma | Emma (Barnstormer Mix) / stellarartwars | [页面](https://ccmixter.org/files/stellarartwars/42635)；CC BY-NC 3.0 | 电子 | 3:12 | 72.0% | -5.7 dB | dev |
| alexberoza-sensitive | To Be Sensitive / AlexBeroza & mindmapthat | [页面](https://ccmixter.org/files/AlexBeroza/42291)；CC BY-NC 3.0 | 女声, 电子流行, 尤克里里 | 3:35 | 77.3% | -5.7 dB | test |
| vjmemes-what-child | What Child is This (With Admiral Bob) / VJ_Memes | [页面](https://ccmixter.org/files/VJ_Memes/44509)；CC BY 3.0 | 男声, 圣诞 | 3:03 | 70.6% | -0.1 dB | dev |
| unreal-dm-jerusalem | Jerusalem / unreal_dm | [页面](https://ccmixter.org/files/unreal_dm/44821)；CC BY-NC 3.0 | 男声, 钢琴/摇滚 | 4:24 | 42.7% | -3.8 dB | test |
| yesterday-king-richard | King Richard's Blues (harp added) / Mr_Yesterday | [页面](https://ccmixter.org/files/Mr_Yesterday/42237)；CC BY 3.0 | 男声, 布鲁斯, 口琴 | 6:20 | 34.8% | +4.9 dB | dev |
| zh-shanghai-nights | Shanghai Nights（上海之夜，女声，干声）+ Nanyang Journey (Instrumental) / solos_to_use（人声）/ ramblinglibrarian（伴奏） | [页面](https://ccmixter.org/files/solos_to_use/49139)；人声 CC BY-NC 3.0；伴奏 CC BY 3.0（https://ccmixter.org/files/ramblinglibrarian/33455） | 中文，女声，民谣/传统风格，人声干声与 CC 伴奏按 -3 dB 人声/伴奏比合成混音 | 1:29 | 75.4% | -2.5 dB | test |
| zh-the-king | The King 之王（粤语，男声，干声）+ To Be Sensitive 伴奏 stem / solos_to_use（人声）/ AlexBeroza & mindmapthat（伴奏） | [页面](https://ccmixter.org/files/solos_to_use/49286)；人声 CC BY-NC 3.0；伴奏 CC BY-NC 3.0（https://ccmixter.org/files/AlexBeroza/42291，取自 ccMixter 语料包 source-01） | 中文（粤语），男声，电子流行伴奏，人声干声与 CC 伴奏按 -3 dB 人声/伴奏比合成混音 | 2:24 | 81.8% | -2.9 dB | test |
| demo-twinkle | 小星星（合成） / src/demo 合成器 | —；项目自带（合成，公版旋律/原创） | 合成示例歌 | 0:48 | 83.5% | — | demo |
| demo-ode-to-joy | 欢乐颂（合成） / src/demo 合成器 | —；项目自带（合成，公版旋律/原创） | 合成示例歌 | 0:44 | 86.6% | — | demo |
| demo-sunrise-etude | Sunrise Etude（合成） / src/demo 合成器 | —；项目自带（合成，公版旋律/原创） | 合成示例歌 | 0:53 | 82.3% | — | demo |

「参考有声占比」是 pyin 在干声 stem 上判为有声的帧比例；「人声/伴奏」是 stem 的 RMS 比（越小伴奏越重）。`mindmapthat-holidays` 在 ccMixter 上没检索到对应的单曲页面，表里放的是作者主页，许可只能按语料 README 的总说明（CC，多数 NC）理解，使用前请自行核对。

## 4. 结果

调优前 = 提交 `e5b34d9` 的 `pipeline.ts` 原样跑；调优后 = 当前工作区。分离部分两次完全相同（见 §5.2）。

### 4.1 汇总（22 首真实歌曲平均，单位 %）

| 流水线 | 歌曲集 | 首数 | RPA | RCA | VR | VFA | OA | notes_OA |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 分离 + 提取（App 真实路径） · 调优前 | 全部真实歌曲 | 22 | 38.1 | 38.3 | 38.7 | 0.7 | 64.3 | 61.4 |
| 分离 + 提取（App 真实路径） · 调优前 | dev | 12 | 36.5 | 36.7 | 37.1 | 0.3 | 64.0 | 61.2 |
| 分离 + 提取（App 真实路径） · 调优前 | test（留出） | 10 | 40.0 | 40.2 | 40.7 | 1.1 | 64.6 | 61.7 |
| 分离 + 提取（App 真实路径） · 调优后 | 全部真实歌曲 | 22 | 72.7 | 74.1 | 82.5 | 12.1 | **79.9** | 74.4 |
| 分离 + 提取（App 真实路径） · 调优后 | dev | 12 | 73.2 | 74.7 | 83.5 | 11.5 | **80.3** | 74.6 |
| 分离 + 提取（App 真实路径） · 调优后 | test（留出） | 10 | 72.2 | 73.3 | 81.3 | 12.8 | **79.5** | 74.1 |
| 干声 stem 直接提取（上限） · 调优前 | 全部真实歌曲 | 22 | 32.2 | 32.2 | 32.5 | 0.1 | 60.8 | 58.4 |
| 干声 stem 直接提取（上限） · 调优前 | dev | 12 | 31.7 | 31.7 | 32.2 | 0.1 | 60.9 | 58.3 |
| 干声 stem 直接提取（上限） · 调优前 | test（留出） | 10 | 32.8 | 32.8 | 33.0 | 0.0 | 60.8 | 58.5 |
| 干声 stem 直接提取（上限） · 调优后 | 全部真实歌曲 | 22 | 74.8 | 76.0 | 83.5 | 9.2 | **82.5** | 76.8 |
| 干声 stem 直接提取（上限） · 调优后 | dev | 12 | 74.2 | 75.5 | 83.4 | 7.1 | **82.5** | 76.9 |
| 干声 stem 直接提取（上限） · 调优后 | test（留出） | 10 | 75.5 | 76.7 | 83.5 | 11.8 | **82.5** | 76.8 |

### 4.2 逐曲（分离 + 提取；示例歌为整曲直接提取）

| 歌曲 | 集 | OA 前→后 | RPA 前→后 | VR 后 | VFA 后 | 音符 OA 前→后 | 干声 stem OA（后） |
|---|---|---:|---:|---:|---:|---:|---:|
| alexberoza-sensitive | test | 54.4→**76.8** | 41.1→**74.0** | 83.9 | 13.7 | 51.2→71.5 | 79.4 |
| casimps1-bingo | dev | 77.5→**79.2** | 3.6→**53.5** | 62.8 | 13.0 | 77.0→77.4 | 81.7 |
| casimps1-could-be | dev | 66.5→**75.6** | 36.0→**71.2** | 91.0 | 19.8 | 65.2→72.4 | 79.8 |
| casimps1-twinkle | test | 62.2→**67.4** | 6.5→**46.5** | 55.5 | 18.6 | 61.8→63.7 | 68.9 |
| copperhead-need-you | test | 45.5→**77.5** | 26.9→**78.6** | 90.3 | 25.6 | 42.1→70.3 | 79.3 |
| demo-ode-to-joy | demo | 94.3→**98.4** | 93.4→**98.2** | 99.6 | 0.0 | 94.2→95.5 | — |
| demo-sunrise-etude | demo | 96.6→**98.2** | 96.0→**97.9** | 99.6 | 0.9 | 96.4→96.5 | — |
| demo-twinkle | demo | 97.5→**99.0** | 97.0→**98.7** | 99.3 | 0.0 | 97.4→97.6 | — |
| doxent-alice | test | 65.1→**84.7** | 46.9→**82.8** | 90.3 | 11.6 | 61.2→80.4 | 86.5 |
| geert-blue-boy | test | 79.0→**90.7** | 50.2→**79.6** | 87.6 | 1.2 | 76.6→86.1 | 91.3 |
| javolenus-king-henry | dev | 52.8→**78.9** | 36.6→**76.1** | 87.3 | 13.2 | 49.5→70.6 | 83.8 |
| mindmapthat-holidays | dev | 77.1→**87.5** | 54.8→**81.9** | 93.6 | 6.9 | 73.5→81.4 | 89.0 |
| nikmusik-white-lies | test | 65.5→**71.2** | 13.0→**50.8** | 66.6 | 15.5 | 64.7→69.2 | 72.2 |
| saw-amy-blues | dev | 52.4→**84.1** | 20.7→**79.3** | 85.0 | 8.7 | 51.0→77.8 | 77.3 |
| saw-dollar | dev | 61.3→**80.0** | 37.9→**73.5** | 82.3 | 9.1 | 58.1→72.8 | 85.0 |
| saw-emma | dev | 51.3→**76.6** | 32.3→**71.0** | 80.5 | 9.1 | 46.7→69.8 | 80.0 |
| saw-silent-night | dev | 74.9→**89.9** | 50.7→**85.7** | 92.0 | 5.7 | 72.3→82.4 | 91.9 |
| saw-winter-glow | test | 64.8→**80.0** | 50.5→**73.7** | 79.4 | 4.5 | 60.9→75.1 | 85.1 |
| tmray-roulette | dev | 40.8→**65.0** | 1.7→**54.0** | 67.4 | 18.4 | 40.6→62.3 | 72.0 |
| unreal-dm-californian-winter | dev | 51.8→**63.6** | 40.3→**61.6** | 70.7 | 28.6 | 49.4→60.1 | 65.5 |
| unreal-dm-jerusalem | test | 77.2→**86.0** | 47.4→**76.5** | 85.5 | 7.0 | 74.9→81.5 | 88.5 |
| vjmemes-what-child | dev | 77.8→**90.6** | 68.6→**88.0** | 95.3 | 3.3 | 71.7→82.5 | 90.7 |
| yesterday-king-richard | dev | 84.3→**92.2** | 55.0→**82.0** | 93.7 | 2.4 | 79.4→85.6 | 93.6 |
| zh-shanghai-nights | test | 74.7→**82.5** | 69.3→**84.6** | 92.3 | 23.7 | 68.4→72.7 | 90.5 |
| zh-the-king | test | 58.0→**78.1** | 48.7→**74.6** | 81.9 | 6.6 | 55.2→70.3 | 83.7 |

调优后错误去向（22 首平均，占「参考有声帧」的比例；分离 + 提取）：

| 版本 | 漏检 | 音高对 | 高八度 | 低八度 | 其他错音 | 误报（占全部帧） |
|---|---:|---:|---:|---:|---:|---:|
| 调优前 | 61.3 | 38.1 | 0.2 | 0.0 | 0.4 | 0.2 |
| 调优后 | 17.5 | 72.7 | 1.2 | 0.2 | 8.4 | 4.6 |

调优前 61% 的参考有声帧被漏检、音高对的只有 38%；调优后漏检降到 17.5%，代价是误报（参考无声却判有声）占全部帧的比例从 0.2% 升到 4.6%。OA 是这两头的平衡，调优时直接以 OA 为目标，所以停在 VR 82.5% / VFA 12.1% 的位置，没有追求更高召回。

### 4.3 不分离、直接提取（对照）

| 对象 | 版本 | 首数 | RPA | VR | VFA | OA |
|---|---|---:|---:|---:|---:|---:|
| 真实歌曲整曲直接提取（不分离） | 调优前 | 22 | 1.0 | 1.4 | 3.2 | 40.1 |
| 真实歌曲整曲直接提取（不分离） | 调优后 | 22 | 16.3 | 34.0 | 29.5 | 38.2 |
| 合成示例歌（App 走此路径） | 调优前 | 3 | 95.5 | 95.6 | 0.2 | 96.1 |
| 合成示例歌（App 走此路径） | 调优后 | 3 | 98.3 | 99.5 | 0.3 | 98.5 |

对真实混音，调优前几乎什么都判无声（OA 40.1% 基本等于「全判无声」的基线）；调优后能给出一部分旋律（RPA 1% → 16%，VR 1% → 34%），OA 持平略低（38.2%），伴奏里的和声/乐器仍有 30% 被判成人声。发声模型是为「分离后的人声」和「合成示例歌」拟合的，没有为整曲混音拟合；这里靠一条简单规则收紧判定（§5.1「整曲式输入」）。这条路径只在分离失败时出现，不值得再投入。

## 5. 做了什么改动

### 5.1 `src/reference/`

- **发声判定改为逻辑回归**。原来是手写的 `质量 = 谐波显著性 × 能量 × 声场宽度`，阈值按合成示例歌定的。现在每帧算 18 个特征（`FEATURE_NAMES`）：能量相对全曲响亮段（P90）的 dB、谐波显著性峰/均值、最强候选的谐波能量占比、谐波峰谷比、6 个频带能量占比、谱平坦度、高频占比、候选个数、第二候选相对强度、±4 帧音高抖动（持续嗡声/合成器音抖动接近 0，人声有自然抖动）等；再对其中一部分取 ±3 / ±10 帧滑动平均作为上下文，L1 筛选后保留 24 列。系数用 `scripts/eval/fit_voicing.py` 在 dev 歌曲的「分离人声 + 干声 stem」加合成示例歌上拟合（示例歌权重 ×10），写在 `DEFAULT_PARAMS`。留出集帧级发声准确率约 85%。示例歌权重 ×10 的原因：留一首示例歌不参与拟合时，权重 1 的发声帧准确率只有 90–93%，×10 时是 98.0–99.1%，代价是真实歌曲留出集的帧准确率降 0.6 个点。
- **Viterbi 观测改为对数概率**：有声观测 = `log P(有声) + 候选相对显著性`，无声观测 = `log P(无声)`。无声↔有声切换代价 0.2、音高跳变惩罚 ×4（抑制谐波/八度跳）、候选显著性权重 0.5（旧版的代价是另一套标度，数值不可直接比）；发声 logit 整体偏移 −0.5，是 OA 最优的取舍。
- **清理**：最短发声段 2–3 帧 → 6 帧；补洞上限仍为 40 ms。
- **整曲式输入的收紧规则**：全曲几乎没有静音（比响亮段低 35 dB 的帧不到 6%）时，视为未分离的混音，发声 logit 再 −1.5。分离后的人声都有换气/间奏的静音（20 首 ccMixter 最少 10%），整曲混音只有 0–3%，合成示例歌 2%（它们的人声概率很高，不受影响）。
- **切音符**：中值滤波半径 9 → 7 帧，音高台阶 0.6 → 0.5 半音，其余规则不变，参数化到 `ExtractionParams`。网格搜索表明可以用把音符数翻 3 倍的代价再换 +4 个点的音符 OA，那就是逐帧而不是音符了，所以没采纳；当前设置在音符数 +13% 的前提下音符 OA +0.7（dev 上）。
- **`cleanVocals` 不再影响结果**：`src/library/analyze.ts` 先分离、再给人声打上「跳过分离」标记，所以 `extractReferenceMelody` 对这些**分离后的人声**也走 `cleanVocals = false` 分支；而合成示例歌打的是同一个标记。调用方无法区分这两种输入，因此改成一套参数同时覆盖两者，不依赖该标记（接口保留）。
- 代码结构：`runExtraction` 拆成 `prepareAnalysis`（谱分析）→ `extractFromAnalysis`（发声概率 → Viterbi → 清理 → 音符），并导出 `ExtractionParams`、`analyzeFeatures`，供调优/拟合脚本复用；`runExtraction` 增加可选第三参数，App 不传。`extractReferenceMelody`、`separateVocals` 的签名没变。
- 未采纳：为未分离的整曲单独拟合一套模型（用 `cleanVocals` 区分）。上一条说明标记不可靠；把真实整曲也混进训练集，分离人声的发声准确率降 1.2 个点、示例歌降到约 93%，得不偿失。

### 5.2 `src/separation/`

- 新增 `chunking.ts`：把「分段推理 + 交叉淡入淡出拼接」抽成与推理引擎无关的纯函数，`engine.ts`（onnxruntime-web）和评测脚本（onnxruntime-node）共用，行为与原来一致。
- 分段重叠 0.5 / 1 / 3 秒对比（6 首歌）：平均 SDR 分别为 10.62 / 10.60 / 10.62 dB，提取后的 OA 分别为 81.56 / 81.61 / 81.44（差别在 ±0.2 以内），所以**保持 1 秒**，加大重叠只会多花算力。模型和 STFT 参数没动：分离的损失只占 2.6 个点（见 §1），不是瓶颈。

## 6. 已知失败类型

1. **发声漏检/误报仍是主要误差**（调优后漏检 17.5%、误报 4.6%、其他错音 8.4%）。其中相当一部分是标准答案本身的问题：合唱/和声段，pyin 的有声标记是碎的，干声 stem 的频谱上明明有连续的谐波结构（如 nikmusik 116–122 s）。
2. **分离泄漏造成误报**：人声 stem 在无人声段残留持续的合成器/吉他/嗡声，被判成有声（zh-shanghai-nights VFA 23.7%、californian-winter 28.6%、copperhead 25.6%、tmray 18.4%）。
3. **童声和嘈杂人声**：casimps1-twinkle / bingo 的 stem 是嘈杂的童声合唱，Voicing Recall 55% / 63%、RPA 47% / 54%，pyin 的标注也不可靠；nikmusik（男声叠和声）RPA 51%。
4. **低男声**（参考 f0 < 130 Hz）：1024 点分析窗的频率分辨率不够。75–130 Hz 区间有声召回 64.6%、音高对 45.5%，而 130–300 Hz 是 87.1% / 77.5%（tmray 75–100 Hz 只有 35% 被判有声）；偶发八度错（javolenus 75–100 Hz 有 27% 判成高八度，样本只有 555 帧）。
5. **快速滑音/颤音转折处**：提取与参考相差 50–400 音分，占参考有声帧的 8.4%，其中偏低的是偏高的 2.5 倍（滑音下行时 pyin 的 85 ms 窗口和我们的 64 ms 窗口对「瞬时音高」的取法不同；谁更接近真实音高无法判断）。
6. **高八度**占 1.2%，集中在 nikmusik（5.3%）、could-be（3.9%）、tmray（2.8%）、bingo（2.5%）。
7. **音符层**比逐帧低约 5.5 个点（OA 74.4 vs 79.9）：一个音符只有一个音高，滑音、颤音、长音中间的漂移超过 ±50 音分时没法再贴合；这是表示方式的上限，不是 bug。
8. **未分离的整曲**：不可用（§4.3）。
9. 标准答案只有 pyin，单音高、无人工校对；ccMixter 的 `mix.wav` 是 stem 之和，不是经过母带处理的成品，混响/压缩特征和商业发行歌曲不同；真实商业歌曲的效果仍未验证。

## 7. 复现

环境（一次性）：

```bash
python3 -m venv ~/voice-pro-eval-venv
~/voice-pro-eval-venv/bin/pip install librosa mir_eval soundfile numpy scipy scikit-learn remotezip matplotlib
cd scripts/eval && npm install          # onnxruntime-node + tsx，独立于主 package.json
```

数据：`ccmixter_corpus.zip` 里 `scripts/eval/songs.json` 列出的目录，每首只取 `mix.wav` 和 `source-02.wav`，放到 `~/voice-pro-eval-data/ccmixter/raw/<目录>/`（用 `remotezip` 按 range 取）；中文两首见 songs.json 的 `dir`/`accompaniment` 字段（下载 ccMixter 文件需要带 Referer，否则 403）；示例歌：`node scripts/eval/render-demo.mjs`。

```bash
~/voice-pro-eval-venv/bin/python scripts/eval/prepare.py          # pyin 参考 f0 + 统一成 44.1 kHz 双声道
scripts/eval/node_modules/.bin/tsx scripts/eval/eval.ts --run final --notes --diag   # 分离(缓存) + 三条对照线 + mir_eval 表格
scripts/eval/node_modules/.bin/tsx scripts/eval/features.ts       # 导出逐帧特征
~/voice-pro-eval-venv/bin/python scripts/eval/fit_voicing.py --variant separated --train-variants separated,oracle --with-demo --demo-weight 10 --prune 0.003 --emit pruned --out model.json
scripts/eval/node_modules/.bin/tsx scripts/eval/tune.ts --mode clean --model model.json --search   # 坐标下降；--grid-notes 看音符切分取舍
~/voice-pro-eval-venv/bin/python scripts/eval/sdr.py              # 分离 SDR，对比分段拼接参数
```

调优前的结果：`git show e5b34d9:src/reference/pipeline.ts > src/reference/pipeline.baseline.ts`，然后 `eval.ts --run baseline --pipeline ../../src/reference/pipeline.baseline --notes --diag`，用完删除该文件。调优前后对比表：`scripts/eval/report.py <baseline 结果目录> <final 结果目录> dataset|per-song|means|direct|diag`。结果目录在 `~/voice-pro-eval-data/results/<run>/`。

注意：Python 3.14 下 `librosa.pyin` 内部的 numba guvectorize 会段错误，`prepare.py` 里换成了等价的 numpy 抛物线插值。示例歌是按当时工作区的 `src/demo` 渲染的，合成器改动后需要重跑 `render-demo.mjs` 和 `prepare.py --force`。

## 8. 未决 / 后续

- 中文流行：没有拿到带分轨的**普通话**流行歌。若要补，可考虑 Opencpop / M4Singer（均为 CC BY-NC(-ND/-SA)、干声、需自行同意许可后下载），再与 CC 伴奏合成混音；需要你决定是否接受这类「仅供研究」许可的数据在本机使用。
- `src/core/audioFlags.ts` 里「合成示例歌」和「已分离的人声」共用一个标记，提取端无法区分两者。目前靠单一参数集回避；以后若要为两者分别调参，需要调用方显式传入输入类型。
- 分离结果里的持续伴奏泄漏（§6.2）可能还有提升空间，例如用分离后的伴奏做「人声是否真的存在」的交叉判断；这需要把伴奏也传进提取，接口会变，所以这次没做。

## 9. 快速分离模式（v0.5）

手机 WebView 里 `crossOriginIsolated` 通常为 false，onnxruntime-web 的多线程 WASM 用不上。快速模式不依赖 `SharedArrayBuffer`：把整首歌切成同样的 11.87 s 分段，但重叠从 1 s 降到 0.5 s，并用 N 个 Worker 各建一个 ORT 会话并行推理，主线程负责分发与交叉淡入淡出。模型、STFT 参数、发声判定和提取参数都没动。

准确率用同一套评测脚本跑：

```bash
scripts/eval/node_modules/.bin/tsx scripts/eval/eval.ts \
  --run quick0.5 --variants separated --overlap 0.5 --notes --diag
```

22 首真实歌曲（标准 = §4.1 的 `final`，快速 = `quick0.5`）：

| 模式 | 重叠 | RPA | RCA | VR | VFA | OA | notes_OA |
|---|---:|---:|---:|---:|---:|---:|---:|
| 标准 | 1.0 s | 72.7 | 74.1 | 82.5 | 12.1 | **79.9** | 74.4 |
| 快速 | 0.5 s | 72.8 | 74.1 | 82.6 | 12.3 | **79.8** | 74.3 |

快速模式对整体准确率的影响是 **−0.1 个点 OA**。逐曲看，OA 变化在 −0.6 ~ +0.5 之间（最大下降 `unreal-dm-jerusalem` −0.6、`nikmusik-white-lies` −0.5；最大上升 `saw-winter-glow` +0.5），音符层 notes_OA 变化在 −1.1 ~ +0.8 之间。并行本身不改变结果，差异只来自 0.5 s / 1 s 重叠。

速度在桌面 Chromium 里测（20 核；文档响应去掉 COOP/COEP，并用 `--disable-webgpu`，即模拟手机 WebView 的「无跨源隔离、单线程 WASM、无 WebGPU」）：

| 模式 | Worker | 24 s 音频导入总耗时 | 其中分离 |
|---|---:|---:|---:|
| 标准 | 1 | 62.4 s | ~59 s（3 段串行） |
| 快速 | 3 | 16.2 s | ~15 s（模型初始化 + 3 段并行，每段约 13.2 s） |

端到端约 **3.9×**，分离阶段约 **4×**。手机端按内存/核数只开 2 路（`deviceMemory >= 6` 或拿不到时；明确 4 GB 级时 1 路），预计约 1.8–2×；还没有真机数字。快速模式每个 Worker 都持有一份 30 MB 模型和 ORT 会话，内存占用明显更高；Worker 初始化失败时会自动回退标准模式，不会让导入失败。

### 不分离先给粗略旋律？不采用

§4.3 已经证明真实混音直接提取不可用（OA 38.2%，基本等于「全判无声」的基线）。这次另外试了中置声道提取（`(L+R)/2`，成本几乎为零）作为更便宜的「快速预览」：在 6 首真实歌上 RPA 15.0%、VR 34.0%、OA 36.9%，仍不可用，甚至不比直接提取好。所以导入时不再给「先练粗略版、后台替换」的假承诺；等待分离时改为在首页引导用户去音准仪或练声小课（分析在后台继续）。
