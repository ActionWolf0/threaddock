use std::path::PathBuf;
use std::process::Command;

pub fn copy_text(value: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|error| format!("Failed to access clipboard: {error}"))?;
    clipboard
        .set_text(value.to_string())
        .map_err(|error| format!("Failed to copy text to the clipboard: {error}"))
}

pub fn reveal_path(path: &str) -> Result<(), String> {
    let target = PathBuf::from(path.trim());
    if target.as_os_str().is_empty() {
        return Err("Path is required.".to_string());
    }

    if !target.exists() {
        return Err(format!("Path does not exist: {}", target.display()));
    }

    let status = if cfg!(target_os = "windows") {
        let mut command = Command::new("explorer.exe");
        if target.is_file() {
            command.arg(format!("/select,\"{}\"", target.display()));
        } else {
            command.arg(&target);
        }
        command.status()
    } else if cfg!(target_os = "macos") {
        let mut command = Command::new("open");
        if target.is_file() {
            command.arg("-R").arg(&target);
        } else {
            command.arg(&target);
        }
        command.status()
    } else {
        let parent = if target.is_dir() {
            target.clone()
        } else {
            target
                .parent()
                .map(PathBuf::from)
                .unwrap_or_else(|| target.clone())
        };
        Command::new("xdg-open").arg(parent).status()
    }
    .map_err(|error| format!("Failed to reveal {}: {error}", target.display()))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "Reveal command exited unsuccessfully for {}.",
            target.display()
        ))
    }
}
