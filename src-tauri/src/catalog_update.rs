use crate::{catalog, managed, models::now};
use base64::{engine::general_purpose::STANDARD, Engine};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Envelope {
    payload: String,
    signature: String,
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Payload {
    schema_version: u32,
    revision: u64,
    min_app_version: String,
    apps: Vec<Value>,
}
fn key() -> Result<[u8; 32], String> {
    let raw = option_env!("APPDOCK_CATALOG_PUBLIC_KEY")
        .ok_or("Ключ публикации каталога не настроен в этой сборке")?;
    STANDARD
        .decode(raw)
        .map_err(|e| e.to_string())?
        .try_into()
        .map_err(|_| "Ключ Ed25519 должен содержать 32 байта".into())
}
fn validate(bytes: &[u8], key: &[u8; 32]) -> Result<Payload, String> {
    if bytes.len() > 4_000_000 {
        return Err("Каталог слишком большой".into());
    }
    let e: Envelope = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let raw = STANDARD
        .decode(e.payload)
        .map_err(|_| "Повреждён payload каталога")?;
    let sig = STANDARD
        .decode(e.signature)
        .map_err(|_| "Повреждена подпись")?;
    let sig = Signature::from_slice(&sig).map_err(|_| "Неверный размер подписи")?;
    VerifyingKey::from_bytes(key)
        .map_err(|_| "Неверный публичный ключ")?
        .verify_strict(&raw, &sig)
        .map_err(|_| "Цифровая подпись каталога недействительна")?;
    let p: Payload = serde_json::from_slice(&raw).map_err(|e| format!("Схема каталога: {e}"))?;
    if p.schema_version != 1
        || p.revision == 0
        || crate::system::numeric_version_order(env!("CARGO_PKG_VERSION"), &p.min_app_version)
            .is_none_or(|o| o.is_lt())
    {
        return Err("Каталог несовместим с этой версией AppDock".into());
    }
    let bundled = catalog::bundled();
    if p.apps.len() != bundled.len() {
        return Err("Обновление не может добавлять или удалять поддерживаемые адаптеры".into());
    }
    let mut seen = std::collections::HashSet::new();
    for a in &p.apps {
        let id = a["id"].as_str().ok_or("Нет ID продукта")?;
        if !seen.insert(id) {
            return Err("Повтор ID".into());
        }
        let original = bundled
            .iter()
            .find(|b| b["id"] == id)
            .ok_or("Неизвестный продукт")?;
        let mut normalized = a.clone();
        for field in [
            "version",
            "description",
            "notes",
            "checkedAt",
            "downloadMb",
            "diskMb",
        ] {
            let v = &a[field];
            if ["downloadMb", "diskMb"].contains(&field) {
                if !v.is_null() && !v.as_u64().is_some_and(|n| n <= 10_000_000) {
                    return Err("Недопустимый размер продукта".into());
                }
            } else if !v.as_str().is_some_and(|s| {
                s.len() <= if field == "notes" { 8000 } else { 1000 } && !s.contains('\0')
            }) {
                return Err("Недопустимое описание каталога".into());
            }
            normalized[field] = original[field].clone();
        }
        if a["version"] != original["version"]
            && !a["version"].as_str().is_some_and(|s| {
                !s.is_empty()
                    && s.len() <= 40
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b".-+_".contains(&b))
            })
        {
            return Err("Неверная версия продукта".into());
        }
        if normalized != *original {
            return Err("Каталог пытается изменить источники, операции или адаптеры. Это разрешается только новой сборкой AppDock.".into());
        }
    }
    Ok(p)
}
fn read_revision(data: &Path) -> u64 {
    std::fs::read(data.join("catalog-status.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v["revision"].as_u64())
        .unwrap_or(0)
}
pub fn initialize(data: &Path) -> Option<String> {
    if !data.join("catalog-current.json").exists() && !data.join("catalog-previous.json").exists() {
        if read_revision(data) != 0 {
            let _ = managed::json(
                &data.join("catalog-status.json"),
                &json!({"revision":0,"checkedAt":status(data)["checkedAt"]}),
            );
        }
        return None;
    }
    let key = match key() {
        Ok(k) => k,
        Err(e) => {
            let _ = managed::json(
                &data.join("catalog-status.json"),
                &json!({"revision":0,"checkedAt":status(data)["checkedAt"]}),
            );
            return Some(e);
        }
    };
    recover(data, &key)
}
fn recover(data: &Path, key: &[u8; 32]) -> Option<String> {
    for file in ["catalog-current.json", "catalog-previous.json"] {
        if let Ok(raw) = managed::read(&data.join(file), 4_000_000) {
            if let Ok(p) = validate(&raw, key) {
                catalog::activate(p.apps);
                let mut status = status(data);
                status["revision"] = json!(p.revision);
                let _ = managed::json(
                    &data.join("catalog-status.json"),
                    &json!({"revision":p.revision,"checkedAt":status["checkedAt"]}),
                );
                if file.ends_with("previous.json") {
                    let _ = managed::atomic(&data.join("catalog-current.json"), &raw);
                    return Some(
                        "Повреждённый каталог заменён последней проверенной версией".into(),
                    );
                }
                return None;
            }
        }
    }
    catalog::activate(catalog::bundled());
    let _ = managed::json(
        &data.join("catalog-status.json"),
        &json!({"revision":0,"checkedAt":null}),
    );
    Some("Оба сохранённых каталога повреждены; используется встроенный каталог".into())
}
pub fn status(data: &Path) -> Value {
    let v = std::fs::read(data.join("catalog-status.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .unwrap_or(json!({}));
    json!({"revision":read_revision(data),"checkedAt":v["checkedAt"],"configured":key().is_ok()&&option_env!("APPDOCK_CATALOG_URL").is_some(),"source":option_env!("APPDOCK_CATALOG_URL"),"limitations":"Подписанное обновление меняет версии и описания существующих продуктов. Новые источники и системные адаптеры требуют сборки приложения."})
}
pub fn check(data: &Path) -> Result<Value, String> {
    let key = key()?;
    let url = option_env!("APPDOCK_CATALOG_URL")
        .ok_or("Production-адрес каталога не настроен в этой сборке")?;
    if !url.starts_with("https://") {
        return Err("Для публикации требуется HTTPS".into());
    }
    managed::json(
        &data.join("catalog-status.json"),
        &json!({"checkedAt":now(),"revision":read_revision(data)}),
    )?;
    let mut r = managed::client()?
        .get(url)
        .timeout(std::time::Duration::from_secs(30))
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|e| e.to_string())?;
    use std::io::Read;
    let mut raw = vec![];
    r.by_ref()
        .take(4_000_001)
        .read_to_end(&mut raw)
        .map_err(|e| e.to_string())?;
    let p = validate(&raw, &key)?;
    if p.revision <= read_revision(data) {
        return Ok(json!({"available":false,"revision":read_revision(data)}));
    }
    managed::atomic(&data.join("catalog-candidate.json"), &raw)?;
    Ok(json!({"available":true,"revision":p.revision}))
}
pub fn apply(data: &Path) -> Result<Value, String> {
    let raw = managed::read(&data.join("catalog-candidate.json"), 4_000_000)?;
    let p = validate(&raw, &key()?)?;
    if p.revision <= read_revision(data) {
        return Err("Каталог устарел; выполните новую проверку".into());
    }
    if let Ok(old) = managed::read(&data.join("catalog-current.json"), 4_000_000) {
        if validate(&old, &key()?).is_ok() {
            managed::atomic(&data.join("catalog-previous.json"), &old)?;
        }
    }
    managed::atomic(&data.join("catalog-current.json"), &raw)?;
    managed::json(
        &data.join("catalog-status.json"),
        &json!({"revision":p.revision,"checkedAt":now()}),
    )?;
    catalog::activate(p.apps);
    Ok(status(data))
}
pub fn snapshot(data: &Path) -> Value {
    json!({"apps":catalog::apps(),"status":status(data)})
}
#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};
    fn signed(p: &Payload, k: &SigningKey) -> Vec<u8> {
        let b = serde_json::to_vec(p).unwrap();
        serde_json::to_vec(&Envelope {
            payload: STANDARD.encode(&b),
            signature: STANDARD.encode(k.sign(&b).to_bytes()),
        })
        .unwrap()
    }
    #[test]
    fn signed_fixture_rejects_tampering_and_new_commands() {
        // Ephemeral test key, never accepted by production key().
        let key = SigningKey::from_bytes(
            uuid::Uuid::new_v4()
                .as_bytes()
                .repeat(2)
                .as_slice()
                .try_into()
                .unwrap(),
        );
        let mut p = Payload {
            schema_version: 1,
            revision: 1,
            min_app_version: "0.2.2".into(),
            apps: catalog::bundled(),
        };
        let public = key.verifying_key().to_bytes();
        assert!(validate(&signed(&p, &key), &public).is_ok());
        p.apps[0]["install"]["command"] = json!("evil");
        assert!(validate(&signed(&p, &key), &public).is_err());
        p.apps = catalog::bundled();
        p.schema_version = 99;
        assert!(validate(&signed(&p, &key), &public).is_err());
        p.schema_version = 1;
        let raw = signed(&p, &key);
        let mut e: Envelope = serde_json::from_slice(&raw).unwrap();
        e.payload = STANDARD.encode(b"tampered");
        assert!(validate(&serde_json::to_vec(&e).unwrap(), &public).is_err());
    }
    #[test]
    fn corrupt_current_rolls_back_to_verified_previous_then_bundled() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let key = SigningKey::from_bytes(
            uuid::Uuid::new_v4()
                .as_bytes()
                .repeat(2)
                .as_slice()
                .try_into()
                .unwrap(),
        );
        let p = Payload {
            schema_version: 1,
            revision: 2,
            min_app_version: "0.2.2".into(),
            apps: catalog::bundled(),
        };
        let raw = signed(&p, &key);
        managed::atomic(&root.join("catalog-previous.json"), &raw).unwrap();
        managed::atomic(&root.join("catalog-current.json"), b"corrupt").unwrap();
        assert!(recover(&root, &key.verifying_key().to_bytes())
            .unwrap()
            .contains("последней"));
        assert_eq!(
            std::fs::read(root.join("catalog-current.json")).unwrap(),
            raw
        );
        assert_eq!(read_revision(&root), 2);
        managed::atomic(&root.join("catalog-current.json"), b"bad").unwrap();
        managed::atomic(&root.join("catalog-previous.json"), b"bad").unwrap();
        assert!(recover(&root, &key.verifying_key().to_bytes())
            .unwrap()
            .contains("встроенный"));
        assert_eq!(read_revision(&root), 0);
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn publication_tool_signatures_are_accepted_by_the_core() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir(&root).unwrap();
        let payload = Payload {
            schema_version: 1,
            revision: 7,
            min_app_version: "0.2.2".into(),
            apps: catalog::bundled(),
        };
        managed::json(&root.join("payload.json"), &payload).unwrap();
        let script =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/sign-catalog.mjs");
        let js="const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto'),{execFileSync}=require('node:child_process');const [root,script]=process.argv.slice(1);const keys=c.generateKeyPairSync('ed25519');const key=p.join(root,'ephemeral.pem');fs.writeFileSync(key,keys.privateKey.export({type:'pkcs8',format:'pem'}));fs.writeFileSync(p.join(root,'public.txt'),keys.publicKey.export({type:'spki',format:'der'}).subarray(-32).toString('base64'));try{execFileSync(process.execPath,[script,p.join(root,'payload.json'),p.join(root,'signed.json')],{env:{...process.env,APPDOCK_CATALOG_SIGNING_KEY:key}});}finally{fs.unlinkSync(key);}";
        let output = crate::system::bounded_output(
            crate::system::command("node")
                .arg("-e")
                .arg(js)
                .arg(&root)
                .arg(script),
            20,
        )
        .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let public: [u8; 32] = STANDARD
            .decode(std::fs::read_to_string(root.join("public.txt")).unwrap())
            .unwrap()
            .try_into()
            .unwrap();
        assert_eq!(
            validate(
                &managed::read(&root.join("signed.json"), 4_000_000).unwrap(),
                &public
            )
            .unwrap()
            .revision,
            7
        );
        assert!(!root.join("ephemeral.pem").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
