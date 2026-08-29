use actix_web::{HttpResponse, Result, error, web};
use serde::{Deserialize, Serialize};

use crate::auth::parse_json_body;
use crate::state::AppState;
use crate::timestamps;

use super::auth::{decode_fixed_auth_value, valid_credential};

const ACCEPT_JSON_LIMIT: usize = 2 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InvitationDetails {
    username: String,
    role: String,
    expires_at: String,
}

#[derive(Serialize)]
struct InvitationDetailsResponse {
    invitation: InvitationDetails,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AcceptOnePasswordRequest {
    credential: String,
    salt: String,
}

#[derive(Serialize)]
struct AcceptedInvitationResponse {
    username: String,
}

pub async fn details(state: web::Data<AppState>, path: web::Path<String>) -> Result<HttpResponse> {
    let token = path.into_inner();

    if !is_valid_token(&token) {
        return Ok(HttpResponse::NotFound().finish());
    }

    let invitation = state
        .db
        .query_opt(
            "
                SELECT
                  invited_username,
                  role,
                  expires_at
                FROM invitations
                WHERE token_hash = encode(digest($1::text, 'sha256'), 'hex')
                  AND status = 'pending'
                  AND expires_at > now()
                LIMIT 1
            ",
            &[&token],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let Some(invitation) = invitation else {
        return Ok(HttpResponse::Gone().finish());
    };

    Ok(HttpResponse::Ok().json(InvitationDetailsResponse {
        invitation: InvitationDetails {
            username: invitation.get("invited_username"),
            role: invitation.get("role"),
            expires_at: timestamps::api(invitation.get("expires_at")),
        },
    }))
}

pub async fn accept_one_password(
    state: web::Data<AppState>,
    request: actix_web::HttpRequest,
    path: web::Path<String>,
    body: web::Payload,
) -> Result<HttpResponse> {
    let token = path.into_inner();
    if !is_valid_token(&token) {
        return Ok(HttpResponse::NotFound().finish());
    }
    let body =
        parse_json_body::<AcceptOnePasswordRequest>(&request, body, ACCEPT_JSON_LIMIT).await?;
    if !valid_credential(&body.credential) {
        return Ok(HttpResponse::BadRequest().body("authentication credential is invalid"));
    }
    let salt = decode_fixed_auth_value::<16>(&body.salt, "authentication salt")?;
    let invitation_available = state
        .db
        .query_opt(
            "
                SELECT 1
                FROM invitations AS target
                WHERE target.token_hash = encode(digest($1::text, 'sha256'), 'hex')
                  AND target.status = 'pending'
                  AND target.expires_at > now()
                  AND NOT EXISTS (
                    SELECT 1
                    FROM users
                    WHERE lower(username) = lower(target.invited_username)
                  )
                LIMIT 1
            ",
            &[&token],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    if invitation_available.is_none() {
        return Ok(HttpResponse::Conflict().body("invitation is unavailable"));
    }
    state.db.release_request_connection().await;
    let password_hash =
        state.passwords.hash(&body.credential).await.map_err(|_| {
            error::ErrorServiceUnavailable("password service temporarily unavailable")
        })?;
    let accepted_user = state
        .db
        .query_opt(
            "
                WITH accepted_invitation AS (
                  UPDATE invitations AS target
                  SET status = 'accepted',
                      accepted_at = now()
                  WHERE target.token_hash = encode(digest($1::text, 'sha256'), 'hex')
                    AND target.status = 'pending'
                    AND target.expires_at > now()
                    AND NOT EXISTS (
                      SELECT 1
                      FROM users
                      WHERE lower(username) = lower(target.invited_username)
                    )
                  RETURNING invited_username, role
                )
                INSERT INTO users (
                  id, username, password_hash, role, status,
                  auth_version, auth_kdf_salt
                )
                SELECT
                  gen_random_uuid()::text,
                  invited_username,
                  $2,
                  role,
                  'active',
                  1,
                  $3
                FROM accepted_invitation
                RETURNING username
            ",
            &[&token, &password_hash, &salt.as_slice()],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;
    let Some(accepted_user) = accepted_user else {
        return Ok(HttpResponse::Conflict().body("invitation is unavailable"));
    };
    Ok(HttpResponse::Created().json(AcceptedInvitationResponse {
        username: accepted_user.get("username"),
    }))
}

fn is_valid_token(token: &str) -> bool {
    (32..=128).contains(&token.len())
        && token
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}
