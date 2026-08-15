use actix_web::http::header::LOCATION;
use actix_web::{HttpResponse, Result, error, web};
use serde::{Deserialize, Serialize};

use crate::state::AppState;
use crate::timestamps;

const MIN_PASSWORD_BYTES: usize = 8;
const MAX_PASSWORD_BYTES: usize = 128;

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
pub(crate) struct AcceptInvitationForm {
    password: String,
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

pub async fn accept(
    state: web::Data<AppState>,
    path: web::Path<String>,
    form: web::Form<AcceptInvitationForm>,
) -> Result<HttpResponse> {
    let token = path.into_inner();

    if !is_valid_token(&token) {
        return Ok(redirect("/login"));
    }

    let password = form.password.trim();

    if !(MIN_PASSWORD_BYTES..=MAX_PASSWORD_BYTES).contains(&password.len()) {
        return Ok(redirect(format!("/invite/{token}?error=weak-password")));
    }

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
        return Ok(redirect(format!("/invite/{token}?error=unavailable")));
    }

    state.db.release_request_connection().await;
    let password_hash =
        state.passwords.hash(password).await.map_err(|_| {
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
                INSERT INTO users (id, username, password_hash, role, status)
                SELECT
                  gen_random_uuid()::text,
                  invited_username,
                  $2,
                  role,
                  'active'
                FROM accepted_invitation
                RETURNING username
            ",
            &[&token, &password_hash],
        )
        .await
        .map_err(error::ErrorInternalServerError)?;

    let Some(accepted_user) = accepted_user else {
        return Ok(redirect(format!("/invite/{token}?error=unavailable")));
    };
    let username: String = accepted_user.get("username");

    Ok(redirect(format!("/login?username={username}")))
}

fn is_valid_token(token: &str) -> bool {
    (32..=128).contains(&token.len())
        && token
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
}

fn redirect(location: impl AsRef<str>) -> HttpResponse {
    HttpResponse::SeeOther()
        .insert_header((LOCATION, location.as_ref().to_owned()))
        .finish()
}
