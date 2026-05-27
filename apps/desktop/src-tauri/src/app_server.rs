use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    thread,
};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::json;

use crate::cache;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppServerThread {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub preview: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub cwd: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default)]
    pub thread_source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListResponse {
    data: Vec<AppServerThread>,
    #[serde(default)]
    next_cursor: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadListParams<'a> {
    archived: bool,
    limit: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    cursor: Option<&'a str>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ThreadActionParams<'a> {
    thread_id: &'a str,
}

pub fn list_threads(archived: bool) -> Result<Vec<AppServerThread>, String> {
    let mut threads = Vec::new();
    let mut cursor: Option<String> = None;

    loop {
        let response: ThreadListResponse = request(
            "thread/list",
            &ThreadListParams {
                archived,
                limit: 200,
                cursor: cursor.as_deref(),
            },
        )?;

        threads.extend(response.data);

        if let Some(next_cursor) = response.next_cursor {
            cursor = Some(next_cursor);
        } else {
            return Ok(threads);
        }
    }
}

pub fn archive_thread(thread_id: &str) -> Result<(), String> {
    let _: serde_json::Value = request("thread/archive", &ThreadActionParams { thread_id })?;
    Ok(())
}

pub fn unarchive_thread(thread_id: &str) -> Result<(), String> {
    let _: serde_json::Value = request("thread/unarchive", &ThreadActionParams { thread_id })?;
    Ok(())
}

fn request<T, P>(method: &str, params: &P) -> Result<T, String>
where
    T: DeserializeOwned,
    P: Serialize,
{
    let mut child = spawn_app_server()?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Failed to capture Codex App Server stdin.".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture Codex App Server stdout.".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Failed to capture Codex App Server stderr.".to_string())?;

    let stderr_handle = thread::spawn(move || {
        let reader = BufReader::new(stderr);
        reader
            .lines()
            .map_while(Result::ok)
            .collect::<Vec<_>>()
            .join("\n")
    });

    let request_id = 2_u64;
    let initialize = json!({
      "id": 1,
      "method": "initialize",
      "params": {
        "clientInfo": {
          "name": "ThreadDock",
          "version": env!("CARGO_PKG_VERSION"),
        },
        "capabilities": null,
      }
    });
    let request = json!({
      "id": request_id,
      "method": method,
      "params": params,
    });

    writeln!(stdin, "{initialize}")
        .map_err(|error| format!("Failed to initialize Codex App Server: {error}"))?;
    writeln!(stdin, "{request}")
        .map_err(|error| format!("Failed to send {method} request to Codex App Server: {error}"))?;
    stdin
        .flush()
        .map_err(|error| format!("Failed to flush Codex App Server input: {error}"))?;

    let reader = BufReader::new(stdout);
    for line_result in reader.lines() {
        let line = line_result.map_err(|error| {
            format!("Failed to read Codex App Server output for {method}: {error}")
        })?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        let value: serde_json::Value = match serde_json::from_str(trimmed) {
            Ok(value) => value,
            Err(error) => {
                log::warn!("Skipping non-JSON app-server message while handling {method}: {error}");
                continue;
            }
        };

        if value.get("id") != Some(&json!(request_id)) {
            continue;
        }

        if let Some(error) = value.get("error") {
            let stderr_output = shutdown_child(&mut child, stdin, stderr_handle);
            return Err(format_request_error(method, error, &stderr_output));
        }

        if let Some(result) = value.get("result") {
            let parsed = serde_json::from_value::<T>(result.clone()).map_err(|error| {
                format!("Failed to parse Codex App Server {method} response: {error}")
            })?;
            let _ = shutdown_child(&mut child, stdin, stderr_handle);
            return Ok(parsed);
        }
    }

    let status = child
        .wait()
        .map_err(|error| format!("Failed waiting for Codex App Server {method}: {error}"))?;
    let stderr_output = stderr_handle
        .join()
        .unwrap_or_else(|_| "Failed to join Codex App Server stderr reader.".to_string());

    Err(format!(
        "Codex App Server {method} exited before returning a response (exit {}).{}",
        status
            .code()
            .map_or_else(|| "unknown".to_string(), |code| code.to_string()),
        format_stderr(&stderr_output)
    ))
}

fn spawn_app_server() -> Result<std::process::Child, String> {
    let codex_home_override = cache::load_app_preferences()
        .ok()
        .and_then(|preferences| preferences.codex_home_override);
    let mut command = if cfg!(target_os = "windows") {
        let mut command = Command::new("cmd.exe");
        command.arg("/d").arg("/c");

        if let Some(app_data) = std::env::var_os("APPDATA") {
            let candidate = PathBuf::from(app_data).join("npm").join("codex.cmd");
            if candidate.exists() {
                command.arg(candidate);
            } else {
                command.arg("codex");
            }
        } else {
            command.arg("codex");
        }

        command.arg("app-server");
        command
    } else {
        let mut command = Command::new("codex");
        command.arg("app-server");
        command
    };

    if let Ok(cwd) = std::env::current_dir() {
        command.current_dir(cwd);
    }

    if let Some(codex_home_override) = codex_home_override {
        command.env("CODEX_HOME", codex_home_override);
    }

    #[cfg(target_os = "windows")]
    command.creation_flags(CREATE_NO_WINDOW);

    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Failed to launch Codex App Server: {error}"))
}

fn shutdown_child(
    child: &mut std::process::Child,
    stdin: std::process::ChildStdin,
    stderr_handle: thread::JoinHandle<String>,
) -> String {
    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    stderr_handle
        .join()
        .unwrap_or_else(|_| "Failed to join Codex App Server stderr reader.".to_string())
}

fn format_request_error(method: &str, error: &serde_json::Value, stderr_output: &str) -> String {
    let message = error
        .get("message")
        .and_then(|value| value.as_str())
        .unwrap_or("Unknown Codex App Server error.");

    format!(
        "Codex App Server {method} failed: {message}.{}",
        format_stderr(stderr_output)
    )
}

fn format_stderr(stderr_output: &str) -> String {
    let trimmed = stderr_output.trim();
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("\n{trimmed}")
    }
}
