# 音准镜 发布与上架指南

本文汇总各平台的构建方法、签名配置、商店账号与合规要求、上架检查清单。命令里的 `$` 表示在项目根目录 `/home/nagisa/voice-pro` 执行。

## 0. 版本与标识

| 项目 | 值 |
| --- | --- |
| 应用名 | 音准镜（Voice Pro） |
| applicationId / Bundle ID | `com.voicepro.app` |
| 当前版本 | 0.3.0 |
| Android versionCode | 3 |
| 最低 Android | API 24（Android 7.0） |
| 目标 Android | API 36（Android 16） |
| 桌面 identifier | `com.voicepro.app` |

版本号出现在三处，发版时一起改：

- `package.json` 的 `version`
- `android/app/build.gradle` 的 `versionName` / `versionCode`（每次上传商店 versionCode 必须 +1）
- `src-tauri/tauri.conf.json` 的 `version`

## 1. 图标与启动屏

品牌母版在 `docs/brand/`：

- `icon.svg`：圆角方形主图标（Web / 旧版 Android / Tauri）
- `icon-round.svg`：圆形图标
- `icon-maskable.svg`：PWA maskable（满幅背景）
- `icon-foreground.svg`：Android 自适应图标前景（内容位于安全区）
- `icon-background.svg`：Android 自适应图标背景（深色渐变）
- `icon-1024.png`：1024×1024 预览图
- `icon-round-512.png`：圆形预览

重新生成（需要 `rsvg-convert`，Arch 包名 `librsvg`）：

```bash
npm run icons
```

生成位置：

- `public/`：`icon-192.png`、`icon-512.png`、maskable 192/512、`apple-touch-icon.png`、`favicon.ico`、SVG
- `android/app/src/main/res/mipmap-*`：`ic_launcher.png`、`ic_launcher_round.png`、`ic_launcher_foreground.png`、`ic_launcher_background.png`
- `android/app/src/main/res/drawable*/splash.png`：各方向、各密度启动屏
- `android/app/src/main/res/drawable/ic_launcher_monochrome.xml`：Android 13 主题图标
- `src-tauri/icons/`：Tauri / Windows Store 所需 PNG、ICO、ICNS

Android 自适应图标配置在 `mipmap-anydpi-v26/` 与 `mipmap-anydpi-v33/`，背景是深色渐变（`drawable/ic_launcher_background.xml`）。启动屏文字使用文泉驿微米黑，生成环境没有中文字体时脚本会提示。

## 2. Android 发布

### 2.1 上传密钥

密钥已生成在仓库之外，**不要提交到 Git**：

| 项目 | 值 |
| --- | --- |
| 密钥库 | `~/.voicepro/voicepro-upload.jks`（PKCS12，RSA 4096，有效期 10000 天） |
| 别名 | `voicepro` |
| 配置 | `~/.voicepro/keystore.properties`（权限 600） |
| 证书 SHA-256 | `B7:30:FC:9F:4B:22:75:97:59:2B:A6:45:C2:27:7B:BF:5C:F5:FF:B5:0F:4A:F6:B3:9E:60:69:09:C8:42:D6:B6` |

`android/app/build.gradle` 会读取 `~/.voicepro/keystore.properties`；文件不存在时不会创建 release 签名配置，**debug 构建不受影响**，release 构建则产出未签名包。

重新生成（如果现有密钥无效或需要更换 DN；更换后 Play 上已发布应用无法用新密钥覆盖，除非使用 Play App Signing 的“重置上传密钥”）：

```bash
mkdir -p ~/.voicepro && chmod 700 ~/.voicepro
keytool -genkeypair -v \
  -keystore ~/.voicepro/voicepro-upload.jks \
  -alias voicepro \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storetype PKCS12 \
  -dname "CN=你的名称, OU=Mobile, O=你的组织, L=城市, ST=省份, C=CN"
```

