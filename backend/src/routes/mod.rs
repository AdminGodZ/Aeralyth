mod admin;
mod auth;
mod files;
mod health;
mod invitations;
mod profile;

use actix_web::web;

pub fn configure(config: &mut web::ServiceConfig) {
    config
        .route("/health", web::get().to(health::health))
        .service(
            web::scope("/api")
                .route("/health", web::get().to(health::health))
                .service(
                    web::scope("/auth")
                        .route("/login", web::post().to(auth::login))
                        .route("/logout", web::post().to(auth::logout))
                        .route("/csrf", web::get().to(auth::csrf))
                        .route("/me", web::get().to(auth::me)),
                )
                .service(
                    web::scope("/profile")
                        .route("", web::post().to(profile::update))
                        .route("/avatar", web::get().to(profile::avatar)),
                )
                .service(
                    web::scope("/admin")
                        .route("/me", web::get().to(admin::me))
                        .route("/users", web::get().to(admin::users))
                        .route("/users", web::post().to(admin::create_user))
                        .route("/users/{id}", web::post().to(admin::update_user))
                        .route("/users/{id}/avatar", web::get().to(admin::user_avatar))
                        .route("/users/{id}/delete", web::post().to(admin::delete_user))
                        .route("/invitations", web::post().to(admin::create_invitation))
                        .route(
                            "/invitations/{id}/rotate",
                            web::post().to(admin::rotate_invitation),
                        )
                        .route(
                            "/invitations/{id}/revoke",
                            web::post().to(admin::revoke_invitation),
                        )
                        .route("/users/{id}/role", web::post().to(admin::update_user_role))
                        .route(
                            "/users/{id}/status",
                            web::post().to(admin::update_user_status),
                        ),
                )
                .route(
                    "/invitations/{token}",
                    web::get().to(invitations::details),
                )
                .route(
                    "/invitations/{token}/accept",
                    web::post().to(invitations::accept),
                )
                .route("/files", web::get().to(files::list_files))
                .route("/files/uploads", web::post().to(files::init_upload))
                .route(
                    "/files/uploads/{id}/content",
                    web::put().to(files::upload_content),
                )
                .route(
                    "/files/uploads/{id}/content-url",
                    web::post().to(files::presign_upload_content),
                )
                .route(
                    "/files/uploads/{id}/parts/{part_number}",
                    web::post().to(files::presign_upload_part),
                )
                .route(
                    "/files/uploads/{id}/complete",
                    web::post().to(files::complete_upload),
                )
                .route(
                    "/files/uploads/{id}",
                    web::delete().to(files::abort_upload),
                )
                .route("/files/{id}/download", web::get().to(files::download))
                .route("/files/{id}/share", web::post().to(files::share))
                .route("/files/{id}/unshare", web::post().to(files::unshare))
                .route("/files/{id}/trash", web::post().to(files::trash))
                .route("/files/{id}/restore", web::post().to(files::restore))
                .route(
                    "/files/{id}/favorite",
                    web::post().to(files::toggle_favorite),
                )
                .route("/files/{id}/delete", web::post().to(files::delete))
                .route("/storage", web::get().to(files::storage)),
        );
}
