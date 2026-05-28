mod auth;
mod files;
mod health;

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
                        .route("/logout", web::get().to(auth::logout))
                        .route("/logout", web::post().to(auth::logout))
                        .route("/me", web::get().to(auth::me)),
                )
                .route("/files", web::get().to(files::list_files)),
        );
}
