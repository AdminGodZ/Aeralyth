use actix_web::HttpResponse;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FilesResponse {
    path: &'static str,
    entries: Vec<FileEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    id: String,
    name: String,
    kind: String,
    size_bytes: u64,
    modified_at: String,
}

pub async fn list_files() -> HttpResponse {
    HttpResponse::Ok().json(FilesResponse {
        path: "/",
        entries: Vec::new(),
    })
}
