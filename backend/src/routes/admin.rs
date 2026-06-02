use actix_web::{HttpRequest, HttpResponse, Result, web};
use serde::Serialize;

use crate::auth::{AuthUser, require_admin};
use crate::state::AppState;

#[derive(Serialize)]
struct AdminSessionResponse {
    user: AuthUser,
}

pub async fn me(state: web::Data<AppState>, request: HttpRequest) -> Result<HttpResponse> {
    let user = require_admin(&state, &request).await?;

    Ok(HttpResponse::Ok().json(AdminSessionResponse { user }))
}