然后把 `storeFile=voicepro-upload.jks`、`storePassword=...`、`keyAlias=voicepro`、`keyPassword=...` 写入 `~/.voicepro/keystore.properties`。

**务必备份** `voicepro-upload.jks` 和 `keystore.properties` 到离线介质（至少两份）。首次在 Play Console 上传时启用 Play App Signing，Google 保存应用签名密钥，这里的密钥只作为“上传密钥”；上传密钥丢失可以申请重置，应用签名密钥丢失则无法恢复。

### 2.2 构建

```bash
npm run android:aab
```

输出：`android/app/build/outputs/bundle/release/app-release.aab`（Google Play 使用）。

国内商店上传 APK 时：

```bash
npm run build && npx cap sync android
cd android && ./gradlew assembleRelease
```

输出：`android/app/build/outputs/apk/release/app-release.apk`。

检查签名：

```bash
$ANDROID_HOME/build-tools/<版本>/apksigner verify --print-certs \
  android/app/build/outputs/apk/release/app-release.apk
```

本仓库目前没有运行上述构建，首次发布前需要在有 Android SDK 的机器上实际构建并安装验证。

### 2.3 发布相关配置

- `versionName 0.3.0`、`versionCode 3` 已在 `android/app/build.gradle`。
- `allowBackup=false` 且配置了 `data_extraction_rules.xml`：练习录音不进入系统云备份与换机迁移，与隐私政策一致。
- 麦克风权限：`RECORD_AUDIO`、`MODIFY_AUDIO_SETTINGS`；`INTERNET` 仅用于 WebView 加载本地资源。
- Google Play 需要 AAB；targetSdk 36 满足 2026 年 8 月 31 日起的要求。
- 如后续加入原生 `.so`（例如原生 ONNX Runtime），需要确认 16 KB page size 兼容性（Android 15+ 设备要求）。

## 3. 桌面端（Tauri 2）

脚手架在 `src-tauri/`，没有安装 Rust，只写好配置：

- `tauri.conf.json`：productName `音准镜`、identifier `com.voicepro.app`、主窗口 1280×860、最小 1024×700、图标路径、bundle 分类 `Music`、publisher `Voice Pro`
- `Cargo.toml` / `build.rs` / `src/main.rs`：最小 Tauri 2 工程，前端复用 `dist/`
- `Info.plist`：macOS `NSMicrophoneUsageDescription`
- `Entitlements.plist`：macOS 麦克风 entitlement（`com.apple.security.device.audio-input`）
- `capabilities/default.json`：主窗口默认能力
- `icons/`：各平台图标
- `tauri.microsoftstore.conf.json`：Microsoft Store 用的离线 WebView2 安装配置

`package.json` 已加 `tauri:dev` / `tauri:build` / `icons` 脚本，并安装 `@tauri-apps/cli`（2.12.x）。

### 3.1 构建命令

```bash
npm run tauri:dev      # 开发，Vite + Tauri 窗口
npm run tauri:build    # 生产构建，产物在 src-tauri/target/release/bundle/
```

说明：浏览器开发时 Vite 用自签名 HTTPS（手机局域网测试麦克风需要）；Tauri 开发时 `vite.config.ts` 检测到 `TAURI_ENV_PLATFORM` 会关闭 basic-ssl，Tauri 窗口走 `http://localhost:5173`（localhost 仍是安全上下文，麦克风可用），因此 `tauri.conf.json` 的 `devUrl` 是 http。

### 3.2 这台 WSL 机器缺什么

当前环境是 WSL 里的 Arch Linux，检查结果：

- 已有：Node 26 / npm 12、Java 21、`rsvg-convert`
- **缺少**：`rustup` / `rustc` / `cargo`；`webkit2gtk-4.1`、`gtk3`、`libsoup3`（`pkg-config` 查不到）；以及编译所需的 `base-devel`、`librsvg`、`patchelf`、`openssl` 等

安装方式（需要你自己执行，本文档不代跑 `sudo`）：

