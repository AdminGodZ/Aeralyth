mod admin;
mod auth;
mod files;
mod health;
mod invitations;
mod profile;
mod repositories;
mod share_links;
mod vault;

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
                .route("/invitations/{token}", web::get().to(invitations::details))
                .route(
                    "/invitations/{token}/accept",
                    web::post().to(invitations::accept),
                )
                .route("/share-links", web::get().to(share_links::list_owned))
                .route("/share-links", web::post().to(share_links::create))
                .route(
                    "/share-links/{id}/rotate",
                    web::post().to(share_links::rotate),
                )
                .route("/share-links/{id}", web::delete().to(share_links::revoke))
                .route(
                    "/share-links/access/{token}",
                    web::get().to(share_links::access),
                )
                .route(
                    "/share-links/access/{token}/files/{file_id}/download",
                    web::get().to(share_links::download),
                )
                .route(
                    "/share-links/access/{token}/files/{file_id}",
                    web::delete().to(share_links::remove_entry),
                )
                .route("/repositories", web::get().to(repositories::list))
                .route("/repositories", web::post().to(repositories::create))
                .route("/repositories/{id}", web::patch().to(repositories::update))
                .route(
                    "/repositories/{id}/archive-manifest",
                    web::get().to(repositories::archive_manifest),
                )
                .route("/repositories/{id}", web::get().to(repositories::detail))
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
                    "/files/uploads/{id}/status",
                    web::get().to(files::upload_status),
                )
                .route("/files/uploads/{id}", web::delete().to(files::abort_upload))
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
                .route("/storage", web::get().to(files::storage))
                .service(
                    web::scope("/vault")
                        .route("", web::get().to(vault::status))
                        .route("/setup", web::post().to(vault::setup))
                        .route("/unlock-material", web::get().to(vault::unlock_material))
                        .route("/rewrap", web::post().to(vault::rewrap))
                        .route("/migrations/claim", web::post().to(vault::claim_migration))
                        .route("/identities/{username}", web::get().to(vault::identity))
                        .route(
                            "/identities/{user_id}/trust",
                            web::post().to(vault::trust_identity),
                        )
                        .route("/uploads", web::post().to(vault::init_upload))
                        .route(
                            "/uploads/{id}/content-url",
                            web::post().to(vault::presign_content),
                        )
                        .route(
                            "/uploads/{id}/parts/{part_number}",
                            web::post().to(vault::presign_part),
                        )
                        .route(
                            "/uploads/{id}/publish",
                            web::post().to(vault::publish_upload),
                        )
                        .route("/uploads/{id}", web::delete().to(vault::abort_upload))
                        .route("/nodes/{id}/records", web::post().to(vault::publish_record))
                        .route(
                            "/nodes/{id}/download-plan",
                            web::get().to(vault::download_plan),
                        )
                        .route("/nodes/{id}/share-plan", web::get().to(vault::share_plan))
                        .route(
                            "/nodes/{id}/share-contexts",
                            web::get().to(vault::share_contexts),
                        )
                        .route("/shares", web::get().to(vault::list_shares))
                        .route("/shares", web::post().to(vault::create_share))
                        .route(
                            "/shares/{id}/epochs",
                            web::post().to(vault::begin_epoch_rotation),
                        )
                        .route(
                            "/shares/{id}/epochs/pending",
                            web::get().to(vault::pending_epoch_rotation),
                        )
                        .route(
                            "/shares/{id}/epochs/{epoch}/publish",
                            web::post().to(vault::publish_epoch_rotation),
                        )
                        .route(
                            "/shares/{id}/epochs/{epoch}/abort",
                            web::post().to(vault::abort_epoch_rotation),
                        ),
                ),
        );
}
