import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.voicepro.app',
  appName: '音准镜',
  webDir: 'dist',
  android: {
    // 默认 https://localhost，网页里的 getUserMedia 属于安全上下文
    allowMixedContent: false,
  },
}

export default config
