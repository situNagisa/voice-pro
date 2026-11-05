/** 一帧音高。f0 为 null 表示无声或不确定。t 为秒。 */
export interface PitchFrame {
  t: number;
  f0: number | null;
  /** 0..1 置信度 */
  clarity: number;
}

/** 量化后的音符（旋律段）。midi 可为小数（保留微调信息）。 */
export interface Note {
  start: number;
  end: number;
  midi: number;
}

/** 从歌曲提取的参考旋律 */
export interface ReferenceMelody {
  duration: number;
  /** 帧间隔，秒 */
  hop: number;
  frames: PitchFrame[];
  notes: Note[];
}

export type ExtractProgress = (stage: string, ratio: number) => void;
