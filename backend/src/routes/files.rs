use actix_web::{HttpRequest, HttpResponse, Result, web};
use serde::Serialize;

use crate::auth::require_user;
use crate::state::AppState;

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

pub async fn list_files(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let _user = require_user(&state, &request).await?;

    Ok(HttpResponse::Ok().json(FilesResponse {
        path: "/",
        entries: Vec::new(),
    }))
}
