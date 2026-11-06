# 音准镜（Voice Pro）

唱歌纠音应用：导入一首歌，跟着唱，实时对照原唱旋律看每个音偏高还是偏低，唱完得到逐句音准报告。所有音频在本机处理，不上传。

## 开发

```bash
npm install
npm run dev       # 浏览器开发（麦克风需要 HTTPS 或 localhost）
npm run build     # 生产构建
npm run lint
```

技术栈：React 19 + Vite + TypeScript，Capacitor 8 打包 Android，Tauri 2 打包桌面端。

## 打包

```bash
npm run android:apk   # Android debug APK
npm run android:aab   # Android release AAB（需要 ~/.voicepro/keystore.properties）
npm run tauri:dev     # 桌面端开发（需要 Rust 与 WebKitGTK）
npm run tauri:build   # 桌面端安装包
npm run icons         # 从 docs/brand 重新生成图标与启动屏
```

## 文档

- [产品文档](docs/PRODUCT.md)
- [发布与上架指南](docs/RELEASE.md)
- [商店文案](docs/store-listing.md)
- [隐私政策](docs/privacy-policy.md) / [English](docs/privacy-policy.en.md)，网页版：`public/privacy.html`
- [品牌素材](docs/brand/README.md)

## 隐私

不收集个人信息、不上传音频、无账号、无广告、无追踪。详见隐私政策。
