//! Build script: make sure `frontend/dist` exists before `rust-embed` expands,
//! and re-run embedding whenever the built frontend changes.
//!
//! `rust-embed` is configured with `debug-embed` disabled, so:
//!   * release builds embed the directory at compile time;
//!   * debug builds read it from disk at request time.
//!
//! Either way the folder must exist, otherwise the derive macro fails to
//! compile. When the frontend has not been built yet we materialise a minimal
//! placeholder page so `cargo check` / `cargo test` / `cargo build` still work.

use std::fs;
use std::path::Path;
use std::path::PathBuf;

const PLACEHOLDER: &str = r#"<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AI Search Platform</title>
</head>
<body>
<main>
<h1>前端尚未构建</h1>
<p>请先运行 <code>make frontend</code> 或 <code>pnpm -C frontend install &amp;&amp; pnpm -C frontend build</code>，然后重新编译。</p>
</main>
</body>
</html>
"#;

fn main() {
    // Re-run when the embedding source changes. Also re-run on the source tree
    // so config-only edits do not silently use stale embedded assets.
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=frontend/dist");
    println!("cargo:rerun-if-changed=frontend/src");
    println!("cargo:rerun-if-changed=frontend/index.html");
    println!("cargo:rerun-if-changed=frontend/public");
    println!("cargo:rerun-if-changed=frontend/vite.config.ts");
    println!("cargo:rerun-if-changed=frontend/package.json");

    let manifest_dir = match std::env::var("CARGO_MANIFEST_DIR") {
        Ok(dir) => PathBuf::from(dir),
        Err(_) => return,
    };

    let dist = manifest_dir.join("frontend").join("dist");
    if !dist.exists()
        && let Err(err) = fs::create_dir_all(&dist)
    {
        println!("cargo:warning=无法创建 frontend/dist: {err}");
        return;
    }

    let index = dist.join("index.html");
    if !index.exists() {
        if let Err(err) = fs::write(&index, PLACEHOLDER) {
            println!("cargo:warning=无法写入占位 index.html: {err}");
        } else {
            println!(
                "cargo:warning=frontend/dist 缺少构建产物，已写入占位页；请运行 `make frontend` 构建真实前端"
            );
        }
    }

    ensure_not_empty(&dist);
}

fn ensure_not_empty(dist: &Path) {
    if fs::read_dir(dist)
        .map(|mut it| it.next().is_some())
        .unwrap_or(false)
    {
        return;
    }
    let _ = fs::write(dist.join("index.html"), PLACEHOLDER);
}