```bash
# Arch / WSL Arch
sudo pacman -S --needed base-devel curl wget file openssl librsvg patchelf \
  webkit2gtk-4.1 gtk3 libsoup3
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
rustup default stable
```

Debian / Ubuntu 对应包：

```bash
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

WSL 注意：

- WSLg 可能拿不到真实麦克风，Linux 包只适合验证界面和构建；麦克风必须在原生 Windows / macOS 上测。
- 在 WSL 里交叉编译 Windows 版不现实，Windows 版请在 Windows 上装 Rust MSVC 工具链后构建。
- Linux 下 WebKitGTK 的 `getUserMedia` 依赖 GStreamer/管道支持；若打包后麦克风不可用，需要在目标发行版上验证 `webkit2gtk-4.1` 的媒体后端。

### 3.3 macOS

- 需要 macOS + Xcode Command Line Tools + rustup。
- `src-tauri/Info.plist` 会被 Tauri 合并进 App Bundle，首次使用麦克风会弹出 `NSMicrophoneUsageDescription` 文案。
- `Entitlements.plist` 提供 `com.apple.security.device.audio-input`。上架 Mac App Store 还需要开启 App Sandbox（`com.apple.security.app-sandbox`）、使用 Apple Distribution 证书和 provisioning profile，并在 App Store Connect 配置 Mac 类别、隐私政策和截图。
- 直接分发（DMG）需要 Developer ID 证书 + 公证（notarization），否则 Gatekeeper 会拦截。
- 没有 Apple Developer 账号时只能本地自签运行，不能分发给别人。

### 3.4 Windows

- 需要 Windows 10/11 + Visual Studio Build Tools（C++ 桌面开发）+ rustup（`stable-x86_64-pc-windows-msvc`）+ WebView2 Runtime（Win11 自带）。
- `npm run tauri:build` 产出 NSIS `.exe` 和 MSI；正式分发建议用代码签名证书，否则 SmartScreen 会提示未知发布者。
- **麦克风权限**：Windows 设置 → 隐私和安全性 → 麦克风，打开“麦克风访问”和“让桌面应用访问麦克风”，并确认音准镜在应用列表中已允许。WebView2 首次调用 `getUserMedia` 时会弹出原生权限提示（部分系统版本会直接沿用系统隐私设置）；若没有声音，先检查系统隐私设置、默认输入设备，以及是否误点了“阻止”。
- 如果打成 MSIX 包，需要在 `AppxManifest.xml` 声明 `<DeviceCapability Name="microphone" />`；当前 Tauri 产物是 EXE/MSI，不涉及该声明。

### 3.5 Microsoft Store

Tauri 2 目前只生成 EXE/MSI 安装器，Microsoft Store 的上架方式是登记一个“EXE 或 MSI 应用”并链接安装器，而不是直接提交 MSIX：

1. 在 Partner Center 注册开发者（2026 年起个人与公司均免注册费），预订应用名称。
2. 使用离线 WebView2 的配置构建：

```bash
npx tauri build --no-bundle
npx tauri bundle --config src-tauri/tauri.microsoftstore.conf.json
```

3. 安装器必须支持静默安装（NSIS 用 `/S`，MSI 用 `/quiet`），并做代码签名。
4. 商店要求 publisher 名称不能与应用产品名相同；`tauri.conf.json` 已设置 `"publisher": "Voice Pro"`，正式提交前改成你的公司/开发者名。

## 4. iOS（后续）

- 需要 macOS + Xcode + CocoaPods；在项目根执行 `npx cap add ios`，再 `npx cap sync ios`。
- 在 Xcode 的 Info 里配置 `NSMicrophoneUsageDescription`（中文文案同桌面端）。
- 需要 Apple Developer Program（$99/年）、App Store Connect 应用记录、隐私营养标签（Data Not Collected）、4+ 年龄分级。
- App Store 中国大陆区上架需要填写有效的 ICP 备案号；App 名称需与备案信息一致。
- 仓库目前没有 `ios/` 目录，这一步尚未开始。

## 5. 各商店账号、费用与审核要点

> 费用与政策会变化，以下为 2026-11 查证结果，提交前以官方页面为准。

### 5.1 Google Play

| 项目 | 要求 |
| --- | --- |
| 账号费 | US$25 一次性注册费 |
| 账号类型 | 个人 / 组织；组织账号需要 D-U-N-S 编号并做企业验证 |
| 个人新账号测试 | 2023-11-13 后创建的个人账号，发布前需至少 12 名测试者连续参与封闭测试 14 天 |
| 目标 API | 2026-08-31 起新应用与更新必须 target Android 16（API 36） |
| 包格式 | 新应用使用 AAB（本仓库 `npm run android:aab`） |
| 合规材料 | 隐私政策 URL、Data safety 表单、内容分级（IARC） |
| 审核注意 | 麦克风属于敏感权限，必须在申请前向用户说明用途；本应用麦克风就是核心功能，但仍建议加应用内说明弹窗；无账号，不需要提供测试账号；不能有误导性描述或隐藏功能 |

费用参考：[Get started with Play Console](https://support.google.com/googleplay/android-developer/answer/6112435)。个人账号测试要求：[App testing requirements](https://support.google.com/googleplay/android-developer/answer/14151465)。目标 API：[Target API level requirements](https://support.google.com/googleplay/android-developer/answer/11926878)。组织账号 D-U-N-S：[Required information](https://support.google.com/googleplay/android-developer/answer/13628312)。隐私政策与 Data safety：[User Data](https://support.google.com/googleplay/android-developer/answer/10144311)、[Data safety](https://support.google.com/googleplay/android-developer/answer/10787469)。

### 5.2 Apple App Store

| 项目 | 要求 |
| --- | --- |
| 账号费 | US$99/年（Apple Developer Program） |
| 公司账号 | 需要 D-U-N-S 编号；个人账号不需要 |
| 材料 | App Privacy（Data Not Collected）、隐私政策 URL、4+ 年龄分级、审核备注 |
| 麦克风 | Info.plist 必须提供 `NSMicrophoneUsageDescription`，否则调用麦克风会崩溃/被拒 |
| 中国大陆区 | 需要填写 ICP 备案号，App 名称与备案一致 |
| Mac App Store | 需要 App Sandbox、麦克风 entitlement、签名与 provisioning；审核比 DMG 分发更严格 |
| 审核注意 | 不能要求登录才能体验；本应用无账号；音频文件由用户自行提供，不内置受版权保护的歌曲；说明“仅本地处理、不上传” |

费用：[Apple Developer Program 注册](https://developer.apple.com/programs/enroll/)。中国区 ICP：[App 信息 - App Store Connect 帮助](https://developer.apple.com/cn/help/app-store-connect/reference/app-information/app-information)。Tauri 上架 App Store：[Tauri App Store 指南](https://v2.tauri.app/distribute/app-store/)。

### 5.3 Microsoft Store

| 项目 | 要求 |
| --- | --- |
| 账号费 | 目前个人与公司注册均免费 |
| 提交形式 | 预订 “EXE 或 MSI 应用”，链接离线安装器；不是直接提交 MSIX |
| 安装器 | 必须支持静默安装（NSIS `/S`）、离线 WebView2、代码签名 |
| 命名 | publisher 不能与产品名相同 |
| 审核注意 | 首次启动不得崩溃、必须能离线安装依赖；隐私政策建议提供 |

费用与账号：[打开 Microsoft Store 开发者账号](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)。Tauri 具体流程：[Microsoft Store - Tauri](https://v2.tauri.app/distribute/microsoft-store/)。

### 5.4 国内安卓商店（华为、小米、OPPO、vivo、应用宝、荣耀）

国内商店的共同门槛不是“上架费”，而是**主体资质 + 软著 + APP 备案**：

| 项目 | 要求 |
| --- | --- |
| 开发者主体 | 建议公司/个体工商户；多数商店支持个人开发者，但类目、结算和资质限制更多，且软著、备案、开发者实名主体需一致 |
| 软件著作权 | 几乎所有商店要求《计算机软件著作权登记证书》，名称需与应用名一致；应用宝可用“官网 ICP 备案 + 其他商店上架截图”临时替代，软著后补 |
| APP 备案 | 2023-09-01 起新 APP 需完成工信部 APP 备案才能上架；备案由网络接入服务提供者/分发平台通过国家互联网基础资源管理系统提交，备案号形如 `京ICP备xxxxxxxx号-xA` |
| ICP 备案 | 有官网/隐私政策页面托管在国内时，域名需要 ICP 备案；备案主体与开发者、软著主体保持一致 |
| 隐私合规 | 首次启动需展示隐私政策并取得同意（**当前 src/ 中还没有首启隐私弹窗，需要开发同事补**）；权限申请前说明用途；提供权限清单与第三方 SDK 清单（本应用无第三方 SDK） |
| 版权 | 不提供在线曲库，示例曲为本地合成；用户导入自己有权使用的音频；音乐类目可能被要求签版权承诺函 |
| 审核注意 | 应用名称、图标、软著名称、备案名称必须一致；拒绝热更新/动态下发代码；不得强制索取无关权限；隐私政策中的开发者名称、联系方式必须真实可联系 |

参考：

- 工信部《关于开展移动互联网应用程序备案工作的通知》：<https://www.miit.gov.cn/zwgk/zcwj/wjfb/tz/art/2023/art_920db564162e4312916a01bed6540ad8.html>
- 工信部政策解读（2023-09 起新应用先备案再上架）：<https://www.miit.gov.cn/zwgk/zcjd/art/2023/art_39b4f1acc36745b98478e0ec3e07128d.html>
- 小米应用商店上架要求（ICP 主体一致、软著、APP 备案）：<https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1322>
- 小米 APP 备案/名称一致性说明：<https://dev.mi.com/xiaomihyperos/documentation/detail?pId=1796>
- 华为应用市场发布与审核指南：<https://developer.huawei.com/consumer/cn/doc/App/50170/>、<https://developer.huawei.com/consumer/cn/doc/App/agc-help-releaseapkrpk-0000001106463276/>
- OPPO 开放平台应用审核规范：<https://open.oppomobile.com/new/developmentDoc/info?id=10035>
- vivo 开放平台：<https://dev.vivo.com.cn/>
- 腾讯应用宝开放平台：<https://open.qq.com/>

**软著办理**：中国版权保护中心登记本身免费（2017-04-01 起停征登记费），官方审查周期通常为数周到 60 日；代理机构会收服务费。参考：[新华社报道](https://www.xinhuanet.com/zgjx/2017-04/01/c_136176406.htm)、[中国版权保护中心](https://www.ccopyright.com.cn/)。

### 5.5 费用速查

| 平台 | 账号费用 | 备注 |
| --- | --- | --- |
| Google Play | US$25 一次性 | 个人账号需 12 人 × 14 天封测 |
| Apple Developer | US$99/年 | 个人/公司同价，公司需 D-U-N-S |
| Microsoft Store | 免费 | 2026 年起个人与公司均免注册费 |
| 华为/小米/OPPO/vivo/应用宝 | 入驻免费 | 需企业主体、软著、APP 备案；代理与加急另计 |
| 软著官方登记 | 免费 | 代理服务费另计，周期数周至 60 日 |
| APP 备案 | 免费 | 需先有域名/接入商，主体信息一致 |
| 代码签名证书（Windows） | 数百至数千元/年 | 非商店分发时避免 SmartScreen 拦截 |

## 6. 上架检查清单

### 通用

- [ ] 填写 `docs/privacy-policy.md` / `.en.md` / `public/privacy.html` 中的开发者名称、邮箱、地址，并部署到可公开访问的 HTTPS 地址
- [ ] 确认应用名称“音准镜”与软著、APP 备案、商店名称一致
- [ ] 三处版本号一致，Android versionCode 递增
- [ ] 商店图标 512×512、feature graphic 1024×500（Google Play 必填，待制作）
- [ ] 截图按各商店尺寸准备（见 `docs/store-listing.md`）
- [ ] 真机走一遍：选示例歌 → 授权麦克风 → 练唱 → 暂停回看 → 报告 → 删除记录
- [ ] 断网状态走一遍核心流程（模型、示例曲、界面均本地）
- [ ] 检查隐私政策与实际行为一致（不上传、不收集、无 SDK）
- [ ] 准备审核备注（无账号、操作路径、麦克风用途）

### Google Play

- [ ] AAB 已用上传密钥签名，上传后确认 Play App Signing
- [ ] Data safety 填“不收集/不共享”
- [ ] 内容分级问卷完成
- [ ] 目标 API 36
- [ ] 个人账号完成 12 人 × 14 天封闭测试（如适用）
- [ ] 麦克风权限使用说明/应用内提示

### 国内安卓商店

- [ ] 企业/个体开发者实名认证完成
- [ ] 软著证书名称与应用名一致
- [ ] APP 备案完成，备案号可填
- [ ] 官网/隐私页 ICP 备案完成
- [ ] 首启隐私政策弹窗与同意记录（**待开发**）
- [ ] 权限申请前说明用途（麦克风）
- [ ] 隐私合规检测（OPPO/华为等平台提供检测工具）
- [ ] 版权承诺函（如类目要求）

### App Store / Mac App Store

- [ ] Apple Developer Program 已加入
- [ ] App Privacy 填“Data Not Collected”
- [ ] `NSMicrophoneUsageDescription` 已配置
- [ ] 中国大陆区 ICP 备案号已填
- [ ] Mac 版 App Sandbox + 麦克风 entitlement + 签名/公证
- [ ] 按 6.9 英寸等要求重新截图

### 桌面端

- [ ] Windows：WebView2 离线安装、静默安装 `/S`、代码签名
- [ ] Windows：系统麦克风隐私设置可用
- [ ] macOS：Info.plist 麦克风文案、entitlement、公证或 App Store 签名
- [ ] Linux：webkit2gtk 媒体后端可用、AppImage/deb 测试
- [ ] Microsoft Store：publisher 名称不与产品名相同

## 7. 必须由用户提供或决定的事项

1. **开发者主体**：个人还是公司？公司名称、营业执照、注册地址（影响 Google Play 组织账号、Apple 公司账号、国内商店与软著/备案主体）。
2. **联系方式**：公开邮箱（隐私政策、商店审核、用户删除数据请求），建议专用邮箱而非私人邮箱。
3. **账号与费用**：Google Play（$25）、Apple Developer（$99/年）、国内各商店开发者账号；是否注册公司以获取 D-U-N-S。
4. **域名与备案**：隐私政策页面托管地址；国内分发需要 ICP 备案 + APP 备案，备案主体需与开发者一致。
5. **软著**：以哪个主体、哪个软件名称申请（建议“音准镜”），是否走代理加急。
6. **商店素材**：feature graphic、Microsoft Store 海报/徽标、按 App Store 尺寸重拍的截图；是否使用现有 `docs/screenshots/`。
7. **隐私合规开发**：首启隐私政策弹窗、麦克风权限说明弹窗（属于 `src/`，需开发同事实现）。
8. **桌面签名**：Windows 代码签名证书、Apple Developer ID / Mac App Store 分发方式。
9. **法务**：隐私政策最终文本、儿童年龄口径（中国 14 岁 / 美国 13 岁）、是否需要用户协议（EULA）。
