/** 首次启动隐私同意的本地状态。 */

export type PrivacyChoice = 'accepted' | 'declined'

const STORAGE_KEY = 'voicepro.privacy.v1'

export function loadPrivacyChoice(): PrivacyChoice | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY)
    return value === 'accepted' || value === 'declined' ? value : null
  } catch {
    return null
  }
}

export function savePrivacyChoice(choice: PrivacyChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // 隐私模式 / 存储不可用时保持会话内状态即可
  }
}
