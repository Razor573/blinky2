use std::path::Path;

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        if ty.is_dir() {
            copy_dir_all(&entry.path(), &dst.join(entry.file_name()))?;
        } else {
            let _ = std::fs::copy(entry.path(), dst.join(entry.file_name()));
        }
    }
    Ok(())
}

fn main() {
    println!("cargo:rerun-if-env-changed=BLINKY_TRANSPORT_MODE");
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=icons/icon.png");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=../../common/python");

    let mode = std::env::var("BLINKY_TRANSPORT_MODE").unwrap_or_else(|_| "development".to_string());
    assert!(
        matches!(
            mode.trim().to_ascii_lowercase().as_str(),
            "" | "dev" | "development" | "release"
        ),
        "Unsupported BLINKY_TRANSPORT_MODE: {mode}. Use development or release."
    );
    println!("cargo:rustc-env=BLINKY_TRANSPORT_MODE={mode}");

    // Sync common/python to target directory if OUT_DIR is present
    if let Ok(out_dir_str) = std::env::var("OUT_DIR") {
        let out_dir = Path::new(&out_dir_str);
        if let Some(target_dir) = out_dir.ancestors().nth(3) {
            let src_python = Path::new("../../common/python");
            if src_python.exists() {
                let dst_python = target_dir.join("common").join("python");
                let _ = copy_dir_all(src_python, &dst_python);
            }
        }
    }

    tauri_build::build()
}
