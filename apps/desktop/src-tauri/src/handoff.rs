use std::{
    fs::{self, File},
    io::{Cursor, Write},
    path::{Path, PathBuf},
};

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use chrono::Utc;
use pbkdf2::pbkdf2_hmac;
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use walkdir::WalkDir;
use zip::{write::FileOptions, CompressionMethod, ZipWriter};

use crate::backup::{
    self, BackupImportCollisionMode, BackupImportRequest, BackupImportRestoreMode,
    BackupPreviewRequest,
};

const APP_DIR_NAME: &str = "ThreadDock";
const HANDOFF_DIR_NAME: &str = "handoff-staging";
const HANDOFF_EXTENSION: &str = ".threaddock-handoff";
const HANDOFF_FORMAT_VERSION: u32 = 1;
const HANDOFF_MAGIC: &[u8] = b"THREADDOCK-HANDOFF-V1\n";
const HANDOFF_ALGORITHM: &str = "AES-256-GCM";
const HANDOFF_KDF: &str = "PBKDF2-HMAC-SHA256";
const HANDOFF_KDF_ITERATIONS: u32 = 210_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateHandoffRequest {
    pub artifact_path: String,
    #[serde(default)]
    pub destination_dir: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffRecord {
    pub handoff_id: String,
    pub label: String,
    pub source_artifact_path: String,
    pub target_path: String,
    pub original_artifact_name: String,
    pub created_at: String,
    pub artifact_bytes: u64,
    pub encrypted_bytes: u64,
    pub backup_sha256: String,
    pub thread_count: usize,
    pub total_bytes: u64,
    pub recovery_phrase: String,
    pub algorithm: String,
    pub kdf: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHandoffRequest {
    pub handoff_path: String,
    pub passphrase: String,
    pub collision_mode: BackupImportCollisionMode,
    pub restore_mode: BackupImportRestoreMode,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewHandoffRequest {
    pub handoff_path: String,
    pub passphrase: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HandoffPreviewRecord {
    pub handoff_path: String,
    pub label: String,
    pub original_artifact_name: String,
    pub created_at: String,
    pub artifact_bytes: u64,
    pub backup_sha256: String,
    pub thread_count: usize,
    pub thread_ids: Vec<String>,
    pub total_bytes: u64,
    pub algorithm: String,
    pub kdf: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportHandoffResult {
    pub handoff_path: String,
    pub staged_artifact_path: String,
    pub imported_count: usize,
    pub imported_thread_ids: Vec<String>,
    pub skipped_count: usize,
    pub skipped_thread_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandoffHeader {
    handoff_format_version: u32,
    handoff_id: String,
    created_at: String,
    threaddock_version: String,
    label: String,
    source_artifact_name: String,
    source_artifact_path: String,
    artifact_bytes: u64,
    backup_sha256: String,
    thread_count: usize,
    total_rollout_bytes: u64,
    algorithm: String,
    kdf: String,
    kdf_iterations: u32,
    salt_hex: String,
    nonce_hex: String,
}

pub fn create_secure_handoff(request: CreateHandoffRequest) -> Result<HandoffRecord, String> {
    let artifact_path = PathBuf::from(request.artifact_path.trim());
    if !artifact_path.exists() {
        return Err(format!(
            "Backup artifact {} does not exist.",
            artifact_path.display()
        ));
    }

    let backup_record = backup::preview_backup_artifact(BackupPreviewRequest {
        artifact_path: artifact_path.display().to_string(),
    })?;
    let (artifact_bytes, artifact_name) = stage_backup_payload(&artifact_path)?;
    let label = request
        .label
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| backup_record.label.clone());
    let handoff_id = uuid::Uuid::new_v4().to_string();
    let created_at = Utc::now().to_rfc3339();
    let passphrase = request
        .passphrase
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .unwrap_or_else(generate_recovery_phrase);
    let mut salt = [0_u8; 16];
    let mut nonce = [0_u8; 12];
    OsRng.fill_bytes(&mut salt);
    OsRng.fill_bytes(&mut nonce);
    let backup_sha256 = sha256_hex(&artifact_bytes);

    let header = HandoffHeader {
        handoff_format_version: HANDOFF_FORMAT_VERSION,
        handoff_id: handoff_id.clone(),
        created_at: created_at.clone(),
        threaddock_version: env!("CARGO_PKG_VERSION").to_string(),
        label: label.clone(),
        source_artifact_name: artifact_name.clone(),
        source_artifact_path: artifact_path.display().to_string(),
        artifact_bytes: artifact_bytes.len() as u64,
        backup_sha256: backup_sha256.clone(),
        thread_count: backup_record.thread_count,
        total_rollout_bytes: backup_record.total_bytes,
        algorithm: HANDOFF_ALGORITHM.to_string(),
        kdf: HANDOFF_KDF.to_string(),
        kdf_iterations: HANDOFF_KDF_ITERATIONS,
        salt_hex: hex_encode(&salt),
        nonce_hex: hex_encode(&nonce),
    };

    let header_json = serde_json::to_vec(&header)
        .map_err(|error| format!("Failed to serialize handoff header: {error}"))?;
    let ciphertext = encrypt_payload(&artifact_bytes, &passphrase, &salt, &nonce, &header_json)?;
    let destination =
        resolve_handoff_destination(request.destination_dir.as_deref(), &artifact_path)?;
    fs::create_dir_all(&destination).map_err(|error| {
        format!(
            "Failed to create handoff directory {}: {error}",
            destination.display()
        )
    })?;
    let base_name = format!(
        "{}-{}",
        slugify(&label),
        Utc::now().format("%Y%m%dT%H%M%SZ")
    );
    let target_path = next_available_handoff_path(&destination, &base_name);

    let mut output = File::create(&target_path)
        .map_err(|error| format!("Failed to create {}: {error}", target_path.display()))?;
    output
        .write_all(HANDOFF_MAGIC)
        .and_then(|_| output.write_all(&header_json))
        .and_then(|_| output.write_all(b"\n"))
        .and_then(|_| output.write_all(&ciphertext))
        .map_err(|error| format!("Failed to write {}: {error}", target_path.display()))?;

    let encrypted_bytes = fs::metadata(&target_path)
        .map(|metadata| metadata.len())
        .unwrap_or(ciphertext.len() as u64);

    Ok(HandoffRecord {
        handoff_id,
        label,
        source_artifact_path: artifact_path.display().to_string(),
        target_path: target_path.display().to_string(),
        original_artifact_name: artifact_name,
        created_at,
        artifact_bytes: header.artifact_bytes,
        encrypted_bytes,
        backup_sha256,
        thread_count: backup_record.thread_count,
        total_bytes: backup_record.total_bytes,
        recovery_phrase: passphrase,
        algorithm: HANDOFF_ALGORITHM.to_string(),
        kdf: HANDOFF_KDF.to_string(),
    })
}

pub fn preview_secure_handoff(
    request: PreviewHandoffRequest,
) -> Result<HandoffPreviewRecord, String> {
    let handoff_path = PathBuf::from(request.handoff_path.trim());
    if !handoff_path.exists() {
        return Err(format!(
            "Secure handoff {} does not exist.",
            handoff_path.display()
        ));
    }
    let passphrase = request.passphrase.trim();
    if passphrase.is_empty() {
        return Err("A recovery phrase or passphrase is required.".to_string());
    }

    let (header, artifact_bytes) = decrypt_handoff_file(&handoff_path, passphrase)?;
    let handoff_id = validate_handoff_id(&header.handoff_id)?;
    let actual_sha256 = sha256_hex(&artifact_bytes);
    if actual_sha256 != header.backup_sha256 {
        return Err("Secure handoff decrypted but failed checksum verification.".to_string());
    }

    let staging_root = handoff_staging_root()?;
    fs::create_dir_all(&staging_root).map_err(|error| {
        format!(
            "Failed to create handoff staging directory {}: {error}",
            staging_root.display()
        )
    })?;
    let staged_artifact_path = staging_root.join(format!(
        "{}-preview-{}",
        handoff_id,
        sanitize_file_name(&header.source_artifact_name)
    ));
    fs::write(&staged_artifact_path, artifact_bytes).map_err(|error| {
        format!(
            "Failed to stage decrypted handoff artifact {}: {error}",
            staged_artifact_path.display()
        )
    })?;

    let preview = (|| {
        let backup_record = backup::preview_backup_artifact(BackupPreviewRequest {
            artifact_path: staged_artifact_path.display().to_string(),
        })?;
        Ok(HandoffPreviewRecord {
            handoff_path: handoff_path.display().to_string(),
            label: header.label.clone(),
            original_artifact_name: header.source_artifact_name.clone(),
            created_at: header.created_at.clone(),
            artifact_bytes: header.artifact_bytes,
            backup_sha256: header.backup_sha256.clone(),
            thread_count: backup_record.thread_count,
            thread_ids: backup_record.thread_ids,
            total_bytes: backup_record.total_bytes,
            algorithm: header.algorithm.clone(),
            kdf: header.kdf.clone(),
        })
    })();

    if let Err(error) = fs::remove_file(&staged_artifact_path) {
        log::warn!(
            "Failed to remove staged handoff preview artifact {}: {error}",
            staged_artifact_path.display()
        );
    }

    preview
}

pub fn import_secure_handoff(request: ImportHandoffRequest) -> Result<ImportHandoffResult, String> {
    let handoff_path = PathBuf::from(request.handoff_path.trim());
    if !handoff_path.exists() {
        return Err(format!(
            "Secure handoff {} does not exist.",
            handoff_path.display()
        ));
    }
    let passphrase = request.passphrase.trim();
    if passphrase.is_empty() {
        return Err("A recovery phrase or passphrase is required.".to_string());
    }

    let (header, artifact_bytes) = decrypt_handoff_file(&handoff_path, passphrase)?;
    let handoff_id = validate_handoff_id(&header.handoff_id)?;
    let actual_sha256 = sha256_hex(&artifact_bytes);
    if actual_sha256 != header.backup_sha256 {
        return Err("Secure handoff decrypted but failed checksum verification.".to_string());
    }

    let staging_root = handoff_staging_root()?;
    fs::create_dir_all(&staging_root).map_err(|error| {
        format!(
            "Failed to create handoff staging directory {}: {error}",
            staging_root.display()
        )
    })?;
    let staged_artifact_path = staging_root.join(format!(
        "{}-{}",
        handoff_id,
        sanitize_file_name(&header.source_artifact_name)
    ));
    fs::write(&staged_artifact_path, artifact_bytes).map_err(|error| {
        format!(
            "Failed to stage decrypted handoff artifact {}: {error}",
            staged_artifact_path.display()
        )
    })?;

    let import_result = backup::import_backup_artifact(BackupImportRequest {
        artifact_path: staged_artifact_path.display().to_string(),
        collision_mode: request.collision_mode,
        restore_mode: request.restore_mode,
    });

    if let Err(error) = fs::remove_file(&staged_artifact_path) {
        log::warn!(
            "Failed to remove staged handoff artifact {}: {error}",
            staged_artifact_path.display()
        );
    }

    let import_result = import_result?;
    Ok(ImportHandoffResult {
        handoff_path: handoff_path.display().to_string(),
        staged_artifact_path: staged_artifact_path.display().to_string(),
        imported_count: import_result.imported_count,
        imported_thread_ids: import_result.imported_thread_ids,
        skipped_count: import_result.skipped_count,
        skipped_thread_ids: import_result.skipped_thread_ids,
    })
}

fn encrypt_payload(
    payload: &[u8],
    passphrase: &str,
    salt: &[u8],
    nonce: &[u8],
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    let key = derive_key(passphrase, salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Failed to initialize handoff cipher.".to_string())?;
    cipher
        .encrypt(Nonce::from_slice(nonce), Payload { msg: payload, aad })
        .map_err(|_| "Failed to encrypt secure handoff payload.".to_string())
}

fn decrypt_handoff_file(path: &Path, passphrase: &str) -> Result<(HandoffHeader, Vec<u8>), String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Failed to read {}: {error}", path.display()))?;
    if !bytes.starts_with(HANDOFF_MAGIC) {
        return Err(format!(
            "{} is not a ThreadDock secure handoff.",
            path.display()
        ));
    }
    let payload = &bytes[HANDOFF_MAGIC.len()..];
    let header_end = payload
        .iter()
        .position(|value| *value == b'\n')
        .ok_or_else(|| "Secure handoff header is malformed.".to_string())?;
    let header_json = &payload[..header_end];
    let ciphertext = &payload[(header_end + 1)..];
    let header = serde_json::from_slice::<HandoffHeader>(header_json)
        .map_err(|error| format!("Failed to parse secure handoff header: {error}"))?;
    if header.handoff_format_version != HANDOFF_FORMAT_VERSION {
        return Err(format!(
            "Unsupported secure handoff version {}.",
            header.handoff_format_version
        ));
    }
    if header.algorithm != HANDOFF_ALGORITHM
        || header.kdf != HANDOFF_KDF
        || header.kdf_iterations != HANDOFF_KDF_ITERATIONS
    {
        return Err("Unsupported secure handoff encryption settings.".to_string());
    }
    let salt = hex_decode(&header.salt_hex)?;
    let nonce = hex_decode(&header.nonce_hex)?;
    if salt.len() != 16 || nonce.len() != 12 {
        return Err("Secure handoff encryption parameters are malformed.".to_string());
    }
    let key = derive_key(passphrase, &salt);
    let cipher = Aes256Gcm::new_from_slice(&key)
        .map_err(|_| "Failed to initialize handoff cipher.".to_string())?;
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: ciphertext,
                aad: header_json,
            },
        )
        .map_err(|_| "Recovery phrase rejected or secure handoff is corrupted.".to_string())?;
    Ok((header, plaintext))
}

fn derive_key(passphrase: &str, salt: &[u8]) -> [u8; 32] {
    let mut key = [0_u8; 32];
    pbkdf2_hmac::<Sha256>(
        passphrase.as_bytes(),
        salt,
        HANDOFF_KDF_ITERATIONS,
        &mut key,
    );
    key
}

fn stage_backup_payload(artifact_path: &Path) -> Result<(Vec<u8>, String), String> {
    if artifact_path.is_file() {
        let bytes = fs::read(artifact_path).map_err(|error| {
            format!(
                "Failed to read backup artifact {}: {error}",
                artifact_path.display()
            )
        })?;
        let artifact_name = artifact_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("backup.threaddock-backup.zip")
            .to_string();
        return Ok((bytes, artifact_name));
    }

    if artifact_path.is_dir() {
        let folder_name = artifact_path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("backup");
        let mut writer = ZipWriter::new(Cursor::new(Vec::<u8>::new()));
        let options = FileOptions::default().compression_method(CompressionMethod::Deflated);

        for entry in WalkDir::new(artifact_path) {
            let entry = entry.map_err(|error| {
                format!(
                    "Failed to inspect backup artifact {}: {error}",
                    artifact_path.display()
                )
            })?;
            let path = entry.path();
            let relative = path.strip_prefix(artifact_path).map_err(|error| {
                format!(
                    "Failed to normalize backup artifact {}: {error}",
                    artifact_path.display()
                )
            })?;
            if relative.as_os_str().is_empty() {
                continue;
            }

            let relative_name = relative.to_string_lossy().replace('\\', "/");
            if path.is_dir() {
                writer
                    .add_directory(format!("{relative_name}/"), options)
                    .map_err(|error| {
                        format!(
                            "Failed to stage handoff directory {}: {error}",
                            path.display()
                        )
                    })?;
                continue;
            }

            writer.start_file(relative_name, options).map_err(|error| {
                format!("Failed to stage handoff file {}: {error}", path.display())
            })?;
            let mut file = File::open(path).map_err(|error| {
                format!("Failed to open handoff file {}: {error}", path.display())
            })?;
            std::io::copy(&mut file, &mut writer).map_err(|error| {
                format!("Failed to package handoff file {}: {error}", path.display())
            })?;
        }

        let cursor = writer
            .finish()
            .map_err(|error| format!("Failed to finalize secure handoff payload: {error}"))?;
        return Ok((cursor.into_inner(), format!("{folder_name}.zip")));
    }

    Err(format!(
        "{} is neither a backup file nor a backup folder.",
        artifact_path.display()
    ))
}

fn resolve_handoff_destination(
    destination_dir: Option<&str>,
    artifact_path: &Path,
) -> Result<PathBuf, String> {
    if let Some(path) = destination_dir {
        let candidate = PathBuf::from(path.trim());
        if !candidate.as_os_str().is_empty() {
            return Ok(candidate);
        }
    }

    artifact_path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "Unable to resolve a secure handoff destination.".to_string())
}

fn next_available_handoff_path(parent: &Path, base_name: &str) -> PathBuf {
    let path = parent.join(format!("{base_name}{HANDOFF_EXTENSION}"));
    if !path.exists() {
        return path;
    }

    let mut index = 2usize;
    loop {
        let candidate = parent.join(format!("{base_name}-{index}{HANDOFF_EXTENSION}"));
        if !candidate.exists() {
            return candidate;
        }
        index += 1;
    }
}

fn handoff_staging_root() -> Result<PathBuf, String> {
    let root = dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .ok_or_else(|| "Unable to resolve local app data for handoff staging.".to_string())?;
    Ok(root.join(APP_DIR_NAME).join(HANDOFF_DIR_NAME))
}

fn generate_recovery_phrase() -> String {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let raw = hex_encode(&bytes).to_ascii_uppercase();
    raw.as_bytes()
        .chunks(4)
        .map(|chunk| std::str::from_utf8(chunk).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("-")
}

fn validate_handoff_id(value: &str) -> Result<String, String> {
    uuid::Uuid::parse_str(value)
        .map(|uuid| uuid.to_string())
        .map_err(|_| "Secure handoff header contains an invalid handoff id.".to_string())
}

fn sanitize_file_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "received.threaddock-backup.zip".to_string()
    } else {
        sanitized
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;

    for character in value.chars() {
        if character.is_ascii_alphanumeric() {
            slug.push(character.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-');
    if trimmed.is_empty() {
        "secure-handoff".to_string()
    } else {
        trimmed.to_string()
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut output = String::with_capacity(digest.len() * 2);
    for value in digest {
        output.push_str(&format!("{value:02x}"));
    }
    output
}

fn hex_encode(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for value in bytes {
        output.push_str(&format!("{value:02x}"));
    }
    output
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("Secure handoff header contains malformed hex data.".to_string());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    for index in (0..value.len()).step_by(2) {
        let byte = u8::from_str_radix(&value[index..index + 2], 16)
            .map_err(|_| "Secure handoff header contains invalid hex data.".to_string())?;
        bytes.push(byte);
    }
    Ok(bytes)
}
