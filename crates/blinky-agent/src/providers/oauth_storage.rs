use anyhow::{Context, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::RwLock;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    pub expires_at: Option<u64>,
    #[serde(default)]
    pub email: String,
    #[serde(default)]
    pub project_id: String,
    #[serde(default)]
    pub account_id: String,
}

static TOKEN_CACHE: RwLock<Option<HashMap<String, OAuthTokens>>> = RwLock::new(None);

fn storage_file_path() -> PathBuf {
    if let Some(proj) = ProjectDirs::from("com", "blinky", "blinky") {
        let dir = proj.data_local_dir();
        let _ = fs::create_dir_all(dir);
        return dir.join("oauth_tokens.json");
    }
    let fallback = dirs_fallback().join(".blinky");
    let _ = fs::create_dir_all(&fallback);
    fallback.join("oauth_tokens.json")
}

fn dirs_fallback() -> PathBuf {
    #[cfg(windows)]
    {
        std::env::var("APPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }
}

pub fn get_provider_tokens(provider: &str) -> Option<OAuthTokens> {
    {
        let cache = TOKEN_CACHE.read().ok()?;
        if let Some(map) = cache.as_ref() {
            return map.get(provider).cloned();
        }
    }

    let path = storage_file_path();
    if !path.exists() {
        return None;
    }

    let data = fs::read_to_string(&path).ok()?;
    let map: HashMap<String, OAuthTokens> = serde_json::from_str(&data).ok()?;
    let result = map.get(provider).cloned();

    if let Ok(mut cache) = TOKEN_CACHE.write() {
        *cache = Some(map);
    }

    result
}

pub fn set_provider_tokens(provider: &str, tokens: OAuthTokens) -> Result<()> {
    let path = storage_file_path();
    let mut map: HashMap<String, OAuthTokens> = if path.exists() {
        let data = fs::read_to_string(&path).unwrap_or_default();
        serde_json::from_str(&data).unwrap_or_default()
    } else {
        HashMap::new()
    };

    map.insert(provider.to_string(), tokens);
    let serialized = serde_json::to_string_pretty(&map)?;
    fs::write(&path, serialized).context("Failed to write OAuth tokens to local storage")?;

    if let Ok(mut cache) = TOKEN_CACHE.write() {
        *cache = Some(map);
    }

    Ok(())
}

pub fn delete_provider_tokens(provider: &str) -> Result<()> {
    let path = storage_file_path();
    if !path.exists() {
        return Ok(());
    }

    let data = fs::read_to_string(&path).unwrap_or_default();
    let mut map: HashMap<String, OAuthTokens> = serde_json::from_str(&data).unwrap_or_default();
    map.remove(provider);

    let serialized = serde_json::to_string_pretty(&map)?;
    fs::write(&path, serialized)?;

    if let Ok(mut cache) = TOKEN_CACHE.write() {
        *cache = Some(map);
    }

    Ok(())
}
