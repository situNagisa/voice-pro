// 桌面端入口：前端仍复用 dist 里的 Web 应用。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("音准镜启动失败");
}
