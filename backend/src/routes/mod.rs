mod health;

use actix_web::web;

pub fn configure(config: &mut web::ServiceConfig) {
    config
        .route("/health", web::get().to(health::health))
        .service(web::scope("/api").route("/health", web::get().to(health::health)));
}
