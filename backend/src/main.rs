mod config;
mod routes;

use actix_web::{middleware::Logger, web, App, HttpServer};

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    dotenvy::dotenv().ok();
    env_logger::init_from_env(env_logger::Env::new().default_filter_or("info"));

    let config = config::Config::from_env();
    let bind_addr = config.bind_addr();

    log::info!("starting Aeralyth API on {bind_addr}");

    HttpServer::new(move || {
        App::new()
            .app_data(web::Data::new(config.clone()))
            .wrap(Logger::default())
            .configure(routes::configure)
    })
    .bind(&bind_addr)?
    .run()
    .await
}
